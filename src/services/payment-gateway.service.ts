import Stripe from 'stripe';
import { config } from '../config';
import { logger } from '../utils/logger';
import { GatewayError, PaymentError } from '../utils/errors';
import { CardDetails, PaymentMethodType } from '../types';

// Gateway interface for multiple payment providers
export interface PaymentGateway {
  name: string;
  createPaymentMethod(customerId: string, token: string): Promise<GatewayPaymentMethod>;
  charge(params: ChargeParams): Promise<GatewayChargeResult>;
  refund(params: RefundParams): Promise<GatewayRefundResult>;
  getBalance(): Promise<GatewayBalance>;
}

export interface GatewayPaymentMethod {
  id: string;
  type: PaymentMethodType;
  details: CardDetails;
}

export interface ChargeParams {
  amount: number;
  currency: string;
  paymentMethodId: string;
  description?: string;
  metadata?: Record<string, string>;
  capture?: boolean;
  idempotencyKey?: string;
}

export interface GatewayChargeResult {
  id: string;
  status: 'succeeded' | 'pending' | 'failed';
  amount: number;
  currency: string;
  paymentMethodId: string;
  captured: boolean;
  failureCode?: string;
  failureMessage?: string;
  rawResponse: any;
}

export interface RefundParams {
  chargeId: string;
  amount?: number;
  reason?: string;
  metadata?: Record<string, string>;
}

export interface GatewayRefundResult {
  id: string;
  status: 'succeeded' | 'pending' | 'failed';
  amount: number;
  currency: string;
  chargeId: string;
  failureReason?: string;
  rawResponse: any;
}

export interface GatewayBalance {
  available: { amount: number; currency: string }[];
  pending: { amount: number; currency: string }[];
}

// Stripe implementation
class StripeGateway implements PaymentGateway {
  name = 'stripe';
  private client: Stripe;

  constructor() {
    if (!config.stripeSecretKey) {
      throw new Error('Stripe secret key not configured');
    }
    this.client = new Stripe(config.stripeSecretKey, {
      apiVersion: '2023-10-16',
      typescript: true,
    });
  }

  async createPaymentMethod(customerId: string, token: string): Promise<GatewayPaymentMethod> {
    try {
      const paymentMethod = await this.client.paymentMethods.attach(token, {
        customer: customerId,
      });

      const card = paymentMethod.card!;
      return {
        id: paymentMethod.id,
        type: 'card',
        details: {
          brand: card.brand,
          last4: card.last4,
          expMonth: card.exp_month,
          expYear: card.exp_year,
          fingerprint: card.fingerprint || '',
          tokenId: paymentMethod.id,
        },
      };
    } catch (error) {
      this.handleStripeError(error);
      throw error;
    }
  }

  async charge(params: ChargeParams): Promise<GatewayChargeResult> {
    try {
      const paymentIntent = await this.client.paymentIntents.create({
        amount: params.amount,
        currency: params.currency.toLowerCase(),
        payment_method: params.paymentMethodId,
        description: params.description,
        metadata: params.metadata,
        confirm: true,
        capture_method: params.capture ? 'automatic' : 'manual',
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
      }, {
        idempotencyKey: params.idempotencyKey,
      });

      return {
        id: paymentIntent.id,
        status: paymentIntent.status === 'succeeded' ? 'succeeded' :
                paymentIntent.status === 'requires_capture' ? 'succeeded' : 'pending',
        amount: paymentIntent.amount,
        currency: paymentIntent.currency.toUpperCase(),
        paymentMethodId: paymentIntent.payment_method as string,
        captured: paymentIntent.status === 'succeeded',
        failureCode: paymentIntent.last_payment_error?.code,
        failureMessage: paymentIntent.last_payment_error?.message,
        rawResponse: paymentIntent,
      };
    } catch (error) {
      this.handleStripeError(error);
      throw error;
    }
  }

  async refund(params: RefundParams): Promise<GatewayRefundResult> {
    try {
      const refund = await this.client.refunds.create({
        payment_intent: params.chargeId,
        amount: params.amount,
        reason: params.reason as Stripe.RefundCreateParams.Reason,
        metadata: params.metadata,
      });

      return {
        id: refund.id,
        status: refund.status === 'succeeded' ? 'succeeded' :
                refund.status === 'pending' ? 'pending' : 'failed',
        amount: refund.amount,
        currency: refund.currency.toUpperCase(),
        chargeId: params.chargeId,
        failureReason: refund.failure_reason || undefined,
        rawResponse: refund,
      };
    } catch (error) {
      this.handleStripeError(error);
      throw error;
    }
  }

