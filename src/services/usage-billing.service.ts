// Usage-Based Billing Service
// Metered/consumption billing with usage tracking

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';

// Meter configuration
export interface UsageMeter {
  id: string;
  merchantId: string;
  displayName: string;
  eventName: string; // The event to track
  aggregationType: 'sum' | 'count' | 'max' | 'last' | 'unique';
  valueKey?: string; // Key in event payload for the value
  deduplicationKey?: string; // Key for deduplication
  defaultUnit: string; // e.g., "API calls", "GB", "users"
  createdAt: Date;
}

// Usage record (raw event)
export interface UsageRecord {
  id: string;
  meterId: string;
  subscriptionId: string;
  customerId: string;
  timestamp: Date;
  quantity: number;
  action?: 'set' | 'increment'; // For 'last' aggregation
  properties?: Record<string, any>;
  idempotencyKey?: string;
}

// Aggregated usage for billing
export interface UsageSummary {
  meterId: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  totalUsage: number;
  unitAmount: number; // Price per unit
  lineItemAmount: number; // Total charge
  tiers?: UsageTier[];
}

// Tiered pricing
export interface UsageTier {
  upTo: number | null; // null = infinite
  unitAmount: number;
  flatAmount?: number;
}

// Price configuration for metered billing
export interface MeteredPrice {
  id: string;
  productId: string;
  meterId: string;
  currency: string;
  billingScheme: 'per_unit' | 'tiered';
  unitAmount?: number; // For per_unit
  tiers?: UsageTier[]; // For tiered
  tiersMode?: 'graduated' | 'volume';
  transformQuantity?: {
    divideBy: number;
    round: 'up' | 'down';
  };
  aggregateUsage?: 'sum' | 'last_during_period' | 'last_ever' | 'max';
}

// Subscription item with usage
export interface SubscriptionItemUsage {
  subscriptionItemId: string;
  meterId: string;
  periodStart: Date;
  periodEnd: Date;
  totalUsage: number;
  invoiceItems: {
    quantity: number;
    unitAmount: number;
    amount: number;
    description: string;
  }[];
}

export class UsageBillingService {
  // ==========================================
  // METER MANAGEMENT
  // ==========================================

  // Create a usage meter
  async createMeter(
    merchantId: string,
    input: {
      displayName: string;
      eventName: string;
      aggregationType: UsageMeter['aggregationType'];
      valueKey?: string;
      deduplicationKey?: string;
      defaultUnit?: string;
    }
  ): Promise<UsageMeter> {
    const meterId = `mtr_${uuidv4().replace(/-/g, '')}`;

    await query(
      `INSERT INTO usage_meters (
        id, merchant_id, display_name, event_name, aggregation_type,
        value_key, deduplication_key, default_unit, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        meterId,
        merchantId,
        input.displayName,
        input.eventName,
        input.aggregationType,
        input.valueKey,
        input.deduplicationKey,
        input.defaultUnit || 'units',
      ]
    );

    logger.info('Usage meter created', { meterId, eventName: input.eventName });

    return {
      id: meterId,
      merchantId,
      displayName: input.displayName,
      eventName: input.eventName,
      aggregationType: input.aggregationType,
      valueKey: input.valueKey,
      deduplicationKey: input.deduplicationKey,
      defaultUnit: input.defaultUnit || 'units',
      createdAt: new Date(),
    };
  }

  // Get meter by ID
  async getMeter(meterId: string): Promise<UsageMeter | null> {
    const result = await query<any>(
      `SELECT * FROM usage_meters WHERE id = $1`,
      [meterId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      merchantId: row.merchant_id,
      displayName: row.display_name,
      eventName: row.event_name,
      aggregationType: row.aggregation_type,
      valueKey: row.value_key,
      deduplicationKey: row.deduplication_key,
      defaultUnit: row.default_unit,
      createdAt: row.created_at,
    };
  }

  // List meters for a merchant
  async listMeters(merchantId: string): Promise<UsageMeter[]> {
    const result = await query<any>(
      `SELECT * FROM usage_meters WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [merchantId]
    );

    return result.rows.map(row => ({
      id: row.id,
      merchantId: row.merchant_id,
      displayName: row.display_name,
      eventName: row.event_name,
      aggregationType: row.aggregation_type,
      valueKey: row.value_key,
      deduplicationKey: row.deduplication_key,
      defaultUnit: row.default_unit,
      createdAt: row.created_at,
    }));
  }

