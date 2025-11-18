// Dunning Management Service
// Smart retry logic for failed subscription payments

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';

// Dunning configuration
export interface DunningConfig {
  merchantId: string;
  enabled: boolean;

  // Retry schedule
  retrySchedule: RetryAttempt[];

  // Smart retries
  smartRetries: {
    enabled: boolean;
    optimalTimeWindow: boolean; // Retry at time of previous successful payments
    cardUpdaterIntegration: boolean; // Auto-update expired cards
  };

  // Customer communication
  emails: {
    beforeRetry: boolean;
    afterFailure: boolean;
    beforeCancellation: boolean;
    paymentMethodExpiring: boolean;
  };

  // Grace period
  gracePeriodDays: number;

  // Final actions
  finalAction: 'cancel' | 'pause' | 'unpaid';
  cancelAtPeriodEnd: boolean;
}

export interface RetryAttempt {
  dayAfterFailure: number;
  preferredTime?: string; // HH:mm format
  emailBeforeRetry?: boolean;
}

// Dunning campaign (tracks a failed payment through retries)
export interface DunningCampaign {
  id: string;
  merchantId: string;
  subscriptionId: string;
  customerId: string;
  invoiceId: string;
  originalPaymentId: string;
  amountDue: number;
  currency: string;
  status: 'active' | 'recovered' | 'failed' | 'cancelled';
  attempts: DunningAttemptRecord[];
  nextRetryAt?: Date;
  graceEndsAt: Date;
  finalActionAt?: Date;
  recoveredAt?: Date;
  createdAt: Date;
}

export interface DunningAttemptRecord {
  attemptNumber: number;
  paymentId: string;
  attemptedAt: Date;
  status: 'succeeded' | 'failed';
  failureCode?: string;
  failureMessage?: string;
  emailSent?: boolean;
}

// Payment recovery statistics
export interface RecoveryStats {
  totalCampaigns: number;
  recovered: number;
  failed: number;
  active: number;
  recoveryRate: number;
  amountRecovered: number;
  amountLost: number;
  averageAttemptsToRecover: number;
}

export class DunningService {
  // Default retry schedule
  private defaultRetrySchedule: RetryAttempt[] = [
    { dayAfterFailure: 1, emailBeforeRetry: true },
    { dayAfterFailure: 3, emailBeforeRetry: true },
    { dayAfterFailure: 5, emailBeforeRetry: true },
    { dayAfterFailure: 7, emailBeforeRetry: true },
  ];

  // Configure dunning settings for a merchant
  async configureDunning(
    merchantId: string,
    config: Partial<Omit<DunningConfig, 'merchantId'>>
  ): Promise<DunningConfig> {
    const fullConfig: DunningConfig = {
      merchantId,
      enabled: config.enabled ?? true,
      retrySchedule: config.retrySchedule || this.defaultRetrySchedule,
      smartRetries: config.smartRetries || {
        enabled: true,
        optimalTimeWindow: true,
        cardUpdaterIntegration: true,
      },
      emails: config.emails || {
        beforeRetry: true,
        afterFailure: true,
        beforeCancellation: true,
        paymentMethodExpiring: true,
      },
      gracePeriodDays: config.gracePeriodDays ?? 7,
      finalAction: config.finalAction || 'cancel',
      cancelAtPeriodEnd: config.cancelAtPeriodEnd ?? false,
    };

    await query(
      `INSERT INTO dunning_configs (
        merchant_id, enabled, retry_schedule, smart_retries, emails,
        grace_period_days, final_action, cancel_at_period_end, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (merchant_id)
      DO UPDATE SET
        enabled = $2, retry_schedule = $3, smart_retries = $4, emails = $5,
        grace_period_days = $6, final_action = $7, cancel_at_period_end = $8,
        updated_at = NOW()`,
      [
        merchantId,
        fullConfig.enabled,
        JSON.stringify(fullConfig.retrySchedule),
        JSON.stringify(fullConfig.smartRetries),
        JSON.stringify(fullConfig.emails),
        fullConfig.gracePeriodDays,
        fullConfig.finalAction,
        fullConfig.cancelAtPeriodEnd,
      ]
    );

    logger.info('Dunning configured', { merchantId, enabled: fullConfig.enabled });

    return fullConfig;
  }

