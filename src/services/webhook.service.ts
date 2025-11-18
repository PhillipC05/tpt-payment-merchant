import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { merchantService } from './merchant.service';
import { logger } from '../utils/logger';
import { generateWebhookSignature } from '../utils/encryption';
import { WebhookEvent, WebhookEventType, WebhookStatus } from '../types';
import { config } from '../config';
import { Queue, Worker } from 'bullmq';
import { getRedis } from '../database/redis';

const RETRY_DELAYS = [60, 300, 900, 3600, 7200]; // 1m, 5m, 15m, 1h, 2h

export class WebhookService {
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  async initialize(): Promise<void> {
    const connection = getRedis();

    this.queue = new Queue('webhooks', {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'custom',
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });

    this.worker = new Worker(
      'webhooks',
      async (job) => {
        const { eventId } = job.data;
        await this.deliver(eventId);
      },
      {
        connection,
        concurrency: 10,
      }
    );

    this.worker.on('failed', (job, error) => {
      logger.error('Webhook delivery failed', {
        jobId: job?.id,
        error: error.message,
      });
    });

    logger.info('Webhook service initialized');
  }

  async send(
    merchantId: string,
    type: WebhookEventType,
    payload: Record<string, any>
  ): Promise<string> {
    const eventId = uuidv4();

    // Store event
    await query(
      `INSERT INTO webhook_events (id, merchant_id, type, status, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, merchantId, type, 'pending', JSON.stringify(payload)]
    );

    // Queue for delivery
    if (this.queue) {
      await this.queue.add('deliver', { eventId }, {
        jobId: eventId,
      });
    } else {
      // Fallback: deliver synchronously
      await this.deliver(eventId);
    }

    logger.info('Webhook event created', { eventId, type, merchantId });

    return eventId;
  }

  async deliver(eventId: string): Promise<boolean> {
    // Get event
    const eventResult = await query<any>(
      'SELECT * FROM webhook_events WHERE id = $1',
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      throw new Error(`Webhook event ${eventId} not found`);
    }

    const event = eventResult.rows[0];

    // Get merchant webhook URL
    const merchant = await merchantService.findById(event.merchant_id);

    if (!merchant.webhookUrl) {
      logger.warn('Merchant has no webhook URL configured', {
        merchantId: merchant.id,
        eventId,
      });
      return false;
    }

    // Get webhook secret
    const secret = await merchantService.getWebhookSecret(merchant.id);
    if (!secret) {
      logger.error('Merchant webhook secret not found', {
        merchantId: merchant.id,
      });
      return false;
    }

    // Prepare payload
    const webhookPayload = {
      id: eventId,
      type: event.type,
      created: new Date(event.created_at).toISOString(),
      data: typeof event.payload === 'string'
        ? JSON.parse(event.payload)
        : event.payload,
    };

    const payloadString = JSON.stringify(webhookPayload);
    const signature = generateWebhookSignature(payloadString, secret);

    try {
      const response = await axios.post(merchant.webhookUrl, webhookPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Id': eventId,
          'User-Agent': 'TPT-Payment-Merchant/1.0',
        },
        timeout: config.webhookTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300,
      });

      // Mark as delivered
      await query(
        `UPDATE webhook_events SET
          status = 'delivered',
          delivered_at = NOW(),
          attempts = attempts + 1,
          last_attempt_at = NOW(),
          response = $1
        WHERE id = $2`,
        [
          JSON.stringify({
            status: response.status,
            headers: response.headers,
          }),
          eventId,
        ]
      );

      logger.info('Webhook delivered', { eventId, url: merchant.webhookUrl });
      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const attempts = event.attempts + 1;

      // Calculate next retry
      let nextRetry: Date | null = null;
      if (attempts < RETRY_DELAYS.length) {
        nextRetry = new Date(Date.now() + RETRY_DELAYS[attempts] * 1000);
      }

      // Update event
      await query(
        `UPDATE webhook_events SET
          status = $1,
          attempts = $2,
          last_attempt_at = NOW(),
          next_retry_at = $3,
          response = $4
        WHERE id = $5`,
        [
          nextRetry ? 'pending' : 'failed',
          attempts,
          nextRetry,
          JSON.stringify({ error: errorMessage }),
          eventId,
        ]
      );

      logger.error('Webhook delivery failed', {
        eventId,
        attempts,
        error: errorMessage,
        nextRetry: nextRetry?.toISOString(),
      });

      if (nextRetry && this.queue) {
        // Schedule retry
        await this.queue.add('deliver', { eventId }, {
          jobId: `${eventId}-retry-${attempts}`,
          delay: RETRY_DELAYS[attempts - 1] * 1000,
        });
      }

      return false;
    }
  }

  async getEvents(
    merchantId: string,
    limit: number = 50
  ): Promise<WebhookEvent[]> {
    const result = await query<any>(
      `SELECT * FROM webhook_events
       WHERE merchant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [merchantId, limit]
    );

    return result.rows.map(row => this.mapEvent(row));
  }

  async getEvent(eventId: string, merchantId: string): Promise<WebhookEvent> {
    const result = await query<any>(
      `SELECT * FROM webhook_events
       WHERE id = $1 AND merchant_id = $2`,
      [eventId, merchantId]
    );

    if (result.rows.length === 0) {
      throw new Error('Webhook event not found');
    }

    return this.mapEvent(result.rows[0]);
  }

  async retry(eventId: string, merchantId: string): Promise<boolean> {
    const event = await this.getEvent(eventId, merchantId);

    if (event.status === 'delivered') {
      return true;
    }

    // Reset status and retry
    await query(
      `UPDATE webhook_events SET status = 'pending' WHERE id = $1`,
      [eventId]
    );

    return this.deliver(eventId);
  }

  async shutdown(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    if (this.queue) {
      await this.queue.close();
    }
    logger.info('Webhook service shut down');
  }

  private mapEvent(row: any): WebhookEvent {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      type: row.type,
      status: row.status,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,
      deliveredAt: row.delivered_at,
      nextRetryAt: row.next_retry_at,
      response: row.response,
      createdAt: row.created_at,
    };
  }
}

export const webhookService = new WebhookService();