  // ==========================================
  // USAGE RECORDING
  // ==========================================

  // Record usage event
  async recordUsage(
    subscriptionId: string,
    input: {
      meterId: string;
      quantity: number;
      timestamp?: Date;
      action?: 'set' | 'increment';
      properties?: Record<string, any>;
      idempotencyKey?: string;
    }
  ): Promise<UsageRecord> {
    // Check for duplicate if idempotency key provided
    if (input.idempotencyKey) {
      const existing = await query<any>(
        `SELECT id FROM usage_records WHERE idempotency_key = $1`,
        [input.idempotencyKey]
      );

      if (existing.rows.length > 0) {
        logger.warn('Duplicate usage record', { idempotencyKey: input.idempotencyKey });
        // Return the existing record ID
        const existingRecord = await this.getUsageRecord(existing.rows[0].id);
        if (existingRecord) return existingRecord;
      }
    }

    // Get subscription and customer
    const subResult = await query<any>(
      `SELECT customer_id FROM subscriptions WHERE id = $1`,
      [subscriptionId]
    );

    if (subResult.rows.length === 0) {
      throw new Error('Subscription not found');
    }

    const customerId = subResult.rows[0].customer_id;
    const recordId = `usr_${uuidv4().replace(/-/g, '')}`;
    const timestamp = input.timestamp || new Date();

    await query(
      `INSERT INTO usage_records (
        id, meter_id, subscription_id, customer_id, timestamp,
        quantity, action, properties, idempotency_key, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        recordId,
        input.meterId,
        subscriptionId,
        customerId,
        timestamp,
        input.quantity,
        input.action || 'increment',
        JSON.stringify(input.properties || {}),
        input.idempotencyKey,
      ]
    );

    logger.debug('Usage recorded', { recordId, meterId: input.meterId, quantity: input.quantity });

    return {
      id: recordId,
      meterId: input.meterId,
      subscriptionId,
      customerId,
      timestamp,
      quantity: input.quantity,
      action: input.action,
      properties: input.properties,
      idempotencyKey: input.idempotencyKey,
    };
  }

  // Batch record usage events
  async recordUsageBatch(
    subscriptionId: string,
    events: {
      meterId: string;
      quantity: number;
      timestamp?: Date;
      properties?: Record<string, any>;
      idempotencyKey?: string;
    }[]
  ): Promise<{ recorded: number; duplicates: number }> {
    let recorded = 0;
    let duplicates = 0;

    for (const event of events) {
      try {
        await this.recordUsage(subscriptionId, event);
        recorded++;
      } catch (error: any) {
        if (error.message?.includes('duplicate')) {
          duplicates++;
        } else {
          throw error;
        }
      }
    }

    return { recorded, duplicates };
  }

  // Get usage record
  async getUsageRecord(recordId: string): Promise<UsageRecord | null> {
    const result = await query<any>(
      `SELECT * FROM usage_records WHERE id = $1`,
      [recordId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      meterId: row.meter_id,
      subscriptionId: row.subscription_id,
      customerId: row.customer_id,
      timestamp: row.timestamp,
      quantity: row.quantity,
      action: row.action,
      properties: row.properties,
      idempotencyKey: row.idempotency_key,
    };
  }

  // ==========================================
  // USAGE AGGREGATION
  // ==========================================

  // Get usage summary for a subscription item
  async getUsageSummary(
    subscriptionId: string,
    meterId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<number> {
    const meter = await this.getMeter(meterId);
    if (!meter) {
      throw new Error('Meter not found');
    }

    let aggregatedValue: number;

    switch (meter.aggregationType) {
      case 'sum':
        const sumResult = await query<any>(
          `SELECT COALESCE(SUM(quantity), 0) as total
           FROM usage_records
           WHERE subscription_id = $1 AND meter_id = $2
             AND timestamp >= $3 AND timestamp < $4`,
          [subscriptionId, meterId, periodStart, periodEnd]
        );
        aggregatedValue = parseFloat(sumResult.rows[0].total);
        break;

      case 'count':
        const countResult = await query<any>(
          `SELECT COUNT(*) as total
           FROM usage_records
           WHERE subscription_id = $1 AND meter_id = $2
             AND timestamp >= $3 AND timestamp < $4`,
          [subscriptionId, meterId, periodStart, periodEnd]
        );
        aggregatedValue = parseInt(countResult.rows[0].total);
        break;

      case 'max':
        const maxResult = await query<any>(
          `SELECT COALESCE(MAX(quantity), 0) as total
           FROM usage_records
           WHERE subscription_id = $1 AND meter_id = $2
             AND timestamp >= $3 AND timestamp < $4`,
          [subscriptionId, meterId, periodStart, periodEnd]
        );
        aggregatedValue = parseFloat(maxResult.rows[0].total);
        break;

      case 'last':
        const lastResult = await query<any>(
          `SELECT quantity
           FROM usage_records
           WHERE subscription_id = $1 AND meter_id = $2
             AND timestamp >= $3 AND timestamp < $4
           ORDER BY timestamp DESC
           LIMIT 1`,
          [subscriptionId, meterId, periodStart, periodEnd]
        );
        aggregatedValue = lastResult.rows.length > 0 ? parseFloat(lastResult.rows[0].quantity) : 0;
        break;

      case 'unique':
        // Count unique values based on deduplication key
        if (meter.deduplicationKey) {
          const uniqueResult = await query<any>(
            `SELECT COUNT(DISTINCT properties->$5) as total
             FROM usage_records
             WHERE subscription_id = $1 AND meter_id = $2
               AND timestamp >= $3 AND timestamp < $4`,
            [subscriptionId, meterId, periodStart, periodEnd, meter.deduplicationKey]
          );
          aggregatedValue = parseInt(uniqueResult.rows[0].total);
        } else {
          aggregatedValue = 0;
        }
        break;

      default:
        aggregatedValue = 0;
    }

    return aggregatedValue;
  }

  // Get detailed usage records for a period
  async getUsageRecords(
    subscriptionId: string,
    meterId: string,
    options?: {
      periodStart?: Date;
      periodEnd?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<UsageRecord[]> {
    let sql = `SELECT * FROM usage_records
               WHERE subscription_id = $1 AND meter_id = $2`;
    const params: any[] = [subscriptionId, meterId];
    let paramIndex = 3;

    if (options?.periodStart) {
      sql += ` AND timestamp >= $${paramIndex++}`;
      params.push(options.periodStart);
    }

    if (options?.periodEnd) {
      sql += ` AND timestamp < $${paramIndex++}`;
      params.push(options.periodEnd);
    }

    sql += ` ORDER BY timestamp DESC`;

    if (options?.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options?.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<any>(sql, params);

    return result.rows.map(row => ({
      id: row.id,
      meterId: row.meter_id,
      subscriptionId: row.subscription_id,
      customerId: row.customer_id,
      timestamp: row.timestamp,
      quantity: row.quantity,
      action: row.action,
      properties: row.properties,
      idempotencyKey: row.idempotency_key,
    }));
  }

  // ==========================================
  // BILLING CALCULATIONS
  // ==========================================

  // Calculate charges for metered usage
  async calculateCharges(
    subscriptionId: string,
    priceId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<SubscriptionItemUsage> {
    // Get price configuration
    const priceResult = await query<any>(
      `SELECT * FROM metered_prices WHERE id = $1`,
      [priceId]
    );

    if (priceResult.rows.length === 0) {
      throw new Error('Metered price not found');
    }

    const price: MeteredPrice = {
      id: priceResult.rows[0].id,
      productId: priceResult.rows[0].product_id,
      meterId: priceResult.rows[0].meter_id,
      currency: priceResult.rows[0].currency,
      billingScheme: priceResult.rows[0].billing_scheme,
      unitAmount: priceResult.rows[0].unit_amount,
      tiers: priceResult.rows[0].tiers,
      tiersMode: priceResult.rows[0].tiers_mode,
      transformQuantity: priceResult.rows[0].transform_quantity,
      aggregateUsage: priceResult.rows[0].aggregate_usage,
    };

    // Get usage
    let totalUsage = await this.getUsageSummary(
      subscriptionId,
      price.meterId,
      periodStart,
      periodEnd
    );

    // Transform quantity if configured
    if (price.transformQuantity) {
      totalUsage = totalUsage / price.transformQuantity.divideBy;
      if (price.transformQuantity.round === 'up') {
        totalUsage = Math.ceil(totalUsage);
      } else {
        totalUsage = Math.floor(totalUsage);
      }
    }

    // Calculate charges based on billing scheme
    let invoiceItems: SubscriptionItemUsage['invoiceItems'] = [];

    if (price.billingScheme === 'per_unit') {
      invoiceItems.push({
        quantity: totalUsage,
        unitAmount: price.unitAmount || 0,
        amount: totalUsage * (price.unitAmount || 0),
        description: `${totalUsage} units`,
      });
    } else if (price.billingScheme === 'tiered' && price.tiers) {
      if (price.tiersMode === 'graduated') {
        // Graduated: each tier applies to units within that range
        invoiceItems = this.calculateGraduatedTiers(totalUsage, price.tiers);
      } else {
        // Volume: single tier applies to all units
        invoiceItems = this.calculateVolumeTiers(totalUsage, price.tiers);
      }
    }

    return {
      subscriptionItemId: `si_${uuidv4().replace(/-/g, '').slice(0, 14)}`,
      meterId: price.meterId,
      periodStart,
      periodEnd,
      totalUsage,
      invoiceItems,
    };
  }

  // Calculate graduated tiered pricing
  private calculateGraduatedTiers(
    totalUsage: number,
    tiers: UsageTier[]
  ): SubscriptionItemUsage['invoiceItems'] {
    const items: SubscriptionItemUsage['invoiceItems'] = [];
    let remainingUsage = totalUsage;
    let previousUpTo = 0;

    for (const tier of tiers) {
      if (remainingUsage <= 0) break;

      const tierLimit = tier.upTo === null ? Infinity : tier.upTo;
      const tierRange = tierLimit - previousUpTo;
      const unitsInTier = Math.min(remainingUsage, tierRange);

      if (unitsInTier > 0) {
        let amount = unitsInTier * tier.unitAmount;
        if (tier.flatAmount) {
          amount += tier.flatAmount;
        }

        items.push({
          quantity: unitsInTier,
          unitAmount: tier.unitAmount,
          amount,
          description: `${unitsInTier} units @ ${tier.unitAmount / 100}/unit (tier ${previousUpTo + 1}-${tier.upTo || '∞'})`,
        });

        remainingUsage -= unitsInTier;
        previousUpTo = tierLimit;
      }
    }

    return items;
  }

  // Calculate volume tiered pricing
  private calculateVolumeTiers(
    totalUsage: number,
    tiers: UsageTier[]
  ): SubscriptionItemUsage['invoiceItems'] {
    // Find the applicable tier
    const applicableTier = tiers.find(tier =>
      tier.upTo === null || totalUsage <= tier.upTo
    ) || tiers[tiers.length - 1];

    let amount = totalUsage * applicableTier.unitAmount;
    if (applicableTier.flatAmount) {
      amount += applicableTier.flatAmount;
    }

    return [{
      quantity: totalUsage,
      unitAmount: applicableTier.unitAmount,
      amount,
      description: `${totalUsage} units @ ${applicableTier.unitAmount / 100}/unit`,
    }];
  }

  // ==========================================
  // METERED PRICE MANAGEMENT
  // ==========================================

  // Create metered price
  async createMeteredPrice(
    merchantId: string,
    input: {
      productId: string;
      meterId: string;
      currency: string;
      billingScheme: 'per_unit' | 'tiered';
      unitAmount?: number;
      tiers?: UsageTier[];
      tiersMode?: 'graduated' | 'volume';
      transformQuantity?: MeteredPrice['transformQuantity'];
      aggregateUsage?: MeteredPrice['aggregateUsage'];
    }
  ): Promise<MeteredPrice> {
    const priceId = `price_${uuidv4().replace(/-/g, '')}`;

    await query(
      `INSERT INTO metered_prices (
        id, merchant_id, product_id, meter_id, currency, billing_scheme,
        unit_amount, tiers, tiers_mode, transform_quantity, aggregate_usage, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        priceId,
        merchantId,
        input.productId,
        input.meterId,
        input.currency,
        input.billingScheme,
        input.unitAmount,
        JSON.stringify(input.tiers || []),
        input.tiersMode || 'graduated',
        JSON.stringify(input.transformQuantity || null),
        input.aggregateUsage || 'sum',
      ]
    );

    logger.info('Metered price created', { priceId, meterId: input.meterId });

    return {
      id: priceId,
      productId: input.productId,
      meterId: input.meterId,
      currency: input.currency,
      billingScheme: input.billingScheme,
      unitAmount: input.unitAmount,
      tiers: input.tiers,
      tiersMode: input.tiersMode,
      transformQuantity: input.transformQuantity,
      aggregateUsage: input.aggregateUsage,
    };
  }

