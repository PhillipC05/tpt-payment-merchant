import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { getRedis } from '../../database/redis';

// Event types for type safety
export type PaymentEvent =
  | 'transaction.initiated'
  | 'transaction.completed'
  | 'transaction.failed'
  | 'transaction.refunded'
  | 'subscription.created'
  | 'subscription.renewed'
  | 'subscription.canceled'
  | 'subscription.payment_failed'
  | 'customer.created'
  | 'customer.updated'
  | 'payout.initiated'
  | 'payout.completed'
  | 'payout.failed'
  | 'fraud.detected'
  | 'dispute.opened'
  | 'dispute.resolved'
  | 'crypto.payment.received'
  | 'crypto.payment.confirmed'
  | 'invoice.created'
  | 'invoice.paid'
  | 'webhook.sent'
  | 'merchant.settings.updated';

export interface EventPayload {
  merchantId: string;
  timestamp: Date;
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

export type EventHandler = (payload: EventPayload) => Promise<void> | void;

class EventBus {
  private emitter: EventEmitter;
  private handlers: Map<string, Set<EventHandler>>;
  private isDistributed: boolean = false;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.handlers = new Map();
  }

  // Enable distributed mode for multi-instance deployments
  async enableDistributed(): Promise<void> {
    this.isDistributed = true;
    const redis = getRedis();

    // Subscribe to Redis pub/sub for distributed events
    const subscriber = redis.duplicate();
    await subscriber.subscribe('payment_events');

    subscriber.on('message', async (channel, message) => {
      if (channel === 'payment_events') {
        const { event, payload } = JSON.parse(message);
        await this.handleEvent(event, payload, true);
      }
    });

    logger.info('Event bus distributed mode enabled');
  }

  // Register an event handler
  on(event: PaymentEvent | PaymentEvent[], handler: EventHandler): () => void {
    const events = Array.isArray(event) ? event : [event];

    events.forEach(e => {
      if (!this.handlers.has(e)) {
        this.handlers.set(e, new Set());
      }
      this.handlers.get(e)!.add(handler);
    });

    // Return unsubscribe function
    return () => {
      events.forEach(e => {
        this.handlers.get(e)?.delete(handler);
      });
    };
  }

  // Register a one-time handler
  once(event: PaymentEvent, handler: EventHandler): void {
    const wrappedHandler: EventHandler = async (payload) => {
      this.handlers.get(event)?.delete(wrappedHandler);
      await handler(payload);
    };

    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(wrappedHandler);
  }

  // Emit an event
  async emit(event: PaymentEvent, payload: EventPayload): Promise<void> {
    // Add timestamp if not present
    payload.timestamp = payload.timestamp || new Date();

    logger.debug('Event emitted', { event, merchantId: payload.merchantId });

    // Publish to Redis for distributed mode
    if (this.isDistributed) {
      const redis = getRedis();
      await redis.publish('payment_events', JSON.stringify({ event, payload }));
    } else {
      await this.handleEvent(event, payload, false);
    }
  }

  // Handle event internally
  private async handleEvent(
    event: PaymentEvent,
    payload: EventPayload,
    fromRedis: boolean
  ): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.size === 0) return;

    // Execute all handlers concurrently
    const promises = Array.from(handlers).map(async (handler) => {
      try {
        await handler(payload);
      } catch (error) {
        logger.error('Event handler error', {
          event,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    await Promise.allSettled(promises);
  }

  // Get registered handlers count
  getHandlerCount(event?: PaymentEvent): number {
    if (event) {
      return this.handlers.get(event)?.size || 0;
    }
    let total = 0;
    this.handlers.forEach(set => total += set.size);
    return total;
  }

  // Clear all handlers (useful for testing)
  clear(): void {
    this.handlers.clear();
  }
}

// Singleton instance
export const eventBus = new EventBus();

// Helper to create typed event payloads
export function createEventPayload(
  merchantId: string,
  data: Record<string, any>,
  metadata?: Record<string, any>
): EventPayload {
  return {
    merchantId,
    timestamp: new Date(),
    data,
    metadata,
  };
}
