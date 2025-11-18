import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { RequireModule, PLATFORM_MODULES } from '../core/modules/module-system';
import { eventBus } from '../core';

// Types
export type AccountType = 'virtual' | 'multi_currency' | 'yield';
export type AccountStatus = 'active' | 'frozen' | 'closed';
export type CardStatus = 'active' | 'frozen' | 'cancelled';
export type CardType = 'debit' | 'virtual' | 'expense';

export interface VirtualAccount {
  id: string;
  merchantId: string;
  accountNumber: string;
  routingNumber?: string;
  iban?: string;
  swiftBic?: string;
  accountType: AccountType;
  currency: string;
  balance: number;
  availableBalance: number;
  status: AccountStatus;
  nickname?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface MultiCurrencyBalance {
  merchantId: string;
  currency: string;
  balance: number;
  availableBalance: number;
  lastUpdated: Date;
}

export interface YieldAccount {
  id: string;
  merchantId: string;
  currency: string;
  principal: number;
  accruedInterest: number;
  annualRate: number; // As percentage
  compoundingFrequency: 'daily' | 'monthly';
  status: AccountStatus;
  createdAt: Date;
  lastAccrualDate: Date;
}

export interface MerchantCard {
  id: string;
  merchantId: string;
  cardType: CardType;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  cardholderName: string;
  status: CardStatus;
  spendingLimit?: number;
  spentThisMonth: number;
  currency: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface FXRate {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  spread: number;
  effectiveRate: number;
  validUntil: Date;
}

export class BankingService {
  // ============================================
  // VIRTUAL ACCOUNTS
  // ============================================