  // Get dunning configuration
  async getDunningConfig(merchantId: string): Promise<DunningConfig | null> {
    const result = await query<any>(
      `SELECT * FROM dunning_configs WHERE merchant_id = $1`,
      [merchantId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      merchantId: row.merchant_id,
      enabled: row.enabled,
      retrySchedule: row.retry_schedule,
      smartRetries: row.smart_retries,
      emails: row.emails,
      gracePeriodDays: row.grace_period_days,
      finalAction: row.final_action,
      cancelAtPeriodEnd: row.cancel_at_period_end,
    };
  }

  // Start dunning campaign for a failed payment
  async startCampaign(
    merchantId: string,
    input: {
      subscriptionId: string;
      customerId: string;
      invoiceId: string;
      paymentId: string;
      amountDue: number;
      currency: string;
      failureCode?: string;
      failureMessage?: string;
    }
  ): Promise<DunningCampaign> {
    const config = await this.getDunningConfig(merchantId);
    if (!config || !config.enabled) {
      throw new Error('Dunning not enabled for this merchant');
    }

    const campaignId = `dun_${uuidv4().replace(/-/g, '')}`;

    // Calculate next retry time
    const nextRetry = this.calculateNextRetry(config.retrySchedule, 0);
    const graceEnds = new Date(Date.now() + config.gracePeriodDays * 24 * 60 * 60 * 1000);

    // Initial attempt record
    const attempts: DunningAttemptRecord[] = [
      {
        attemptNumber: 1,
        paymentId: input.paymentId,
        attemptedAt: new Date(),
        status: 'failed',
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
      },
    ];

    await query(
      `INSERT INTO dunning_campaigns (
        id, merchant_id, subscription_id, customer_id, invoice_id,
        original_payment_id, amount_due, currency, status, attempts,
        next_retry_at, grace_ends_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, NOW())`,
      [
        campaignId, merchantId, input.subscriptionId, input.customerId,
        input.invoiceId, input.paymentId, input.amountDue, input.currency,
        JSON.stringify(attempts), nextRetry, graceEnds
      ]
    );

    // Send failure notification email
    if (config.emails.afterFailure) {
      await this.sendDunningEmail(input.customerId, 'payment_failed', {
        amount: input.amountDue,
        currency: input.currency,
        nextRetryAt: nextRetry,
      });
    }

    logger.info('Dunning campaign started', { campaignId, merchantId, subscriptionId: input.subscriptionId });

    return {
      id: campaignId,
      merchantId,
      subscriptionId: input.subscriptionId,
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      originalPaymentId: input.paymentId,
      amountDue: input.amountDue,
      currency: input.currency,
      status: 'active',
      attempts,
      nextRetryAt: nextRetry,
      graceEndsAt: graceEnds,
      createdAt: new Date(),
    };
  }

  // Process retry for a campaign
  async processRetry(campaignId: string): Promise<{
    success: boolean;
    newPaymentId?: string;
    error?: string;
  }> {
    // Get campaign
    const campaignResult = await query<any>(
      `SELECT * FROM dunning_campaigns WHERE id = $1 AND status = 'active'`,
      [campaignId]
    );

    if (campaignResult.rows.length === 0) {
      return { success: false, error: 'Campaign not found or not active' };
    }

    const campaign = campaignResult.rows[0];
    const config = await this.getDunningConfig(campaign.merchant_id);
    if (!config) {
      return { success: false, error: 'Dunning config not found' };
    }

    const attempts: DunningAttemptRecord[] = campaign.attempts;
    const attemptNumber = attempts.length + 1;

    // Determine optimal retry time if smart retries enabled
    let retryTime = new Date();
    if (config.smartRetries.optimalTimeWindow) {
      retryTime = await this.getOptimalRetryTime(campaign.customer_id);
    }

    // Attempt payment (would integrate with payment service)
    const paymentResult = await this.attemptPayment(
      campaign.merchant_id,
      campaign.customer_id,
      campaign.amount_due,
      campaign.currency
    );

    const newAttempt: DunningAttemptRecord = {
      attemptNumber,
      paymentId: paymentResult.paymentId || '',
      attemptedAt: new Date(),
      status: paymentResult.success ? 'succeeded' : 'failed',
      failureCode: paymentResult.failureCode,
      failureMessage: paymentResult.failureMessage,
    };

    attempts.push(newAttempt);

    if (paymentResult.success) {
      // Payment recovered!
      await query(
        `UPDATE dunning_campaigns
         SET status = 'recovered', attempts = $2, recovered_at = NOW()
         WHERE id = $1`,
        [campaignId, JSON.stringify(attempts)]
      );

      // Send recovery confirmation
      await this.sendDunningEmail(campaign.customer_id, 'payment_recovered', {
        amount: campaign.amount_due,
        currency: campaign.currency,
      });

      logger.info('Dunning campaign recovered', { campaignId, attemptNumber });

      return { success: true, newPaymentId: paymentResult.paymentId };
    } else {
      // Payment failed again
      const nextRetryIndex = attempts.length;
      const hasMoreRetries = nextRetryIndex < config.retrySchedule.length;

      if (hasMoreRetries) {
        // Schedule next retry
        const nextRetry = this.calculateNextRetry(config.retrySchedule, nextRetryIndex);

        await query(
          `UPDATE dunning_campaigns
           SET attempts = $2, next_retry_at = $3
           WHERE id = $1`,
          [campaignId, JSON.stringify(attempts), nextRetry]
        );

        // Send pre-retry email
        if (config.emails.beforeRetry) {
          await this.sendDunningEmail(campaign.customer_id, 'retry_scheduled', {
            amount: campaign.amount_due,
            currency: campaign.currency,
            nextRetryAt: nextRetry,
            attemptNumber,
          });
        }

        return {
          success: false,
          error: `Retry ${attemptNumber} failed, next retry scheduled for ${nextRetry.toISOString()}`,
        };
      } else {
        // All retries exhausted - take final action
        const finalActionAt = new Date();

        await query(
          `UPDATE dunning_campaigns
           SET status = 'failed', attempts = $2, final_action_at = $3
           WHERE id = $1`,
          [campaignId, JSON.stringify(attempts), finalActionAt]
        );

        // Execute final action
        await this.executeFinalAction(
          campaign.merchant_id,
          campaign.subscription_id,
          config.finalAction,
          config.cancelAtPeriodEnd
        );

        // Send cancellation email
        if (config.emails.beforeCancellation) {
          await this.sendDunningEmail(campaign.customer_id, 'subscription_cancelled', {
            subscriptionId: campaign.subscription_id,
            action: config.finalAction,
          });
        }

        logger.info('Dunning campaign failed', { campaignId, finalAction: config.finalAction });

        return {
          success: false,
          error: `All retries exhausted, ${config.finalAction} executed`,
        };
      }
    }
  }

  // Get campaigns due for retry
  async getCampaignsDueForRetry(): Promise<DunningCampaign[]> {
    const result = await query<any>(
      `SELECT * FROM dunning_campaigns
       WHERE status = 'active' AND next_retry_at <= NOW()
       ORDER BY next_retry_at ASC
       LIMIT 100`
    );

    return result.rows.map(this.mapCampaign);
  }

  // Get campaigns past grace period
  async getCampaignsPastGrace(): Promise<DunningCampaign[]> {
    const result = await query<any>(
      `SELECT * FROM dunning_campaigns
       WHERE status = 'active' AND grace_ends_at <= NOW()
       ORDER BY grace_ends_at ASC
       LIMIT 100`
    );

    return result.rows.map(this.mapCampaign);
  }

  // Cancel a dunning campaign
  async cancelCampaign(campaignId: string): Promise<void> {
    await query(
      `UPDATE dunning_campaigns SET status = 'cancelled' WHERE id = $1`,
      [campaignId]
    );

    logger.info('Dunning campaign cancelled', { campaignId });
  }

  // Get campaign by ID
  async getCampaign(campaignId: string): Promise<DunningCampaign | null> {
    const result = await query<any>(
      `SELECT * FROM dunning_campaigns WHERE id = $1`,
      [campaignId]
    );

    if (result.rows.length === 0) return null;
    return this.mapCampaign(result.rows[0]);
  }

  // Get campaigns for a subscription
  async getCampaignsForSubscription(subscriptionId: string): Promise<DunningCampaign[]> {
    const result = await query<any>(
      `SELECT * FROM dunning_campaigns
       WHERE subscription_id = $1
       ORDER BY created_at DESC`,
      [subscriptionId]
    );

    return result.rows.map(this.mapCampaign);
  }

  // Get recovery statistics for a merchant
  async getRecoveryStats(
    merchantId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<RecoveryStats> {
    const params: any[] = [merchantId];
    let dateFilter = '';

    if (startDate && endDate) {
      dateFilter = ` AND created_at >= $2 AND created_at <= $3`;
      params.push(startDate, endDate);
    }

    const result = await query<any>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'recovered') as recovered,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        SUM(amount_due) FILTER (WHERE status = 'recovered') as amount_recovered,
        SUM(amount_due) FILTER (WHERE status = 'failed') as amount_lost,
        AVG(jsonb_array_length(attempts)) FILTER (WHERE status = 'recovered') as avg_attempts
       FROM dunning_campaigns
       WHERE merchant_id = $1${dateFilter}`,
      params
    );

    const row = result.rows[0];
    const total = parseInt(row.total) || 0;
    const recovered = parseInt(row.recovered) || 0;

    return {
      totalCampaigns: total,
      recovered,
      failed: parseInt(row.failed) || 0,
      active: parseInt(row.active) || 0,
      recoveryRate: total > 0 ? (recovered / total) * 100 : 0,
      amountRecovered: parseInt(row.amount_recovered) || 0,
      amountLost: parseInt(row.amount_lost) || 0,
      averageAttemptsToRecover: parseFloat(row.avg_attempts) || 0,
    };
  }

  // Check and update expiring payment methods
  async checkExpiringPaymentMethods(merchantId: string): Promise<number> {
    // Find cards expiring in the next 30 days
    const result = await query<any>(
      `SELECT DISTINCT customer_id, card_last_four, exp_month, exp_year
       FROM payment_methods
       WHERE merchant_id = $1
         AND type = 'card'
         AND (exp_year * 100 + exp_month) <= $2
         AND notified_expiring = false`,
      [
        merchantId,
        (new Date().getFullYear() * 100) + new Date().getMonth() + 2 // Next month
      ]
    );

    let notified = 0;
    for (const row of result.rows) {
      await this.sendDunningEmail(row.customer_id, 'payment_method_expiring', {
        cardLastFour: row.card_last_four,
        expMonth: row.exp_month,
        expYear: row.exp_year,
      });

      await query(
        `UPDATE payment_methods
         SET notified_expiring = true
         WHERE merchant_id = $1 AND customer_id = $2`,
        [merchantId, row.customer_id]
      );

      notified++;
    }

    if (notified > 0) {
      logger.info('Sent expiring payment method notifications', { merchantId, count: notified });
    }

    return notified;
  }

  // Helper: Calculate next retry time
  private calculateNextRetry(schedule: RetryAttempt[], attemptIndex: number): Date {
    const attempt = schedule[attemptIndex];
    if (!attempt) {
      // No more scheduled retries
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days default
    }

    const retryDate = new Date();
    retryDate.setDate(retryDate.getDate() + attempt.dayAfterFailure);

    if (attempt.preferredTime) {
      const [hours, minutes] = attempt.preferredTime.split(':').map(Number);
      retryDate.setHours(hours, minutes, 0, 0);
    }

    return retryDate;
  }

  // Helper: Get optimal retry time based on customer's successful payment history
  private async getOptimalRetryTime(customerId: string): Promise<Date> {
    // Find the hour when customer has most successful payments
    const result = await query<any>(
      `SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count
       FROM payments
       WHERE customer_id = $1 AND status = 'succeeded'
       GROUP BY hour
       ORDER BY count DESC
       LIMIT 1`,
      [customerId]
    );

    const optimalHour = result.rows.length > 0 ? parseInt(result.rows[0].hour) : 10;

    const retryTime = new Date();
    retryTime.setHours(optimalHour, 0, 0, 0);

    // If that time has passed today, schedule for tomorrow
    if (retryTime <= new Date()) {
      retryTime.setDate(retryTime.getDate() + 1);
    }

    return retryTime;
  }

  // Helper: Attempt payment (placeholder - would integrate with payment service)
  private async attemptPayment(
    merchantId: string,
    customerId: string,
    amount: number,
    currency: string
  ): Promise<{
    success: boolean;
    paymentId?: string;
    failureCode?: string;
    failureMessage?: string;
  }> {
    // In production, would call the payment service to attempt the charge
    // This is a placeholder that simulates payment attempts
    const success = Math.random() > 0.3; // 70% success rate for simulation

    if (success) {
      return {
        success: true,
        paymentId: `pay_${uuidv4().replace(/-/g, '')}`,
      };
    } else {
      return {
        success: false,
        failureCode: 'card_declined',
        failureMessage: 'Your card was declined',
      };
    }
  }

  // Helper: Execute final action on subscription
  private async executeFinalAction(
    merchantId: string,
    subscriptionId: string,
    action: 'cancel' | 'pause' | 'unpaid',
    cancelAtPeriodEnd: boolean
  ): Promise<void> {
    // In production, would call subscription service
    switch (action) {
      case 'cancel':
        await query(
          `UPDATE subscriptions
           SET status = $2, cancelled_at = NOW()
           WHERE id = $1`,
          [subscriptionId, cancelAtPeriodEnd ? 'cancel_at_period_end' : 'cancelled']
        );
        break;
      case 'pause':
        await query(
          `UPDATE subscriptions SET status = 'paused' WHERE id = $1`,
          [subscriptionId]
        );
        break;
      case 'unpaid':
        await query(
          `UPDATE subscriptions SET status = 'unpaid' WHERE id = $1`,
          [subscriptionId]
        );
        break;
    }
  }

  // Helper: Send dunning email
  private async sendDunningEmail(
    customerId: string,
    emailType: string,
    data: Record<string, any>
  ): Promise<void> {
    // In production, would integrate with email service
    // Store email record for tracking
    await query(
      `INSERT INTO dunning_emails (customer_id, email_type, data, sent_at)
       VALUES ($1, $2, $3, NOW())`,
      [customerId, emailType, JSON.stringify(data)]
    );

    logger.info('Dunning email sent', { customerId, emailType });
  }

  // Helper: Map database row to campaign
  private mapCampaign(row: any): DunningCampaign {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      subscriptionId: row.subscription_id,
      customerId: row.customer_id,
      invoiceId: row.invoice_id,
      originalPaymentId: row.original_payment_id,
      amountDue: row.amount_due,
      currency: row.currency,
      status: row.status,
      attempts: row.attempts,
      nextRetryAt: row.next_retry_at,
      graceEndsAt: row.grace_ends_at,
      finalActionAt: row.final_action_at,
      recoveredAt: row.recovered_at,
      createdAt: row.created_at,
    };
  }
}

export const dunningService = new DunningService();
