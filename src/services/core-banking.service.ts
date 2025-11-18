import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { eventBus } from '../core';

// Account types
export type BankAccountType = 'checking' | 'savings' | 'money_market' | 'cd' | 'trust' | 'custodial';
export type AccountStatus = 'active' | 'frozen' | 'dormant' | 'closed';
export type TransferType = 'internal' | 'ach' | 'wire_domestic' | 'wire_international' | 'check' | 'rtp';
export type TransferStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'returned';

// Core banking account
export interface BankAccount {
  id: string;
  merchantId: string;
  customerId?: string;
  accountType: BankAccountType;
  accountNumber: string;
  routingNumber: string;
  name: string;
  currency: string;
  balance: number;
  availableBalance: number;
  pendingBalance: number;
  interestRate?: number;
  interestAccrued?: number;
  overdraftLimit?: number;
  overdraftUsed?: number;
  minimumBalance?: number;
  status: AccountStatus;
  jointOwners?: string[];
  beneficiaries?: Array<{ name: string; percentage: number }>;
  metadata?: Record<string, any>;
  openedAt: Date;
  lastActivityAt: Date;
  createdAt: Date;
}

// Bank transfer
export interface BankTransfer {
  id: string;
  merchantId: string;
  fromAccountId?: string;
  toAccountId?: string;
  transferType: TransferType;
  amount: number;
  fee: number;
  currency: string;
  status: TransferStatus;
  // External account details
  externalAccount?: {
    accountNumber: string;
    routingNumber: string;
    accountName: string;
    bankName?: string;
    accountType?: string;
    // International
    iban?: string;
    swiftBic?: string;
    bankAddress?: string;
    country?: string;
  };
  // ACH specific
  achDetails?: {
    secCode: 'PPD' | 'CCD' | 'WEB' | 'TEL';
    companyName: string;
    companyId: string;
    entryDescription: string;
  };
  // Wire specific
  wireDetails?: {
    beneficiaryName: string;
    beneficiaryAddress?: string;
    intermediaryBank?: string;
    purpose?: string;
    reference?: string;
  };
  memo?: string;
  scheduledAt?: Date;
  processedAt?: Date;
  settledAt?: Date;
  returnReason?: string;
  traceNumber?: string;
  createdAt: Date;
}

// Account statement
export interface AccountStatement {
  id: string;
  accountId: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: number;
  closingBalance: number;
  totalCredits: number;
  totalDebits: number;
  interestEarned: number;
  feesCharged: number;
  transactionCount: number;
  generatedAt: Date;
}

// Ledger entry
export interface LedgerEntry {
  id: string;
  accountId: string;
  transferId?: string;
  entryType: 'credit' | 'debit';
  amount: number;
  balance: number;
  description: string;
  reference?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  postedAt: Date;
}

export class CoreBankingService {
  // ============================================
  // ACCOUNT MANAGEMENT
  // ============================================

