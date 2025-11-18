// Promotions Service - Trials, Coupons, and Discounts
// Handles free trials, discount codes, and promotional pricing

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';

// Coupon definition
export interface Coupon {
  id: string;
  merchantId: string;
  name: string;
  currency?: string;

  // Discount type
  amountOff?: number; // Fixed amount in cents
  percentOff?: number; // Percentage (0-100)

  // Restrictions
  duration: 'once' | 'repeating' | 'forever';
  durationInMonths?: number; // For repeating
  maxRedemptions?: number;
  redeemBy?: Date;

  // Product restrictions
  appliesTo?: {
    products?: string[];
    prices?: string[];
  };

  // Limits
  minPurchaseAmount?: number;
  firstTimeTransaction?: boolean;

  // Status
  timesRedeemed: number;
  valid: boolean;

  metadata?: Record<string, string>;
  createdAt: Date;
}

// Promotion code (customer-facing code that links to coupon)
export interface PromotionCode {
  id: string;
  merchantId: string;
  code: string;
  couponId: string;
  active: boolean;
  customer?: string; // Specific customer only
  expiresAt?: Date;
  maxRedemptions?: number;
  timesRedeemed: number;
  restrictions?: {
    firstTimeTransaction?: boolean;
    minimumAmount?: number;
    minimumAmountCurrency?: string;
  };
  metadata?: Record<string, string>;
  createdAt: Date;
}

// Discount applied to an invoice or subscription
export interface Discount {
  id: string;
  couponId: string;
  customerId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  promotionCodeId?: string;
  start?: Date;
  end?: Date;
}

// Trial configuration
export interface TrialConfig {
  trialPeriodDays: number;
  trialEnd?: Date;
  trialFromPlan?: boolean; // Use trial from plan or override
  endBehavior: 'create_invoice' | 'pause' | 'cancel';
}

// Applied discount calculation
export interface AppliedDiscount {
  couponId: string;
  name: string;
  amountOff: number;
  currency: string;
  percentOff?: number;
}

export class PromotionsService {
  // ==========================================
  // COUPONS
  // ==========================================

  // Create a coupon
  async createCoupon(
    merchantId: string,
    input: {
      id?: string;
      name: string;
      currency?: string;
      amountOff?: number;
      percentOff?: number;
      duration: Coupon['duration'];
      durationInMonths?: number;
      maxRedemptions?: number;
      redeemBy?: Date;
      appliesTo?: Coupon['appliesTo'];
      minPurchaseAmount?: number;
      firstTimeTransaction?: boolean;
      metadata?: Record<string, string>;
    }
  ): Promise<Coupon> {
    // Validate discount type
    if (!input.amountOff && !input.percentOff) {
      throw new Error('Must specify amountOff or percentOff');
    }
    if (input.amountOff && input.percentOff) {
      throw new Error('Cannot specify both amountOff and percentOff');
    }
    if (input.percentOff && (input.percentOff < 0 || input.percentOff > 100)) {
      throw new Error('percentOff must be between 0 and 100');
    }

    const couponId = input.id || `cpn_${uuidv4().replace(/-/g, '').slice(0, 24)}`;

    await query(
      `INSERT INTO coupons (
        id, merchant_id, name, currency, amount_off, percent_off,
        duration, duration_in_months, max_redemptions, redeem_by,
        applies_to, min_purchase_amount, first_time_transaction,
        times_redeemed, valid, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, true, $14, NOW())`,
      [
        couponId, merchantId, input.name, input.currency,
        input.amountOff, input.percentOff, input.duration,
        input.durationInMonths, input.maxRedemptions, input.redeemBy,
        JSON.stringify(input.appliesTo || {}), input.minPurchaseAmount,
        input.firstTimeTransaction || false, JSON.stringify(input.metadata || {})
      ]
    );

    logger.info('Coupon created', { couponId, merchantId, name: input.name });

    return {
      id: couponId,
      merchantId,
      name: input.name,
      currency: input.currency,
      amountOff: input.amountOff,
      percentOff: input.percentOff,
      duration: input.duration,
      durationInMonths: input.durationInMonths,
      maxRedemptions: input.maxRedemptions,
      redeemBy: input.redeemBy,
      appliesTo: input.appliesTo,
      minPurchaseAmount: input.minPurchaseAmount,
      firstTimeTransaction: input.firstTimeTransaction,
      timesRedeemed: 0,
      valid: true,
      metadata: input.metadata,
      createdAt: new Date(),
    };
  }