  // ==========================================
  // REAL-TIME USAGE TRACKING
  // ==========================================

  // Get current period usage (for customer dashboard)
  async getCurrentPeriodUsage(subscriptionId: string): Promise<{
    meterId: string;
    meterName: string;
    usage: number;
    unit: string;
    periodStart: Date;
    periodEnd: Date;
  }[]> {
    // Get subscription billing period
    const subResult = await query<any>(
      `SELECT current_period_start, current_period_end FROM subscriptions WHERE id = $1`,
      [subscriptionId]
    );

    if (subResult.rows.length === 0) {
      throw new Error('Subscription not found');
    }

    const { current_period_start: periodStart, current_period_end: periodEnd } = subResult.rows[0];

    // Get all meters for this subscription
    const metersResult = await query<any>(
      `SELECT DISTINCT m.* FROM usage_meters m
       JOIN subscription_items si ON si.meter_id = m.id
       WHERE si.subscription_id = $1`,
      [subscriptionId]
    );

    const usageData = [];

    for (const meter of metersResult.rows) {
      const usage = await this.getUsageSummary(
        subscriptionId,
        meter.id,
        periodStart,
        periodEnd
      );

      usageData.push({
        meterId: meter.id,
        meterName: meter.display_name,
        usage,
        unit: meter.default_unit,
        periodStart,
        periodEnd,
      });
    }

    return usageData;
  }