  @RequireModule(PLATFORM_MODULES.VIRTUAL_ACCOUNTS)
  async createVirtualAccount(
    merchantId: string,
    input: {
      currency: string;
      nickname?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<VirtualAccount> {
    // Generate account numbers
    const accountNumber = this.generateAccountNumber();
    const routingNumber = '021000021'; // Example routing number
    const iban = input.currency === 'EUR' || input.currency === 'GBP'
      ? this.generateIBAN(input.currency)
      : undefined;

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO virtual_accounts (
        id, merchant_id, account_number, routing_number, iban,
        account_type, currency, balance, available_balance, status,
        nickname, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'virtual', $6, 0, 0, 'active', $7, $8, NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        accountNumber,
        routingNumber,
        iban,
        input.currency,
        input.nickname,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('banking.account.created', {
      merchantId,
      data: { accountId: id, currency: input.currency },
    });

    logger.info('Virtual account created', { id, merchantId, currency: input.currency });
    return this.mapVirtualAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.VIRTUAL_ACCOUNTS)
  async getVirtualAccounts(merchantId: string): Promise<VirtualAccount[]> {
    const result = await query<any>(
      `SELECT * FROM virtual_accounts WHERE merchant_id = $1 AND status != 'closed'
       ORDER BY created_at DESC`,
      [merchantId]
    );
    return result.rows.map(row => this.mapVirtualAccount(row));
  }

  @RequireModule(PLATFORM_MODULES.VIRTUAL_ACCOUNTS)
  async depositToVirtualAccount(
    accountId: string,
    amount: number,
    reference?: string
  ): Promise<VirtualAccount> {
    const result = await query<any>(
      `UPDATE virtual_accounts
       SET balance = balance + $1, available_balance = available_balance + $1
       WHERE id = $2
       RETURNING *`,
      [amount, accountId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Virtual Account');
    }

    const account = this.mapVirtualAccount(result.rows[0]);

    // Record transaction
    await query(
      `INSERT INTO account_transactions (
        id, account_id, type, amount, currency, reference, created_at
      ) VALUES ($1, $2, 'deposit', $3, $4, $5, NOW())`,
      [uuidv4(), accountId, amount, account.currency, reference]
    );

    return account;
  }

  // ============================================
  // MULTI-CURRENCY ACCOUNTS
  // ============================================

  @RequireModule(PLATFORM_MODULES.MULTI_CURRENCY)
  async getMultiCurrencyBalances(merchantId: string): Promise<MultiCurrencyBalance[]> {
    const result = await query<any>(
      `SELECT * FROM multi_currency_balances WHERE merchant_id = $1`,
      [merchantId]
    );
    return result.rows.map(row => ({
      merchantId: row.merchant_id,
      currency: row.currency,
      balance: parseInt(row.balance),
      availableBalance: parseInt(row.available_balance),
      lastUpdated: row.last_updated,
    }));
  }

  @RequireModule(PLATFORM_MODULES.MULTI_CURRENCY)
  async convertCurrency(
    merchantId: string,
    input: {
      fromCurrency: string;
      toCurrency: string;
      amount: number;
    }
  ): Promise<{
    convertedAmount: number;
    rate: FXRate;
    transactionId: string;
  }> {
    // Get FX rate
    const rate = await this.getFXRate(input.fromCurrency, input.toCurrency);
    const convertedAmount = Math.round(input.amount * rate.effectiveRate);

    // Check sufficient balance
    const balanceResult = await query<any>(
      `SELECT available_balance FROM multi_currency_balances
       WHERE merchant_id = $1 AND currency = $2`,
      [merchantId, input.fromCurrency]
    );

    if (balanceResult.rows.length === 0 || balanceResult.rows[0].available_balance < input.amount) {
      throw new ValidationError('Insufficient balance');
    }

    // Debit from currency
    await query(
      `UPDATE multi_currency_balances
       SET balance = balance - $1, available_balance = available_balance - $1, last_updated = NOW()
       WHERE merchant_id = $2 AND currency = $3`,
      [input.amount, merchantId, input.fromCurrency]
    );

    // Credit to currency
    await query(
      `INSERT INTO multi_currency_balances (merchant_id, currency, balance, available_balance, last_updated)
       VALUES ($1, $2, $3, $3, NOW())
       ON CONFLICT (merchant_id, currency)
       DO UPDATE SET balance = multi_currency_balances.balance + $3,
                     available_balance = multi_currency_balances.available_balance + $3,
                     last_updated = NOW()`,
      [merchantId, input.toCurrency, convertedAmount]
    );

    const transactionId = uuidv4();

    // Record conversion
    await query(
      `INSERT INTO fx_conversions (
        id, merchant_id, from_currency, to_currency, from_amount, to_amount,
        rate, spread, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        transactionId,
        merchantId,
        input.fromCurrency,
        input.toCurrency,
        input.amount,
        convertedAmount,
        rate.rate,
        rate.spread,
      ]
    );

    await eventBus.emit('banking.fx.converted', {
      merchantId,
      data: { transactionId, ...input, convertedAmount },
    });

    return { convertedAmount, rate, transactionId };
  }

  async getFXRate(fromCurrency: string, toCurrency: string): Promise<FXRate> {
    // In production, this would call an FX provider API
    // Mock rates for common pairs
    const rates: Record<string, number> = {
      'USD_EUR': 0.92,
      'USD_GBP': 0.79,
      'USD_CAD': 1.36,
      'USD_JPY': 149.50,
      'EUR_USD': 1.09,
      'EUR_GBP': 0.86,
      'GBP_USD': 1.27,
      'GBP_EUR': 1.16,
    };

    const key = `${fromCurrency}_${toCurrency}`;
    let rate = rates[key];

    if (!rate) {
      // Try inverse
      const inverseKey = `${toCurrency}_${fromCurrency}`;
      if (rates[inverseKey]) {
        rate = 1 / rates[inverseKey];
      } else if (fromCurrency === toCurrency) {
        rate = 1;
      } else {
        throw new ValidationError(`FX rate not available for ${fromCurrency} to ${toCurrency}`);
      }
    }

    const spread = 0.005; // 0.5% spread
    const effectiveRate = rate * (1 - spread);

    return {
      fromCurrency,
      toCurrency,
      rate,
      spread,
      effectiveRate,
      validUntil: new Date(Date.now() + 30000), // 30 seconds
    };
  }

  // ============================================
  // YIELD ACCOUNTS
  // ============================================

  @RequireModule(PLATFORM_MODULES.YIELD_ACCOUNTS)
  async createYieldAccount(
    merchantId: string,
    input: {
      currency: string;
      initialDeposit: number;
    }
  ): Promise<YieldAccount> {
    // Current APY rates (would come from treasury in production)
    const rates: Record<string, number> = {
      USD: 4.5,
      EUR: 3.0,
      GBP: 4.0,
    };

    const annualRate = rates[input.currency] || 2.0;

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO yield_accounts (
        id, merchant_id, currency, principal, accrued_interest,
        annual_rate, compounding_frequency, status, created_at, last_accrual_date
      ) VALUES ($1, $2, $3, $4, 0, $5, 'daily', 'active', NOW(), NOW())
      RETURNING *`,
      [id, merchantId, input.currency, input.initialDeposit, annualRate]
    );

    await eventBus.emit('banking.yield.created', {
      merchantId,
      data: { accountId: id, principal: input.initialDeposit },
    });

    return this.mapYieldAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.YIELD_ACCOUNTS)
  async getYieldAccounts(merchantId: string): Promise<YieldAccount[]> {
    const result = await query<any>(
      `SELECT * FROM yield_accounts WHERE merchant_id = $1 AND status = 'active'`,
      [merchantId]
    );
    return result.rows.map(row => this.mapYieldAccount(row));
  }

  @RequireModule(PLATFORM_MODULES.YIELD_ACCOUNTS)
  async accrueInterest(yieldAccountId: string): Promise<YieldAccount> {
    const result = await query<any>(
      `SELECT * FROM yield_accounts WHERE id = $1`,
      [yieldAccountId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Yield Account');
    }

    const account = this.mapYieldAccount(result.rows[0]);

    // Calculate days since last accrual
    const daysSinceAccrual = Math.floor(
      (Date.now() - account.lastAccrualDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceAccrual === 0) {
      return account;
    }

    // Daily compound interest: A = P(1 + r/n)^(nt)
    const totalBalance = account.principal + account.accruedInterest;
    const dailyRate = account.annualRate / 100 / 365;
    const newBalance = totalBalance * Math.pow(1 + dailyRate, daysSinceAccrual);
    const newInterest = Math.round(newBalance - account.principal);

    const updateResult = await query<any>(
      `UPDATE yield_accounts
       SET accrued_interest = $1, last_accrual_date = NOW()
       WHERE id = $2
       RETURNING *`,
      [newInterest, yieldAccountId]
    );

    return this.mapYieldAccount(updateResult.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.YIELD_ACCOUNTS)
  async withdrawFromYield(
    merchantId: string,
    yieldAccountId: string,
    amount: number
  ): Promise<{ account: YieldAccount; withdrawnAmount: number }> {
    // First accrue any pending interest
    const account = await this.accrueInterest(yieldAccountId);

    const totalBalance = account.principal + account.accruedInterest;
    if (amount > totalBalance) {
      throw new ValidationError('Insufficient balance');
    }

    // Withdraw from interest first, then principal
    let newInterest = account.accruedInterest;
    let newPrincipal = account.principal;

    if (amount <= newInterest) {
      newInterest -= amount;
    } else {
      const fromPrincipal = amount - newInterest;
      newInterest = 0;
      newPrincipal -= fromPrincipal;
    }

    const result = await query<any>(
      `UPDATE yield_accounts
       SET principal = $1, accrued_interest = $2
       WHERE id = $3
       RETURNING *`,
      [newPrincipal, newInterest, yieldAccountId]
    );

    // Add to merchant's regular balance
    await query(
      `UPDATE balances SET available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [amount, merchantId, account.currency]
    );

    return {
      account: this.mapYieldAccount(result.rows[0]),
      withdrawnAmount: amount,
    };
  }

  // ============================================
  // MERCHANT CARDS
  // ============================================

  @RequireModule(PLATFORM_MODULES.MERCHANT_CARDS)
  async issueMerchantCard(
    merchantId: string,
    input: {
      cardType: CardType;
      cardholderName: string;
      currency: string;
      spendingLimit?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<MerchantCard> {
    // Generate card details
    const cardNumber = this.generateCardNumber();
    const last4 = cardNumber.slice(-4);
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 3);

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO merchant_cards (
        id, merchant_id, card_type, card_number_encrypted, last4,
        expiry_month, expiry_year, cardholder_name, status,
        spending_limit, spent_this_month, currency, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, 0, $10, $11, NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        input.cardType,
        this.encryptCardNumber(cardNumber), // In production, use proper encryption
        last4,
        expiryDate.getMonth() + 1,
        expiryDate.getFullYear(),
        input.cardholderName,
        input.spendingLimit,
        input.currency,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('banking.card.issued', {
      merchantId,
      data: { cardId: id, cardType: input.cardType },
    });

    logger.info('Merchant card issued', { id, merchantId, cardType: input.cardType });
    return this.mapMerchantCard(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MERCHANT_CARDS)
  async getMerchantCards(merchantId: string): Promise<MerchantCard[]> {
    const result = await query<any>(
      `SELECT * FROM merchant_cards WHERE merchant_id = $1 AND status != 'cancelled'
       ORDER BY created_at DESC`,
      [merchantId]
    );
    return result.rows.map(row => this.mapMerchantCard(row));
  }

  @RequireModule(PLATFORM_MODULES.MERCHANT_CARDS)
  async updateCardStatus(
    merchantId: string,
    cardId: string,
    status: CardStatus
  ): Promise<MerchantCard> {
    const result = await query<any>(
      `UPDATE merchant_cards SET status = $1
       WHERE id = $2 AND merchant_id = $3
       RETURNING *`,
      [status, cardId, merchantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Merchant Card');
    }

    return this.mapMerchantCard(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MERCHANT_CARDS)
  async updateSpendingLimit(
    merchantId: string,
    cardId: string,
    limit: number
  ): Promise<MerchantCard> {
    const result = await query<any>(
      `UPDATE merchant_cards SET spending_limit = $1
       WHERE id = $2 AND merchant_id = $3
       RETURNING *`,
      [limit, cardId, merchantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Merchant Card');
    }

    return this.mapMerchantCard(result.rows[0]);
  }

  // ============================================
  // HELPERS
  // ============================================

  private generateAccountNumber(): string {
    // Generate a 10-digit account number
    return Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join('');
  }

  private generateIBAN(currency: string): string {
    // Generate mock IBAN
    const countryCode = currency === 'EUR' ? 'DE' : 'GB';
    const checkDigits = '89';
    const bankCode = '12345678';
    const accountNumber = this.generateAccountNumber();
    return `${countryCode}${checkDigits}${bankCode}${accountNumber}`;
  }

  private generateCardNumber(): string {
    // Generate a 16-digit card number (Visa-like)
    const prefix = '4';
    const rest = Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('');
    return prefix + rest;
  }

  private encryptCardNumber(cardNumber: string): string {
    // In production, use proper encryption (e.g., AES-256)
    return Buffer.from(cardNumber).toString('base64');
  }

  private mapVirtualAccount(row: any): VirtualAccount {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      accountNumber: row.account_number,
      routingNumber: row.routing_number,
      iban: row.iban,
      swiftBic: row.swift_bic,
      accountType: row.account_type,
      currency: row.currency,
      balance: parseInt(row.balance),
      availableBalance: parseInt(row.available_balance),
      status: row.status,
      nickname: row.nickname,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private mapYieldAccount(row: any): YieldAccount {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      currency: row.currency,
      principal: parseInt(row.principal),
      accruedInterest: parseInt(row.accrued_interest),
      annualRate: parseFloat(row.annual_rate),
      compoundingFrequency: row.compounding_frequency,
      status: row.status,
      createdAt: row.created_at,
      lastAccrualDate: row.last_accrual_date,
    };
  }

  private mapMerchantCard(row: any): MerchantCard {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      cardType: row.card_type,
      last4: row.last4,
      expiryMonth: parseInt(row.expiry_month),
      expiryYear: parseInt(row.expiry_year),
      cardholderName: row.cardholder_name,
      status: row.status,
      spendingLimit: row.spending_limit ? parseInt(row.spending_limit) : undefined,
      spentThisMonth: parseInt(row.spent_this_month),
      currency: row.currency,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }
}

export const bankingService = new BankingService();