  // Get coupon
  async getCoupon(couponId: string): Promise<Coupon | null> {
    const result = await query<any>(
      `SELECT * FROM coupons WHERE id = $1`,
      [couponId]
    );

    if (result.rows.length === 0) return null;

    return this.mapCoupon(result.rows[0]);
  }

  // Update coupon
  async updateCoupon(
    couponId: string,
    updates: {
      name?: string;
      metadata?: Record<string, string>;
    }
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: any[] = [couponId];
    let paramIndex = 2;

    if (updates.name) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.metadata) {
      setClauses.push(`metadata = $${paramIndex++}`);
      params.push(JSON.stringify(updates.metadata));
    }

    if (setClauses.length > 0) {
      await query(
        `UPDATE coupons SET ${setClauses.join(', ')} WHERE id = $1`,
        params
      );
    }
  }

  // Delete coupon
  async deleteCoupon(couponId: string): Promise<void> {
    await query(`UPDATE coupons SET valid = false WHERE id = $1`, [couponId]);
    logger.info('Coupon deleted', { couponId });
  }

  // List coupons
  async listCoupons(
    merchantId: string,
    options?: {
      valid?: boolean;
      limit?: number;
    }
  ): Promise<Coupon[]> {
    let sql = `SELECT * FROM coupons WHERE merchant_id = $1`;
    const params: any[] = [merchantId];
    let paramIndex = 2;

    if (options?.valid !== undefined) {
      sql += ` AND valid = $${paramIndex++}`;
      params.push(options.valid);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(options?.limit || 10);

    const result = await query<any>(sql, params);
    return result.rows.map(this.mapCoupon);
  }

  // ==========================================
  // PROMOTION CODES
  // ==========================================

  // Create promotion code
  async createPromotionCode(
    merchantId: string,
    input: {
      code: string;
      couponId: string;
      active?: boolean;
      customer?: string;
      expiresAt?: Date;
      maxRedemptions?: number;
      restrictions?: PromotionCode['restrictions'];
      metadata?: Record<string, string>;
    }
  ): Promise<PromotionCode> {
    // Validate coupon exists
    const coupon = await this.getCoupon(input.couponId);
    if (!coupon || coupon.merchantId !== merchantId) {
      throw new Error('Coupon not found');
    }

    // Check code uniqueness
    const existing = await query<any>(
      `SELECT id FROM promotion_codes WHERE merchant_id = $1 AND code = $2`,
      [merchantId, input.code.toUpperCase()]
    );

    if (existing.rows.length > 0) {
      throw new Error('Promotion code already exists');
    }

    const promoId = `promo_${uuidv4().replace(/-/g, '')}`;

    await query(
      `INSERT INTO promotion_codes (
        id, merchant_id, code, coupon_id, active, customer,
        expires_at, max_redemptions, times_redeemed, restrictions,
        metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, NOW())`,
      [
        promoId, merchantId, input.code.toUpperCase(), input.couponId,
        input.active !== false, input.customer, input.expiresAt,
        input.maxRedemptions, JSON.stringify(input.restrictions || {}),
        JSON.stringify(input.metadata || {})
      ]
    );

    logger.info('Promotion code created', { promoId, code: input.code, merchantId });

    return {
      id: promoId,
      merchantId,
      code: input.code.toUpperCase(),
      couponId: input.couponId,
      active: input.active !== false,
      customer: input.customer,
      expiresAt: input.expiresAt,
      maxRedemptions: input.maxRedemptions,
      timesRedeemed: 0,
      restrictions: input.restrictions,
      metadata: input.metadata,
      createdAt: new Date(),
    };
  }

  // Validate and retrieve promotion code
  async validatePromotionCode(
    merchantId: string,
    code: string,
    context?: {
      customerId?: string;
      amount?: number;
      currency?: string;
      productIds?: string[];
      priceIds?: string[];
    }
  ): Promise<{ valid: boolean; promotionCode?: PromotionCode; coupon?: Coupon; error?: string }> {
    const result = await query<any>(
      `SELECT pc.*, c.*,
        pc.id as promo_id, pc.metadata as promo_metadata,
        c.id as coupon_id, c.metadata as coupon_metadata
       FROM promotion_codes pc
       JOIN coupons c ON c.id = pc.coupon_id
       WHERE pc.merchant_id = $1 AND pc.code = $2`,
      [merchantId, code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return { valid: false, error: 'Promotion code not found' };
    }

    const row = result.rows[0];

    // Check if active
    if (!row.active) {
      return { valid: false, error: 'Promotion code is not active' };
    }

    // Check expiration
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return { valid: false, error: 'Promotion code has expired' };
    }

    // Check max redemptions
    if (row.max_redemptions && row.times_redeemed >= row.max_redemptions) {
      return { valid: false, error: 'Promotion code has reached maximum redemptions' };
    }

    // Check coupon validity
    if (!row.valid) {
      return { valid: false, error: 'Coupon is no longer valid' };
    }

    if (row.redeem_by && new Date(row.redeem_by) < new Date()) {
      return { valid: false, error: 'Coupon has expired' };
    }

    if (row.coupon_max_redemptions && row.coupon_times_redeemed >= row.coupon_max_redemptions) {
      return { valid: false, error: 'Coupon has reached maximum redemptions' };
    }

    // Check customer restriction
    if (row.customer && context?.customerId !== row.customer) {
      return { valid: false, error: 'Promotion code is restricted to another customer' };
    }

    // Check minimum amount
    const minAmount = row.restrictions?.minimumAmount || row.min_purchase_amount;
    if (minAmount && context?.amount && context.amount < minAmount) {
      return {
        valid: false,
        error: `Minimum purchase amount of ${minAmount / 100} required`
      };
    }

    // Check first-time transaction
    if (row.first_time_transaction || row.restrictions?.firstTimeTransaction) {
      if (context?.customerId) {
        const prevPurchases = await query<any>(
          `SELECT COUNT(*) FROM payments
           WHERE customer_id = $1 AND status = 'succeeded'`,
          [context.customerId]
        );
        if (parseInt(prevPurchases.rows[0].count) > 0) {
          return { valid: false, error: 'Promotion code is for first-time customers only' };
        }
      }
    }

    // Check product/price restrictions
    const appliesTo = row.applies_to || {};
    if (appliesTo.products?.length && context?.productIds) {
      const hasMatch = context.productIds.some(p => appliesTo.products.includes(p));
      if (!hasMatch) {
        return { valid: false, error: 'Promotion code does not apply to these products' };
      }
    }
    if (appliesTo.prices?.length && context?.priceIds) {
      const hasMatch = context.priceIds.some(p => appliesTo.prices.includes(p));
      if (!hasMatch) {
        return { valid: false, error: 'Promotion code does not apply to these prices' };
      }
    }

    return {
      valid: true,
      promotionCode: {
        id: row.promo_id,
        merchantId,
        code: row.code,
        couponId: row.coupon_id,
        active: row.active,
        customer: row.customer,
        expiresAt: row.expires_at,
        maxRedemptions: row.max_redemptions,
        timesRedeemed: row.times_redeemed,
        restrictions: row.restrictions,
        metadata: row.promo_metadata,
        createdAt: row.created_at,
      },
      coupon: this.mapCoupon({
        ...row,
        id: row.coupon_id,
        metadata: row.coupon_metadata,
      }),
    };
  }

  // Redeem promotion code
  async redeemPromotionCode(
    promoCodeId: string,
    couponId: string
  ): Promise<void> {
    await Promise.all([
      query(
        `UPDATE promotion_codes SET times_redeemed = times_redeemed + 1 WHERE id = $1`,
        [promoCodeId]
      ),
      query(
        `UPDATE coupons SET times_redeemed = times_redeemed + 1 WHERE id = $1`,
        [couponId]
      ),
    ]);
  }

  // ==========================================
  // DISCOUNTS
  // ==========================================

  // Apply discount to subscription or invoice
  async applyDiscount(
    merchantId: string,
    input: {
      couponId?: string;
      promotionCodeId?: string;
      customerId?: string;
      subscriptionId?: string;
      invoiceId?: string;
    }
  ): Promise<Discount> {
    let couponId = input.couponId;

    // Get coupon from promotion code if needed
    if (input.promotionCodeId && !couponId) {
      const promoResult = await query<any>(
        `SELECT coupon_id FROM promotion_codes WHERE id = $1`,
        [input.promotionCodeId]
      );
      if (promoResult.rows.length > 0) {
        couponId = promoResult.rows[0].coupon_id;
      }
    }

    if (!couponId) {
      throw new Error('Coupon ID required');
    }

    // Get coupon for duration
    const coupon = await this.getCoupon(couponId);
    if (!coupon) {
      throw new Error('Coupon not found');
    }

    const discountId = `di_${uuidv4().replace(/-/g, '')}`;
    let endDate: Date | undefined;

    if (coupon.duration === 'repeating' && coupon.durationInMonths) {
      endDate = new Date();
      endDate.setMonth(endDate.getMonth() + coupon.durationInMonths);
    }

    await query(
      `INSERT INTO discounts (
        id, coupon_id, customer_id, subscription_id, invoice_id,
        promotion_code_id, start_date, end_date, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW())`,
      [
        discountId, couponId, input.customerId, input.subscriptionId,
        input.invoiceId, input.promotionCodeId, endDate
      ]
    );

    // Increment redemption counts
    if (input.promotionCodeId) {
      await this.redeemPromotionCode(input.promotionCodeId, couponId);
    } else {
      await query(
        `UPDATE coupons SET times_redeemed = times_redeemed + 1 WHERE id = $1`,
        [couponId]
      );
    }

    logger.info('Discount applied', { discountId, couponId, subscriptionId: input.subscriptionId });

    return {
      id: discountId,
      couponId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      invoiceId: input.invoiceId,
      promotionCodeId: input.promotionCodeId,
      start: new Date(),
      end: endDate,
    };
  }

  // Calculate discount amount
  async calculateDiscount(
    couponId: string,
    amount: number,
    currency: string
  ): Promise<AppliedDiscount> {
    const coupon = await this.getCoupon(couponId);
    if (!coupon) {
      throw new Error('Coupon not found');
    }

    let discountAmount: number;

    if (coupon.percentOff) {
      discountAmount = Math.round(amount * (coupon.percentOff / 100));
    } else if (coupon.amountOff) {
      // Check currency match
      if (coupon.currency && coupon.currency !== currency) {
        throw new Error('Coupon currency does not match');
      }
      discountAmount = Math.min(coupon.amountOff, amount);
    } else {
      discountAmount = 0;
    }

    return {
      couponId,
      name: coupon.name,
      amountOff: discountAmount,
      currency,
      percentOff: coupon.percentOff,
    };
  }

  // Get discounts for subscription
  async getSubscriptionDiscounts(subscriptionId: string): Promise<Discount[]> {
    const result = await query<any>(
      `SELECT * FROM discounts
       WHERE subscription_id = $1
         AND (end_date IS NULL OR end_date > NOW())
       ORDER BY created_at DESC`,
      [subscriptionId]
    );

    return result.rows.map(row => ({
      id: row.id,
      couponId: row.coupon_id,
      customerId: row.customer_id,
      subscriptionId: row.subscription_id,
      invoiceId: row.invoice_id,
      promotionCodeId: row.promotion_code_id,
      start: row.start_date,
      end: row.end_date,
    }));
  }

  // Delete discount
  async deleteDiscount(discountId: string): Promise<void> {
    await query(`DELETE FROM discounts WHERE id = $1`, [discountId]);
    logger.info('Discount deleted', { discountId });
  }

  // ==========================================
  // TRIALS
  // ==========================================

  // Create subscription with trial
  async createTrialSubscription(
    merchantId: string,
    customerId: string,
    priceId: string,
    trialConfig: TrialConfig
  ): Promise<{ subscriptionId: string; trialEnd: Date }> {
    const subscriptionId = `sub_${uuidv4().replace(/-/g, '')}`;

    // Calculate trial end
    let trialEnd: Date;
    if (trialConfig.trialEnd) {
      trialEnd = trialConfig.trialEnd;
    } else {
      trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + trialConfig.trialPeriodDays);
    }

    // Create subscription in trialing status
    await query(
      `INSERT INTO subscriptions (
        id, merchant_id, customer_id, status, trial_start, trial_end,
        trial_end_behavior, current_period_start, current_period_end, created_at
      ) VALUES ($1, $2, $3, 'trialing', NOW(), $4, $5, NOW(), $4, NOW())`,
      [subscriptionId, merchantId, customerId, trialEnd, trialConfig.endBehavior]
    );

    // Add subscription item
    await query(
      `INSERT INTO subscription_items (id, subscription_id, price_id, quantity, created_at)
       VALUES ($1, $2, $3, 1, NOW())`,
      [`si_${uuidv4().replace(/-/g, '').slice(0, 14)}`, subscriptionId, priceId]
    );

    logger.info('Trial subscription created', {
      subscriptionId, customerId, trialEnd, trialPeriodDays: trialConfig.trialPeriodDays
    });

    return { subscriptionId, trialEnd };
  }

  // End trial early
  async endTrialEarly(subscriptionId: string): Promise<void> {
    await query(
      `UPDATE subscriptions
       SET trial_end = NOW(), status = 'active',
           current_period_start = NOW(),
           current_period_end = NOW() + INTERVAL '1 month'
       WHERE id = $1 AND status = 'trialing'`,
      [subscriptionId]
    );

    logger.info('Trial ended early', { subscriptionId });
  }

  // Process ending trials (cron job)
  async processEndingTrials(): Promise<number> {
    // Get trials ending today
    const endingTrials = await query<any>(
      `SELECT * FROM subscriptions
       WHERE status = 'trialing' AND trial_end <= NOW()`
    );

    let processed = 0;

    for (const sub of endingTrials.rows) {
      switch (sub.trial_end_behavior) {
        case 'create_invoice':
          // Transition to active and create first invoice
          await query(
            `UPDATE subscriptions
             SET status = 'active',
                 current_period_start = NOW(),
                 current_period_end = NOW() + INTERVAL '1 month'
             WHERE id = $1`,
            [sub.id]
          );
          // Would trigger invoice creation here
          break;

        case 'pause':
          await query(
            `UPDATE subscriptions SET status = 'paused' WHERE id = $1`,
            [sub.id]
          );
          break;

        case 'cancel':
          await query(
            `UPDATE subscriptions
             SET status = 'cancelled', cancelled_at = NOW()
             WHERE id = $1`,
            [sub.id]
          );
          break;
      }

      processed++;
    }

    if (processed > 0) {
      logger.info('Processed ending trials', { count: processed });
    }

    return processed;
  }

  // Helper: Map database row to Coupon
  private mapCoupon(row: any): Coupon {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      name: row.name,
      currency: row.currency,
      amountOff: row.amount_off,
      percentOff: row.percent_off,
      duration: row.duration,
      durationInMonths: row.duration_in_months,
      maxRedemptions: row.max_redemptions,
      redeemBy: row.redeem_by,
      appliesTo: row.applies_to,
      minPurchaseAmount: row.min_purchase_amount,
      firstTimeTransaction: row.first_time_transaction,
      timesRedeemed: row.times_redeemed,
      valid: row.valid,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }
}

export const promotionsService = new PromotionsService();