  async getBalance(): Promise<GatewayBalance> {
    try {
      const balance = await this.client.balance.retrieve();

      return {
        available: balance.available.map(b => ({
          amount: b.amount,
          currency: b.currency.toUpperCase(),
        })),
        pending: balance.pending.map(b => ({
          amount: b.amount,
          currency: b.currency.toUpperCase(),
        })),
      };
    } catch (error) {
      this.handleStripeError(error);
      throw error;
    }
  }

  async createCustomer(email: string, name?: string, metadata?: Record<string, string>): Promise<string> {
    try {
      const customer = await this.client.customers.create({
        email,
        name,
        metadata,
      });
      return customer.id;
    } catch (error) {
      this.handleStripeError(error);
      throw error;
    }
  }

  async capturePayment(paymentIntentId: string, amount?: number): Promise<GatewayChargeResult> {
    try {
      const paymentIntent = await this.client.paymentIntents.capture(
        paymentIntentId,
        amount ? { amount_to_capture: amount } : {}
      );

      return {
        id: paymentIntent.id,
        status: 'succeeded',
        amount: paymentIntent.amount_received,
        currency: paymentIntent.currency.toUpperCase(),
        paymentMethodId: paymentIntent.payment_method as string,
        captured: true,
        rawResponse: paymentIntent,
      };
    } catch (error) {
      this.handleStripeError(error);
      throw error;
    }
  }

  private handleStripeError(error: unknown): never {
    if (error instanceof Stripe.errors.StripeError) {
      logger.error('Stripe error', {
        type: error.type,
        code: error.code,
        message: error.message,
      });

      switch (error.type) {
        case 'StripeCardError':
          throw new PaymentError(error.message, error.code || 'CARD_ERROR', {
            decline_code: (error as any).decline_code,
          });
        case 'StripeInvalidRequestError':
          throw new PaymentError(error.message, 'INVALID_REQUEST');
        case 'StripeAPIError':
          throw new GatewayError('Payment gateway error', { provider: 'stripe' });
        case 'StripeConnectionError':
          throw new GatewayError('Could not connect to payment gateway');
        case 'StripeAuthenticationError':
          throw new GatewayError('Payment gateway authentication failed');
        case 'StripeRateLimitError':
          throw new GatewayError('Payment gateway rate limit exceeded');
        default:
          throw new GatewayError(error.message);
      }
    }
    throw error;
  }
}

// Mock gateway for testing
class MockGateway implements PaymentGateway {
  name = 'mock';

  async createPaymentMethod(customerId: string, token: string): Promise<GatewayPaymentMethod> {
    return {
      id: `pm_mock_${Date.now()}`,
      type: 'card',
      details: {
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2025,
        fingerprint: 'mock_fingerprint',
        tokenId: token,
      },
    };
  }

  async charge(params: ChargeParams): Promise<GatewayChargeResult> {
    // Simulate failures for specific amounts
    if (params.amount === 99999) {
      return {
        id: `pi_mock_${Date.now()}`,
        status: 'failed',
        amount: params.amount,
        currency: params.currency,
        paymentMethodId: params.paymentMethodId,
        captured: false,
        failureCode: 'card_declined',
        failureMessage: 'Your card was declined.',
        rawResponse: {},
      };
    }

    return {
      id: `pi_mock_${Date.now()}`,
      status: 'succeeded',
      amount: params.amount,
      currency: params.currency,
      paymentMethodId: params.paymentMethodId,
      captured: params.capture !== false,
      rawResponse: {},
    };
  }

  async refund(params: RefundParams): Promise<GatewayRefundResult> {
    return {
      id: `re_mock_${Date.now()}`,
      status: 'succeeded',
      amount: params.amount || 0,
      currency: 'USD',
      chargeId: params.chargeId,
      rawResponse: {},
    };
  }

  async getBalance(): Promise<GatewayBalance> {
    return {
      available: [{ amount: 1000000, currency: 'USD' }],
      pending: [{ amount: 50000, currency: 'USD' }],
    };
  }
}

// Gateway factory
let gatewayInstance: PaymentGateway | null = null;

export function getPaymentGateway(): PaymentGateway {
  if (!gatewayInstance) {
    if (config.nodeEnv === 'test' || !config.stripeSecretKey) {
      logger.info('Using mock payment gateway');
      gatewayInstance = new MockGateway();
    } else {
      logger.info('Using Stripe payment gateway');
      gatewayInstance = new StripeGateway();
    }
  }
  return gatewayInstance;
}

export function getStripeGateway(): StripeGateway {
  if (!config.stripeSecretKey) {
    throw new Error('Stripe not configured');
  }
  return new StripeGateway();
}