  // Set usage alert threshold
  async setUsageAlert(
    subscriptionId: string,
    meterId: string,
    threshold: number,
    notifyEmail?: string
  ): Promise<void> {
    await query(
      `INSERT INTO usage_alerts (subscription_id, meter_id, threshold, notify_email, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (subscription_id, meter_id)
       DO UPDATE SET threshold = $3, notify_email = $4`,
      [subscriptionId, meterId, threshold, notifyEmail]
    );

    logger.info('Usage alert set', { subscriptionId, meterId, threshold });
  }

  // Check usage alerts and notify
  async checkUsageAlerts(): Promise<number> {
    const alerts = await query<any>(
      `SELECT ua.*, s.current_period_start, s.current_period_end
       FROM usage_alerts ua
       JOIN subscriptions s ON s.id = ua.subscription_id
       WHERE ua.last_notified_at IS NULL
          OR ua.last_notified_at < s.current_period_start`
    );

    let notified = 0;

    for (const alert of alerts.rows) {
      const usage = await this.getUsageSummary(
        alert.subscription_id,
        alert.meter_id,
        alert.current_period_start,
        alert.current_period_end
      );

      if (usage >= alert.threshold) {
        // Send notification
        await query(
          `UPDATE usage_alerts SET last_notified_at = NOW()
           WHERE subscription_id = $1 AND meter_id = $2`,
          [alert.subscription_id, alert.meter_id]
        );

        logger.info('Usage alert triggered', {
          subscriptionId: alert.subscription_id,
          meterId: alert.meter_id,
          usage,
          threshold: alert.threshold,
        });

        notified++;
      }
    }

    return notified;
  }
}

export const usageBillingService = new UsageBillingService();