  async createAccount(
    merchantId: string,
    input: {
      customerId?: string;
      accountType: BankAccountType;
      name: string;
      currency: string;
      interestRate?: number;
      overdraftLimit?: number;
      minimumBalance?: number;
      jointOwners?: string[];
      beneficiaries?: Array<{ name: string; percentage: number }>;
      metadata?: Record<string, any>;
    }
  ): Promise<BankAccount> {
    const id = uuidv4();
    const accountNumber = this.generateAccountNumber();
    const routingNumber = process.env.BANK_ROUTING_NUMBER || '021000021';

    const result = await query<any>(
      `INSERT INTO bank_accounts (
        id, merchant_id, customer_id, account_type, account_number, routing_number,
        name, currency, balance, available_balance, pending_balance,
        interest_rate, overdraft_limit, minimum_balance, status,
        joint_owners, beneficiaries, metadata, opened_at, last_activity_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, $9, $10, $11, 'active', $12, $13, $14, NOW(), NOW(), NOW())
      RETURNING *`,
      [
        id, merchantId, input.customerId, input.accountType, accountNumber, routingNumber,
        input.name, input.currency, input.interestRate || 0, input.overdraftLimit || 0,
        input.minimumBalance || 0,
        input.jointOwners ? JSON.stringify(input.jointOwners) : null,
        input.beneficiaries ? JSON.stringify(input.beneficiaries) : null,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('banking.account.opened', {
      merchantId,
      data: { accountId: id, accountType: input.accountType },
    });

    logger.info('Bank account created', { id, accountType: input.accountType });
    return this.mapBankAccount(result.rows[0]);
  }

  async getAccount(accountId: string, merchantId?: string): Promise<BankAccount> {
    let queryText = 'SELECT * FROM bank_accounts WHERE id = $1';
    const params: any[] = [accountId];

    if (merchantId) {
      queryText += ' AND merchant_id = $2';
      params.push(merchantId);
    }

    const result = await query<any>(queryText, params);
    if (result.rows.length === 0) {
      throw new NotFoundError('Bank Account');
    }

    return this.mapBankAccount(result.rows[0]);
  }

  async getAccounts(merchantId: string, customerId?: string): Promise<BankAccount[]> {
    let queryText = 'SELECT * FROM bank_accounts WHERE merchant_id = $1 AND status != $2';
    const params: any[] = [merchantId, 'closed'];

    if (customerId) {
      queryText += ' AND customer_id = $3';
      params.push(customerId);
    }

    queryText += ' ORDER BY created_at DESC';
    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapBankAccount(row));
  }

  async updateAccountStatus(
    accountId: string,
    status: AccountStatus,
    reason?: string
  ): Promise<BankAccount> {
    const result = await query<any>(
      `UPDATE bank_accounts SET status = $1 WHERE id = $2 RETURNING *`,
      [status, accountId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Bank Account');
    }

    logger.info('Account status updated', { accountId, status, reason });
    return this.mapBankAccount(result.rows[0]);
  }

  // ============================================
  // TRANSFERS
  // ============================================

  // Internal transfer between accounts
  async internalTransfer(
    merchantId: string,
    input: {
      fromAccountId: string;
      toAccountId: string;
      amount: number;
      memo?: string;
    }
  ): Promise<BankTransfer> {
    // Validate accounts
    const [fromAccount, toAccount] = await Promise.all([
      this.getAccount(input.fromAccountId, merchantId),
      this.getAccount(input.toAccountId, merchantId),
    ]);

    if (fromAccount.currency !== toAccount.currency) {
      throw new ValidationError('Currency mismatch between accounts');
    }

    if (fromAccount.availableBalance < input.amount) {
      throw new ValidationError('Insufficient funds');
    }

    const id = uuidv4();
    const fee = 0; // Internal transfers are free

    // Create transfer record
    await query(
      `INSERT INTO bank_transfers (
        id, merchant_id, from_account_id, to_account_id, transfer_type,
        amount, fee, currency, status, memo, created_at
      ) VALUES ($1, $2, $3, $4, 'internal', $5, $6, $7, 'completed', $8, NOW())`,
      [id, merchantId, input.fromAccountId, input.toAccountId, input.amount, fee, fromAccount.currency, input.memo]
    );

    // Update balances
    await this.debitAccount(input.fromAccountId, input.amount, `Transfer to ${toAccount.name}`, id);
    await this.creditAccount(input.toAccountId, input.amount, `Transfer from ${fromAccount.name}`, id);

    return {
      id,
      merchantId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      transferType: 'internal',
      amount: input.amount,
      fee,
      currency: fromAccount.currency,
      status: 'completed',
      memo: input.memo,
      createdAt: new Date(),
    };
  }

  // ACH transfer
  async initiateACHTransfer(
    merchantId: string,
    input: {
      accountId: string;
      direction: 'credit' | 'debit';
      amount: number;
      externalAccount: {
        accountNumber: string;
        routingNumber: string;
        accountName: string;
        accountType: 'checking' | 'savings';
      };
      achDetails: {
        secCode: 'PPD' | 'CCD' | 'WEB' | 'TEL';
        companyName: string;
        companyId: string;
        entryDescription: string;
      };
      memo?: string;
      scheduledAt?: Date;
    }
  ): Promise<BankTransfer> {
    const account = await this.getAccount(input.accountId, merchantId);

    // For debits (pulling money), check external account
    // For credits (pushing money), check internal account balance
    if (input.direction === 'credit' && account.availableBalance < input.amount) {
      throw new ValidationError('Insufficient funds');
    }

    const id = uuidv4();
    const fee = 25; // $0.25 ACH fee
    const traceNumber = this.generateTraceNumber();

    await query(
      `INSERT INTO bank_transfers (
        id, merchant_id, from_account_id, to_account_id, transfer_type,
        amount, fee, currency, status, external_account, ach_details,
        memo, scheduled_at, trace_number, created_at
      ) VALUES ($1, $2, $3, $4, 'ach', $5, $6, $7, 'pending', $8, $9, $10, $11, $12, NOW())`,
      [
        id, merchantId,
        input.direction === 'credit' ? input.accountId : null,
        input.direction === 'debit' ? input.accountId : null,
        input.amount, fee, account.currency,
        JSON.stringify(input.externalAccount),
        JSON.stringify(input.achDetails),
        input.memo,
        input.scheduledAt || new Date(),
        traceNumber,
      ]
    );

    // Hold funds for credit transfers
    if (input.direction === 'credit') {
      await this.holdFunds(input.accountId, input.amount + fee);
    }

    await eventBus.emit('banking.ach.initiated', {
      merchantId,
      data: { transferId: id, amount: input.amount, direction: input.direction },
    });

    logger.info('ACH transfer initiated', { id, direction: input.direction, amount: input.amount });

    return {
      id,
      merchantId,
      fromAccountId: input.direction === 'credit' ? input.accountId : undefined,
      toAccountId: input.direction === 'debit' ? input.accountId : undefined,
      transferType: 'ach',
      amount: input.amount,
      fee,
      currency: account.currency,
      status: 'pending',
      externalAccount: input.externalAccount,
      achDetails: input.achDetails,
      memo: input.memo,
      traceNumber,
      createdAt: new Date(),
    };
  }

  // Wire transfer
  async initiateWireTransfer(
    merchantId: string,
    input: {
      accountId: string;
      amount: number;
      currency: string;
      international: boolean;
      wireDetails: {
        beneficiaryName: string;
        beneficiaryAddress?: string;
        beneficiaryAccount: string;
        beneficiaryBank: string;
        routingNumber?: string;
        swiftBic?: string;
        iban?: string;
        intermediaryBank?: string;
        purpose?: string;
        reference?: string;
      };
      memo?: string;
    }
  ): Promise<BankTransfer> {
    const account = await this.getAccount(input.accountId, merchantId);

    const fee = input.international ? 4500 : 2500; // $45 international, $25 domestic

    if (account.availableBalance < input.amount + fee) {
      throw new ValidationError('Insufficient funds including wire fee');
    }

    const id = uuidv4();

    await query(
      `INSERT INTO bank_transfers (
        id, merchant_id, from_account_id, transfer_type,
        amount, fee, currency, status, external_account, wire_details, memo, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8, $9, $10, NOW())`,
      [
        id, merchantId, input.accountId,
        input.international ? 'wire_international' : 'wire_domestic',
        input.amount, fee, input.currency,
        JSON.stringify({
          accountNumber: input.wireDetails.beneficiaryAccount,
          routingNumber: input.wireDetails.routingNumber,
          accountName: input.wireDetails.beneficiaryName,
          bankName: input.wireDetails.beneficiaryBank,
          iban: input.wireDetails.iban,
          swiftBic: input.wireDetails.swiftBic,
        }),
        JSON.stringify(input.wireDetails),
        input.memo,
      ]
    );

    // Debit account immediately for wires
    await this.debitAccount(input.accountId, input.amount + fee, `Wire to ${input.wireDetails.beneficiaryName}`, id);

    await eventBus.emit('banking.wire.initiated', {
      merchantId,
      data: { transferId: id, amount: input.amount, international: input.international },
    });

    logger.info('Wire transfer initiated', { id, amount: input.amount, international: input.international });

    return {
      id,
      merchantId,
      fromAccountId: input.accountId,
      transferType: input.international ? 'wire_international' : 'wire_domestic',
      amount: input.amount,
      fee,
      currency: input.currency,
      status: 'processing',
      wireDetails: input.wireDetails,
      memo: input.memo,
      createdAt: new Date(),
    };
  }

  // ============================================
  // LEDGER OPERATIONS
  // ============================================

  async creditAccount(
    accountId: string,
    amount: number,
    description: string,
    transferId?: string
  ): Promise<LedgerEntry> {
    // Update account balance
    const accountResult = await query<any>(
      `UPDATE bank_accounts
       SET balance = balance + $1,
           available_balance = available_balance + $1,
           last_activity_at = NOW()
       WHERE id = $2
       RETURNING balance`,
      [amount, accountId]
    );

    const newBalance = parseInt(accountResult.rows[0].balance);

    // Create ledger entry
    const entryId = uuidv4();
    await query(
      `INSERT INTO bank_ledger (
        id, account_id, transfer_id, entry_type, amount, balance, description, created_at, posted_at
      ) VALUES ($1, $2, $3, 'credit', $4, $5, $6, NOW(), NOW())`,
      [entryId, accountId, transferId, amount, newBalance, description]
    );

    return {
      id: entryId,
      accountId,
      transferId,
      entryType: 'credit',
      amount,
      balance: newBalance,
      description,
      createdAt: new Date(),
      postedAt: new Date(),
    };
  }

  async debitAccount(
    accountId: string,
    amount: number,
    description: string,
    transferId?: string
  ): Promise<LedgerEntry> {
    // Check available balance
    const account = await this.getAccount(accountId);
    const totalAvailable = account.availableBalance + (account.overdraftLimit || 0) - (account.overdraftUsed || 0);

    if (amount > totalAvailable) {
      throw new ValidationError('Insufficient funds');
    }

    // Update account balance
    const accountResult = await query<any>(
      `UPDATE bank_accounts
       SET balance = balance - $1,
           available_balance = available_balance - $1,
           last_activity_at = NOW()
       WHERE id = $2
       RETURNING balance`,
      [amount, accountId]
    );

    const newBalance = parseInt(accountResult.rows[0].balance);

    // Create ledger entry
    const entryId = uuidv4();
    await query(
      `INSERT INTO bank_ledger (
        id, account_id, transfer_id, entry_type, amount, balance, description, created_at, posted_at
      ) VALUES ($1, $2, $3, 'debit', $4, $5, $6, NOW(), NOW())`,
      [entryId, accountId, transferId, amount, newBalance, description]
    );

    return {
      id: entryId,
      accountId,
      transferId,
      entryType: 'debit',
      amount,
      balance: newBalance,
      description,
      createdAt: new Date(),
      postedAt: new Date(),
    };
  }

  async holdFunds(accountId: string, amount: number): Promise<void> {
    await query(
      `UPDATE bank_accounts
       SET available_balance = available_balance - $1,
           pending_balance = pending_balance + $1
       WHERE id = $2`,
      [amount, accountId]
    );
  }

  async releaseFunds(accountId: string, amount: number): Promise<void> {
    await query(
      `UPDATE bank_accounts
       SET available_balance = available_balance + $1,
           pending_balance = pending_balance - $1
       WHERE id = $2`,
      [amount, accountId]
    );
  }

  // ============================================
  // INTEREST & STATEMENTS
  // ============================================

  async accrueInterest(accountId: string): Promise<number> {
    const account = await this.getAccount(accountId);

    if (!account.interestRate || account.interestRate === 0) {
      return 0;
    }

    // Daily interest = balance * (annual rate / 365)
    const dailyRate = account.interestRate / 100 / 365;
    const interest = Math.round(account.balance * dailyRate);

    if (interest > 0) {
      await query(
        `UPDATE bank_accounts
         SET interest_accrued = COALESCE(interest_accrued, 0) + $1
         WHERE id = $2`,
        [interest, accountId]
      );
    }

    return interest;
  }

  async payInterest(accountId: string): Promise<number> {
    const account = await this.getAccount(accountId);
    const interest = account.interestAccrued || 0;

    if (interest === 0) return 0;

    // Credit interest to account
    await this.creditAccount(accountId, interest, 'Interest payment');

    // Reset accrued interest
    await query(
      `UPDATE bank_accounts SET interest_accrued = 0 WHERE id = $1`,
      [accountId]
    );

    return interest;
  }

  async generateStatement(
    accountId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<AccountStatement> {
    // Get opening balance
    const openingResult = await query<any>(
      `SELECT balance FROM bank_ledger
       WHERE account_id = $1 AND posted_at < $2
       ORDER BY posted_at DESC LIMIT 1`,
      [accountId, periodStart]
    );
    const openingBalance = openingResult.rows[0]?.balance || 0;

    // Get transactions in period
    const txResult = await query<any>(
      `SELECT
        SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) as total_credits,
        SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END) as total_debits,
        COUNT(*) as transaction_count
       FROM bank_ledger
       WHERE account_id = $1 AND posted_at >= $2 AND posted_at <= $3`,
      [accountId, periodStart, periodEnd]
    );

    const totalCredits = parseInt(txResult.rows[0].total_credits || 0);
    const totalDebits = parseInt(txResult.rows[0].total_debits || 0);
    const closingBalance = openingBalance + totalCredits - totalDebits;

    const id = uuidv4();
    await query(
      `INSERT INTO account_statements (
        id, account_id, period_start, period_end, opening_balance, closing_balance,
        total_credits, total_debits, interest_earned, fees_charged, transaction_count, generated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $9, NOW())`,
      [
        id, accountId, periodStart, periodEnd, openingBalance, closingBalance,
        totalCredits, totalDebits, txResult.rows[0].transaction_count,
      ]
    );

    return {
      id,
      accountId,
      periodStart,
      periodEnd,
      openingBalance,
      closingBalance,
      totalCredits,
      totalDebits,
      interestEarned: 0,
      feesCharged: 0,
      transactionCount: parseInt(txResult.rows[0].transaction_count),
      generatedAt: new Date(),
    };
  }

  // Get transaction history
  async getTransactionHistory(
    accountId: string,
    options: { limit?: number; offset?: number; startDate?: Date; endDate?: Date }
  ): Promise<LedgerEntry[]> {
    let queryText = 'SELECT * FROM bank_ledger WHERE account_id = $1';
    const params: any[] = [accountId];
    let paramCount = 2;

    if (options.startDate) {
      queryText += ` AND posted_at >= $${paramCount++}`;
      params.push(options.startDate);
    }

    if (options.endDate) {
      queryText += ` AND posted_at <= $${paramCount++}`;
      params.push(options.endDate);
    }

    queryText += ` ORDER BY posted_at DESC LIMIT $${paramCount++} OFFSET $${paramCount}`;
    params.push(options.limit || 50, options.offset || 0);

    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapLedgerEntry(row));
  }

  // ============================================
  // HELPERS
  // ============================================

  private generateAccountNumber(): string {
    return Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('');
  }

  private generateTraceNumber(): string {
    return `${Date.now()}${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
  }

  private mapBankAccount(row: any): BankAccount {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      accountType: row.account_type,
      accountNumber: row.account_number,
      routingNumber: row.routing_number,
      name: row.name,
      currency: row.currency,
      balance: parseInt(row.balance),
      availableBalance: parseInt(row.available_balance),
      pendingBalance: parseInt(row.pending_balance),
      interestRate: row.interest_rate ? parseFloat(row.interest_rate) : undefined,
      interestAccrued: row.interest_accrued ? parseInt(row.interest_accrued) : undefined,
      overdraftLimit: row.overdraft_limit ? parseInt(row.overdraft_limit) : undefined,
      overdraftUsed: row.overdraft_used ? parseInt(row.overdraft_used) : undefined,
      minimumBalance: row.minimum_balance ? parseInt(row.minimum_balance) : undefined,
      status: row.status,
      jointOwners: row.joint_owners,
      beneficiaries: row.beneficiaries,
      metadata: row.metadata,
      openedAt: row.opened_at,
      lastActivityAt: row.last_activity_at,
      createdAt: row.created_at,
    };
  }

  private mapLedgerEntry(row: any): LedgerEntry {
    return {
      id: row.id,
      accountId: row.account_id,
      transferId: row.transfer_id,
      entryType: row.entry_type,
      amount: parseInt(row.amount),
      balance: parseInt(row.balance),
      description: row.description,
      reference: row.reference,
      metadata: row.metadata,
      createdAt: row.created_at,
      postedAt: row.posted_at,
    };
  }
}

export const coreBankingService = new CoreBankingService();
