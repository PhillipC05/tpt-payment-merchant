import { v4 as uuidv4 } from 'uuid';
import { query, transaction as dbTransaction } from '../database/connection';
import { transactionService } from './transaction.service';
import { webhookService } from './webhook.service';
import { logger } from '../utils/logger';
import {
  Plan, Subscription, Coupon, CreateSubscriptionInput,
  SubscriptionStatus, BillingInterval, PaginationParams, PaginatedResponse
} from '../types';

export class SubscriptionService {
  // Plan management
  async createPlan(merchantId: string, data: {
    name: string;
    description?: string;
    amount: number;
    currency: string;
    interval: BillingInterval;
    intervalCount?: number;
    trialPeriodDays?: number;
    features?: string[];
    metadata?: Record<string, any>;
  }): Promise<Plan> {
    const result = await query<any>(
      `INSERT INTO plans (merchant_id, name, description, amount, currency, interval, interval_count, trial_period_days, features, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [merchantId, data.name, data.description, data.amount, data.currency, data.interval,
       data.intervalCount || 1, data.trialPeriodDays, JSON.stringify(data.features || []),
       JSON.stringify(data.metadata || {})]
    );
    return this.mapPlan(result.rows[0]);
  }

  async getPlan(planId: string, merchantId: string): Promise<Plan> {
    const result = await query<any>('SELECT * FROM plans WHERE id = $1 AND merchant_id = $2', [planId, merchantId]);
    if (result.rows.length === 0) throw new Error('Plan not found');
    return this.mapPlan(result.rows[0]);
  }

  async listPlans(merchantId: string, activeOnly = true): Promise<Plan[]> {
    let queryText = 'SELECT * FROM plans WHERE merchant_id = $1';
    if (activeOnly) queryText += ' AND active = true';
    queryText += ' ORDER BY created_at DESC';
    const result = await query<any>(queryText, [merchantId]);
    return result.rows.map(row => this.mapPlan(row));
  }

  // Subscription management
  async createSubscription(merchantId: string, input: CreateSubscriptionInput): Promise<Subscription> {
    const plan = await this.getPlan(input.planId, merchantId);

    const now = new Date();
    let trialEnd: Date | null = null;
    let periodStart = now;
    let status: SubscriptionStatus = 'active';

    // Handle trial period
    const trialDays = input.trialDays ?? plan.trialPeriodDays;
    if (trialDays && trialDays > 0) {
      trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
      status = 'trialing';
    }

    const periodEnd = this.calculatePeriodEnd(periodStart, plan.interval, plan.intervalCount);

    const result = await query<any>(
      `INSERT INTO subscriptions (merchant_id, customer_id, plan_id, status, quantity, current_period_start, current_period_end, trial_start, trial_end, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [merchantId, input.customerId, input.planId, status, input.quantity || 1, periodStart,
       periodEnd, trialDays ? now : null, trialEnd, JSON.stringify(input.metadata || {})]
    );

    const subscription = this.mapSubscription(result.rows[0]);

    await webhookService.send(merchantId, 'subscription.created' as any, { subscription, plan });

    logger.info('Subscription created', { subscriptionId: subscription.id, planId: plan.id });

    return subscription;
  }

  async getSubscription(subscriptionId: string, merchantId: string): Promise<Subscription> {
    const result = await query<any>('SELECT * FROM subscriptions WHERE id = $1 AND merchant_id = $2', [subscriptionId, merchantId]);
    if (result.rows.length === 0) throw new Error('Subscription not found');
    return this.mapSubscription(result.rows[0]);
  }

  async listSubscriptions(merchantId: string, params: PaginationParams & { customerId?: string; status?: SubscriptionStatus }): Promise<PaginatedResponse<Subscription>> {
    const { page, limit, customerId, status } = params;
    const offset = (page - 1) * limit;

    let conditions = ['merchant_id = $1'];
    const values: any[] = [merchantId];

    if (customerId) { values.push(customerId); conditions.push(`customer_id = $${values.length}`); }
    if (status) { values.push(status); conditions.push(`status = $${values.length}`); }

    const whereClause = conditions.join(' AND ');

    const [dataResult, countResult] = await Promise.all([
      query<any>(`SELECT * FROM subscriptions WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
      query<{ count: string }>(`SELECT COUNT(*) as count FROM subscriptions WHERE ${whereClause}`, values)
    ]);

    return {
      data: dataResult.rows.map(row => this.mapSubscription(row)),
      pagination: { page, limit, total: parseInt(countResult.rows[0].count), totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit) }
    };
  }

  async cancelSubscription(subscriptionId: string, merchantId: string, cancelAtPeriodEnd = true): Promise<Subscription> {
    const subscription = await this.getSubscription(subscriptionId, merchantId);

    const updates = cancelAtPeriodEnd
      ? { cancel_at_period_end: true }
      : { status: 'canceled', canceled_at: new Date() };

    const setClauses = Object.entries(updates).map(([k], i) => `${k} = $${i + 1}`).join(', ');
    const result = await query<any>(
      `UPDATE subscriptions SET ${setClauses} WHERE id = $${Object.keys(updates).length + 1} RETURNING *`,
      [...Object.values(updates), subscriptionId]
    );

    const updated = this.mapSubscription(result.rows[0]);
    await webhookService.send(merchantId, 'subscription.canceled' as any, { subscription: updated });

    return updated;
  }

  async renewSubscription(subscriptionId: string): Promise<Subscription> {
    const result = await query<any>('SELECT s.*, p.amount, p.currency, p.interval, p.interval_count FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.id = $1', [subscriptionId]);
    if (result.rows.length === 0) throw new Error('Subscription not found');

    const row = result.rows[0];
    const subscription = this.mapSubscription(row);

    if (subscription.cancelAtPeriodEnd) {
      await query('UPDATE subscriptions SET status = $1 WHERE id = $2', ['canceled', subscriptionId]);
      return { ...subscription, status: 'canceled' };
    }

    // Charge customer
    const amount = row.amount * subscription.quantity;
    try {
      await transactionService.createCharge(subscription.merchantId, {
        amount,
        currency: row.currency,
        customerId: subscription.customerId,
        description: `Subscription renewal - ${subscriptionId}`,
        metadata: { subscriptionId, type: 'subscription_renewal' }
      });

      // Update period
      const newPeriodStart = subscription.currentPeriodEnd;
      const newPeriodEnd = this.calculatePeriodEnd(newPeriodStart, row.interval, row.interval_count);

      const updateResult = await query<any>(
        `UPDATE subscriptions SET status = 'active', current_period_start = $1, current_period_end = $2 WHERE id = $3 RETURNING *`,
        [newPeriodStart, newPeriodEnd, subscriptionId]
      );

      const renewed = this.mapSubscription(updateResult.rows[0]);
      await webhookService.send(subscription.merchantId, 'subscription.renewed' as any, { subscription: renewed });

      return renewed;
    } catch (error) {
      await query('UPDATE subscriptions SET status = $1 WHERE id = $2', ['past_due', subscriptionId]);
      throw error;
    }
  }

  // Coupon management
  async createCoupon(merchantId: string, data: {
    code: string;
    name: string;
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    currency?: string;
    maxRedemptions?: number;
    expiresAt?: Date;
  }): Promise<Coupon> {
    const result = await query<any>(
      `INSERT INTO coupons (merchant_id, code, name, discount_type, discount_value, currency, max_redemptions, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [merchantId, data.code.toUpperCase(), data.name, data.discountType, data.discountValue, data.currency, data.maxRedemptions, data.expiresAt]
    );
    return this.mapCoupon(result.rows[0]);
  }

  async validateCoupon(code: string, merchantId: string): Promise<Coupon> {
    const result = await query<any>('SELECT * FROM coupons WHERE code = $1 AND merchant_id = $2 AND active = true', [code.toUpperCase(), merchantId]);
    if (result.rows.length === 0) throw new Error('Invalid coupon');

    const coupon = this.mapCoupon(result.rows[0]);
    if (coupon.expiresAt && new Date() > coupon.expiresAt) throw new Error('Coupon expired');
    if (coupon.maxRedemptions && coupon.timesRedeemed >= coupon.maxRedemptions) throw new Error('Coupon limit reached');

    return coupon;
  }

  // Helpers
  private calculatePeriodEnd(start: Date, interval: BillingInterval, count: number): Date {
    const end = new Date(start);
    switch (interval) {
      case 'day': end.setDate(end.getDate() + count); break;
      case 'week': end.setDate(end.getDate() + count * 7); break;
      case 'month': end.setMonth(end.getMonth() + count); break;
      case 'year': end.setFullYear(end.getFullYear() + count); break;
    }
    return end;
  }

  private mapPlan(row: any): Plan {
    return {
      id: row.id, merchantId: row.merchant_id, name: row.name, description: row.description,
      amount: parseInt(row.amount), currency: row.currency, interval: row.interval,
      intervalCount: row.interval_count, trialPeriodDays: row.trial_period_days,
      features: row.features, metadata: row.metadata, active: row.active,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  private mapSubscription(row: any): Subscription {
    return {
      id: row.id, merchantId: row.merchant_id, customerId: row.customer_id, planId: row.plan_id,
      status: row.status, quantity: row.quantity, currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end,
      canceledAt: row.canceled_at, trialStart: row.trial_start, trialEnd: row.trial_end,
      metadata: row.metadata, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  private mapCoupon(row: any): Coupon {
    return {
      id: row.id, merchantId: row.merchant_id, code: row.code, name: row.name,
      discountType: row.discount_type, discountValue: parseInt(row.discount_value),
      currency: row.currency, maxRedemptions: row.max_redemptions,
      timesRedeemed: row.times_redeemed, expiresAt: row.expires_at,
      active: row.active, createdAt: row.created_at
    };
  }
}

export const subscriptionService = new SubscriptionService();
