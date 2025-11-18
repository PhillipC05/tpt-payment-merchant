import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { RequireModule, PLATFORM_MODULES } from '../core/modules/module-system';
import { eventBus } from '../core';

// Types
export type IssuedCardType = 'virtual' | 'expense' | 'gift';
export type IssuedCardStatus = 'active' | 'frozen' | 'cancelled' | 'expired';

export interface IssuedCard {
  id: string;
  merchantId: string;
  cardType: IssuedCardType;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  cardholderName?: string;
  status: IssuedCardStatus;
  balance?: number; // For gift cards
  spendingLimit?: number;
  spentTotal: number;
  currency: string;
  allowedCategories?: string[];
  blockedCategories?: string[];
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface CardTransaction {
  id: string;
  cardId: string;
  merchantId: string;
  amount: number;
  currency: string;
  merchantName: string;
  merchantCategory: string;
  status: 'pending' | 'completed' | 'declined' | 'refunded';
  declineReason?: string;
  createdAt: Date;
}

export interface GiftCardProgram {
  id: string;
  merchantId: string;
  name: string;
  description?: string;
  minAmount: number;
  maxAmount: number;
  currency: string;
  expiryDays?: number;
  customDesign?: string;
  isActive: boolean;
  createdAt: Date;
}

export class CardIssuingService {
  // ============================================
  // VIRTUAL CARDS
  // ============================================

  @RequireModule(PLATFORM_MODULES.VIRTUAL_CARDS)
  async issueVirtualCard(
    merchantId: string,
    input: {
      currency: string;
      spendingLimit?: number;
      allowedCategories?: string[];
      blockedCategories?: string[];
      metadata?: Record<string, any>;
    }
  ): Promise<IssuedCard> {
    const cardNumber = this.generateCardNumber();
    const last4 = cardNumber.slice(-4);
    const expiry = this.getExpiryDate(12); // 1 year

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO issued_cards (
        id, merchant_id, card_type, card_number_encrypted, last4,
        expiry_month, expiry_year, status, spending_limit, spent_total,
        currency, allowed_categories, blocked_categories, metadata, created_at
      ) VALUES ($1, $2, 'virtual', $3, $4, $5, $6, 'active', $7, 0, $8, $9, $10, $11, NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        this.encryptCardNumber(cardNumber),
        last4,
        expiry.month,
        expiry.year,
        input.spendingLimit,
        input.currency,
        input.allowedCategories ? JSON.stringify(input.allowedCategories) : null,
        input.blockedCategories ? JSON.stringify(input.blockedCategories) : null,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('cards.virtual.issued', {
      merchantId,
      data: { cardId: id },
    });

    return this.mapIssuedCard(result.rows[0]);
  }

  // ============================================
  // EXPENSE CARDS
  // ============================================

  @RequireModule(PLATFORM_MODULES.EXPENSE_CARDS)
  async issueExpenseCard(
    merchantId: string,
    input: {
      cardholderName: string;
      currency: string;
      spendingLimit: number;
      allowedCategories?: string[];
      blockedCategories?: string[];
      metadata?: Record<string, any>;
    }
  ): Promise<IssuedCard> {
    const cardNumber = this.generateCardNumber();
    const last4 = cardNumber.slice(-4);
    const expiry = this.getExpiryDate(36); // 3 years

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO issued_cards (
        id, merchant_id, card_type, card_number_encrypted, last4,
        expiry_month, expiry_year, cardholder_name, status, spending_limit,
        spent_total, currency, allowed_categories, blocked_categories, metadata, created_at
      ) VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7, 'active', $8, 0, $9, $10, $11, $12, NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        this.encryptCardNumber(cardNumber),
        last4,
        expiry.month,
        expiry.year,
        input.cardholderName,
        input.spendingLimit,
        input.currency,
        input.allowedCategories ? JSON.stringify(input.allowedCategories) : null,
        input.blockedCategories ? JSON.stringify(input.blockedCategories) : null,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('cards.expense.issued', {
      merchantId,
      data: { cardId: id, cardholderName: input.cardholderName },
    });

    return this.mapIssuedCard(result.rows[0]);
  }

  // ============================================
  // GIFT CARDS
  // ============================================

  @RequireModule(PLATFORM_MODULES.GIFT_CARDS)
  async createGiftCardProgram(
    merchantId: string,
    input: {
      name: string;
      description?: string;
      minAmount: number;
      maxAmount: number;
      currency: string;
      expiryDays?: number;
      customDesign?: string;
    }
  ): Promise<GiftCardProgram> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO gift_card_programs (
        id, merchant_id, name, description, min_amount, max_amount,
        currency, expiry_days, custom_design, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        input.name,
        input.description,
        input.minAmount,
        input.maxAmount,
        input.currency,
        input.expiryDays,
        input.customDesign,
      ]
    );

    return this.mapGiftCardProgram(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.GIFT_CARDS)
  async issueGiftCard(
    merchantId: string,
    input: {
      programId: string;
      amount: number;
      recipientEmail?: string;
      recipientName?: string;
      message?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<IssuedCard> {
    // Get program details
    const programResult = await query<any>(
      `SELECT * FROM gift_card_programs WHERE id = $1 AND merchant_id = $2`,
      [input.programId, merchantId]
    );

    if (programResult.rows.length === 0) {
      throw new NotFoundError('Gift Card Program');
    }

    const program = this.mapGiftCardProgram(programResult.rows[0]);

    if (input.amount < program.minAmount || input.amount > program.maxAmount) {
      throw new ValidationError(
        `Amount must be between ${program.minAmount} and ${program.maxAmount}`
      );
    }

    const cardNumber = this.generateCardNumber();
    const last4 = cardNumber.slice(-4);
    const expiry = this.getExpiryDate(program.expiryDays ? program.expiryDays : 365);

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO issued_cards (
        id, merchant_id, card_type, card_number_encrypted, last4,
        expiry_month, expiry_year, status, balance, spent_total,
        currency, metadata, created_at
      ) VALUES ($1, $2, 'gift', $3, $4, $5, $6, 'active', $7, 0, $8, $9, NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        this.encryptCardNumber(cardNumber),
        last4,
        expiry.month,
        expiry.year,
        input.amount,
        program.currency,
        JSON.stringify({
          ...input.metadata,
          programId: input.programId,
          recipientEmail: input.recipientEmail,
          recipientName: input.recipientName,
          message: input.message,
        }),
      ]
    );

    await eventBus.emit('cards.gift.issued', {
      merchantId,
      data: { cardId: id, amount: input.amount },
    });

    return this.mapIssuedCard(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.GIFT_CARDS)
  async checkGiftCardBalance(cardId: string): Promise<{ balance: number; currency: string }> {
    const result = await query<any>(
      `SELECT balance, currency FROM issued_cards WHERE id = $1 AND card_type = 'gift'`,
      [cardId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Gift Card');
    }

    return {
      balance: parseInt(result.rows[0].balance),
      currency: result.rows[0].currency,
    };
  }

  // ============================================
  // COMMON OPERATIONS
  // ============================================

  async getIssuedCards(
    merchantId: string,
    cardType?: IssuedCardType
  ): Promise<IssuedCard[]> {
    let queryText = `SELECT * FROM issued_cards WHERE merchant_id = $1`;
    const params: any[] = [merchantId];

    if (cardType) {
      queryText += ` AND card_type = $2`;
      params.push(cardType);
    }

    queryText += ` ORDER BY created_at DESC`;

    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapIssuedCard(row));
  }

  async updateCardStatus(
    merchantId: string,
    cardId: string,
    status: IssuedCardStatus
  ): Promise<IssuedCard> {
    const result = await query<any>(
      `UPDATE issued_cards SET status = $1 WHERE id = $2 AND merchant_id = $3 RETURNING *`,
      [status, cardId, merchantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Issued Card');
    }

    return this.mapIssuedCard(result.rows[0]);
  }

  async authorizeTransaction(
    cardId: string,
    input: {
      amount: number;
      currency: string;
      merchantName: string;
      merchantCategory: string;
    }
  ): Promise<{ authorized: boolean; declineReason?: string; transactionId?: string }> {
    const result = await query<any>(
      `SELECT * FROM issued_cards WHERE id = $1`,
      [cardId]
    );

    if (result.rows.length === 0) {
      return { authorized: false, declineReason: 'Card not found' };
    }

    const card = this.mapIssuedCard(result.rows[0]);

    // Check card status
    if (card.status !== 'active') {
      return { authorized: false, declineReason: `Card is ${card.status}` };
    }

    // Check currency
    if (card.currency !== input.currency) {
      return { authorized: false, declineReason: 'Currency mismatch' };
    }

    // Check balance (for gift cards)
    if (card.cardType === 'gift' && (card.balance || 0) < input.amount) {
      return { authorized: false, declineReason: 'Insufficient balance' };
    }

    // Check spending limit
    if (card.spendingLimit && card.spentTotal + input.amount > card.spendingLimit) {
      return { authorized: false, declineReason: 'Spending limit exceeded' };
    }

    // Check allowed/blocked categories
    if (card.allowedCategories && !card.allowedCategories.includes(input.merchantCategory)) {
      return { authorized: false, declineReason: 'Merchant category not allowed' };
    }

    if (card.blockedCategories && card.blockedCategories.includes(input.merchantCategory)) {
      return { authorized: false, declineReason: 'Merchant category blocked' };
    }

    // Create transaction record
    const transactionId = uuidv4();
    await query(
      `INSERT INTO card_transactions (
        id, card_id, merchant_id, amount, currency, merchant_name,
        merchant_category, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())`,
      [
        transactionId,
        cardId,
        card.merchantId,
        input.amount,
        input.currency,
        input.merchantName,
        input.merchantCategory,
      ]
    );

    return { authorized: true, transactionId };
  }

  async settleTransaction(transactionId: string): Promise<void> {
    const txResult = await query<any>(
      `SELECT * FROM card_transactions WHERE id = $1`,
      [transactionId]
    );

    if (txResult.rows.length === 0) {
      throw new NotFoundError('Card Transaction');
    }

    const tx = txResult.rows[0];

    // Update card balance/spent
    if (tx.card_type === 'gift') {
      await query(
        `UPDATE issued_cards SET balance = balance - $1, spent_total = spent_total + $1
         WHERE id = $2`,
        [tx.amount, tx.card_id]
      );
    } else {
      await query(
        `UPDATE issued_cards SET spent_total = spent_total + $1 WHERE id = $2`,
        [tx.amount, tx.card_id]
      );
    }

    // Update transaction status
    await query(
      `UPDATE card_transactions SET status = 'completed' WHERE id = $1`,
      [transactionId]
    );
  }

  // ============================================
  // HELPERS
  // ============================================

  private generateCardNumber(): string {
    const prefix = '4'; // Visa-like
    const rest = Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('');
    return prefix + rest;
  }

  private encryptCardNumber(cardNumber: string): string {
    return Buffer.from(cardNumber).toString('base64');
  }

  private getExpiryDate(months: number): { month: number; year: number } {
    const date = new Date();
    date.setMonth(date.getMonth() + months);
    return {
      month: date.getMonth() + 1,
      year: date.getFullYear(),
    };
  }

  private mapIssuedCard(row: any): IssuedCard {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      cardType: row.card_type,
      last4: row.last4,
      expiryMonth: parseInt(row.expiry_month),
      expiryYear: parseInt(row.expiry_year),
      cardholderName: row.cardholder_name,
      status: row.status,
      balance: row.balance ? parseInt(row.balance) : undefined,
      spendingLimit: row.spending_limit ? parseInt(row.spending_limit) : undefined,
      spentTotal: parseInt(row.spent_total || 0),
      currency: row.currency,
      allowedCategories: row.allowed_categories,
      blockedCategories: row.blocked_categories,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private mapGiftCardProgram(row: any): GiftCardProgram {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      name: row.name,
      description: row.description,
      minAmount: parseInt(row.min_amount),
      maxAmount: parseInt(row.max_amount),
      currency: row.currency,
      expiryDays: row.expiry_days ? parseInt(row.expiry_days) : undefined,
      customDesign: row.custom_design,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }
}

export const cardIssuingService = new CardIssuingService();
