// Hosted Checkout and UI Components Service
// Stripe Checkout / Paddle Checkout equivalent

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';

// Checkout session configuration
export interface CheckoutSessionInput {
  mode: 'payment' | 'subscription' | 'setup';
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  customerId?: string;
  clientReferenceId?: string;
  metadata?: Record<string, string>;

  // Payment options
  paymentMethodTypes?: PaymentMethodType[];
  currency?: string;

  // Subscription options
  subscriptionData?: {
    trialPeriodDays?: number;
    metadata?: Record<string, string>;
  };

  // Customization
  locale?: string;
  submitType?: 'auto' | 'pay' | 'book' | 'donate';

  // Tax
  automaticTax?: boolean;
  taxIdCollection?: boolean;

  // Shipping
  shippingAddressCollection?: {
    allowedCountries: string[];
  };
  shippingOptions?: ShippingOption[];

  // Discounts
  allowPromotionCodes?: boolean;
  discounts?: { coupon?: string; promotionCode?: string }[];

  // Consent
  consentCollection?: {
    terms?: 'required' | 'none';
    promotions?: 'auto' | 'none';
  };

  // Expiration
  expiresAt?: Date;

  // Custom fields
  customFields?: CustomField[];

  // Phone number
  phoneNumberCollection?: boolean;
}

export interface CheckoutLineItem {
  priceId?: string;
  quantity: number;

  // Or inline price data
  priceData?: {
    currency: string;
    productData: {
      name: string;
      description?: string;
      images?: string[];
      metadata?: Record<string, string>;
    };
    unitAmount: number;
    recurring?: {
      interval: 'day' | 'week' | 'month' | 'year';
      intervalCount?: number;
    };
  };

  adjustableQuantity?: {
    enabled: boolean;
    minimum?: number;
    maximum?: number;
  };

  taxRates?: string[];
}

export interface ShippingOption {
  shippingRateData: {
    displayName: string;
    type: 'fixed_amount';
    fixedAmount: {
      amount: number;
      currency: string;
    };
    deliveryEstimate?: {
      minimum?: { unit: 'day' | 'week' | 'month'; value: number };
      maximum?: { unit: 'day' | 'week' | 'month'; value: number };
    };
  };
}

export interface CustomField {
  key: string;
  label: { type: 'custom'; custom: string };
  type: 'text' | 'dropdown' | 'numeric';
  optional?: boolean;
  dropdown?: { options: { label: string; value: string }[] };
}

export type PaymentMethodType =
  | 'card'
  | 'ach_debit'
  | 'apple_pay'
  | 'google_pay'
  | 'sepa_debit'
  | 'ideal'
  | 'bancontact'
  | 'giropay'
  | 'sofort'
  | 'eps'
  | 'p24'
  | 'klarna'
  | 'afterpay_clearpay'
  | 'alipay'
  | 'wechat_pay'
  | 'crypto';

export interface CheckoutSession {
  id: string;
  merchantId: string;
  mode: string;
  url: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'unpaid' | 'paid' | 'no_payment_required';
  customerEmail?: string;
  customerId?: string;
  amountTotal: number;
  amountSubtotal: number;
  currency: string;
  lineItems: CheckoutLineItem[];
  paymentIntentId?: string;
  subscriptionId?: string;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
  createdAt: Date;
}

// Payment Element configuration
export interface PaymentElementConfig {
  merchantId: string;
  appearance?: PaymentElementAppearance;
  layout?: 'tabs' | 'accordion' | 'auto';
  defaultValues?: {
    billingDetails?: {
      name?: string;
      email?: string;
      phone?: string;
      address?: {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
      };
    };
  };
  business?: {
    name?: string;
  };
  paymentMethodOrder?: PaymentMethodType[];
  fields?: {
    billingDetails?: 'auto' | 'never';
  };
  wallets?: {
    applePay?: 'auto' | 'never';
    googlePay?: 'auto' | 'never';
  };
}

export interface PaymentElementAppearance {
  theme?: 'stripe' | 'night' | 'flat' | 'none';
  variables?: {
    colorPrimary?: string;
    colorBackground?: string;
    colorText?: string;
    colorDanger?: string;
    fontFamily?: string;
    spacingUnit?: string;
    borderRadius?: string;
    fontSizeBase?: string;
  };
  rules?: Record<string, Record<string, string>>;
}

// Pricing Table configuration
export interface PricingTableConfig {
  merchantId: string;
  products: PricingTableProduct[];
  appearance?: {
    theme?: 'light' | 'dark';
    primaryColor?: string;
    fontFamily?: string;
  };
  features?: string[];
  highlightedProductId?: string;
}

export interface PricingTableProduct {
  productId: string;
  prices: {
    monthly?: string;
    yearly?: string;
  };
  features: string[];
  callToAction?: string;
  highlighted?: boolean;
}

export class CheckoutService {
  // Create a checkout session
  async createSession(
    merchantId: string,
    input: CheckoutSessionInput
  ): Promise<CheckoutSession> {
    const sessionId = `cs_${uuidv4().replace(/-/g, '')}`;

    // Calculate totals
    let amountSubtotal = 0;
    for (const item of input.lineItems) {
      if (item.priceData) {
        amountSubtotal += item.priceData.unitAmount * item.quantity;
      } else if (item.priceId) {
        // Fetch price from database
        const priceResult = await query<any>(
          `SELECT unit_amount FROM prices WHERE id = $1`,
          [item.priceId]
        );
        if (priceResult.rows.length > 0) {
          amountSubtotal += priceResult.rows[0].unit_amount * item.quantity;
        }
      }
    }

    // Apply automatic tax if enabled
    let taxAmount = 0;
    if (input.automaticTax) {
      // Would integrate with tax service
      taxAmount = Math.round(amountSubtotal * 0.08); // Placeholder
    }

    const amountTotal = amountSubtotal + taxAmount;
    const currency = input.currency || 'usd';

    // Set expiration (default 24 hours)
    const expiresAt = input.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Generate checkout URL
    const checkoutUrl = `https://checkout.example.com/c/${sessionId}`;

    // Store session
    await query(
      `INSERT INTO checkout_sessions (
        id, merchant_id, mode, url, status, payment_status,
        customer_email, customer_id, amount_total, amount_subtotal,
        currency, line_items, success_url, cancel_url, expires_at,
        metadata, payment_method_types, allow_promotion_codes,
        shipping_address_collection, shipping_options, custom_fields,
        locale, automatic_tax, tax_id_collection, consent_collection,
        phone_number_collection, subscription_data, created_at
      ) VALUES (
        $1, $2, $3, $4, 'open', 'unpaid',
        $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW()
      )`,
      [
        sessionId, merchantId, input.mode, checkoutUrl,
        input.customerEmail, input.customerId, amountTotal, amountSubtotal,
        currency, JSON.stringify(input.lineItems), input.successUrl, input.cancelUrl,
        expiresAt, JSON.stringify(input.metadata || {}),
        JSON.stringify(input.paymentMethodTypes || ['card']),
        input.allowPromotionCodes || false,
        JSON.stringify(input.shippingAddressCollection || null),
        JSON.stringify(input.shippingOptions || []),
        JSON.stringify(input.customFields || []),
        input.locale || 'auto',
        input.automaticTax || false,
        input.taxIdCollection || false,
        JSON.stringify(input.consentCollection || {}),
        input.phoneNumberCollection || false,
        JSON.stringify(input.subscriptionData || {})
      ]
    );

    logger.info('Checkout session created', { sessionId, merchantId, mode: input.mode });

    return {
      id: sessionId,
      merchantId,
      mode: input.mode,
      url: checkoutUrl,
      status: 'open',
      paymentStatus: 'unpaid',
      customerEmail: input.customerEmail,
      customerId: input.customerId,
      amountTotal,
      amountSubtotal,
      currency,
      lineItems: input.lineItems,
      expiresAt,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: input.metadata,
      createdAt: new Date(),
    };
  }

  // Retrieve a session
  async getSession(sessionId: string): Promise<CheckoutSession | null> {
    const result = await query<any>(
      `SELECT * FROM checkout_sessions WHERE id = $1`,
      [sessionId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      merchantId: row.merchant_id,
      mode: row.mode,
      url: row.url,
      status: row.status,
      paymentStatus: row.payment_status,
      customerEmail: row.customer_email,
      customerId: row.customer_id,
      amountTotal: row.amount_total,
      amountSubtotal: row.amount_subtotal,
      currency: row.currency,
      lineItems: row.line_items,
      paymentIntentId: row.payment_intent_id,
      subscriptionId: row.subscription_id,
      expiresAt: row.expires_at,
      successUrl: row.success_url,
      cancelUrl: row.cancel_url,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  // Expire a session
  async expireSession(sessionId: string): Promise<void> {
    await query(
      `UPDATE checkout_sessions SET status = 'expired' WHERE id = $1`,
      [sessionId]
    );

    logger.info('Checkout session expired', { sessionId });
  }

  // Complete a session (called after successful payment)
  async completeSession(
    sessionId: string,
    paymentIntentId?: string,
    subscriptionId?: string
  ): Promise<void> {
    await query(
      `UPDATE checkout_sessions
       SET status = 'complete', payment_status = 'paid',
           payment_intent_id = $2, subscription_id = $3
       WHERE id = $1`,
      [sessionId, paymentIntentId, subscriptionId]
    );

    logger.info('Checkout session completed', { sessionId, paymentIntentId, subscriptionId });
  }

  // List sessions for a merchant
  async listSessions(
    merchantId: string,
    options?: {
      status?: string;
      customerId?: string;
      limit?: number;
      startingAfter?: string;
    }
  ): Promise<CheckoutSession[]> {
    let sql = `SELECT * FROM checkout_sessions WHERE merchant_id = $1`;
    const params: any[] = [merchantId];
    let paramIndex = 2;

    if (options?.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(options.status);
    }

    if (options?.customerId) {
      sql += ` AND customer_id = $${paramIndex++}`;
      params.push(options.customerId);
    }

    if (options?.startingAfter) {
      sql += ` AND id < $${paramIndex++}`;
      params.push(options.startingAfter);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(options?.limit || 10);

    const result = await query<any>(sql, params);

    return result.rows.map(row => ({
      id: row.id,
      merchantId: row.merchant_id,
      mode: row.mode,
      url: row.url,
      status: row.status,
      paymentStatus: row.payment_status,
      customerEmail: row.customer_email,
      customerId: row.customer_id,
      amountTotal: row.amount_total,
      amountSubtotal: row.amount_subtotal,
      currency: row.currency,
      lineItems: row.line_items,
      paymentIntentId: row.payment_intent_id,
      subscriptionId: row.subscription_id,
      expiresAt: row.expires_at,
      successUrl: row.success_url,
      cancelUrl: row.cancel_url,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
  }

  // Generate embeddable Payment Element configuration
  generatePaymentElementConfig(
    merchantId: string,
    config?: Partial<PaymentElementConfig>
  ): { clientSecret: string; config: PaymentElementConfig } {
    const clientSecret = `pi_${uuidv4().replace(/-/g, '')}_secret_${uuidv4().replace(/-/g, '').slice(0, 24)}`;

    const elementConfig: PaymentElementConfig = {
      merchantId,
      appearance: config?.appearance || {
        theme: 'stripe',
        variables: {
          colorPrimary: '#0570de',
          colorBackground: '#ffffff',
          colorText: '#30313d',
          colorDanger: '#df1b41',
          fontFamily: 'system-ui, sans-serif',
          spacingUnit: '4px',
          borderRadius: '4px',
        },
      },
      layout: config?.layout || 'tabs',
      defaultValues: config?.defaultValues,
      business: config?.business,
      paymentMethodOrder: config?.paymentMethodOrder || ['card', 'apple_pay', 'google_pay'],
      fields: config?.fields || { billingDetails: 'auto' },
      wallets: config?.wallets || { applePay: 'auto', googlePay: 'auto' },
    };

    return { clientSecret, config: elementConfig };
  }

  // Generate Pricing Table embed code
  generatePricingTable(config: PricingTableConfig): string {
    const tableId = `pt_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // Store pricing table config
    query(
      `INSERT INTO pricing_tables (id, merchant_id, config, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [tableId, config.merchantId, JSON.stringify(config)]
    ).catch(err => logger.error('Failed to store pricing table', { err }));

    // Return embed script
    return `<script async src="https://js.example.com/v1/pricing-table.js"></script>
<pricing-table pricing-table-id="${tableId}" publishable-key="pk_live_..."></pricing-table>`;
  }

  // Generate Buy Button embed code
  generateBuyButton(
    merchantId: string,
    options: {
      priceId: string;
      quantity?: number;
      style?: 'light' | 'dark';
      text?: string;
    }
  ): string {
    const buttonId = `bb_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    return `<script async src="https://js.example.com/v1/buy-button.js"></script>
<buy-button
  buy-button-id="${buttonId}"
  publishable-key="pk_live_..."
  price-id="${options.priceId}"
  ${options.quantity ? `quantity="${options.quantity}"` : ''}
  ${options.style ? `style="${options.style}"` : ''}
>
  ${options.text || 'Buy Now'}
</buy-button>`;
  }

  // Process expired sessions (cron job)
  async processExpiredSessions(): Promise<number> {
    const result = await query(
      `UPDATE checkout_sessions
       SET status = 'expired'
       WHERE status = 'open' AND expires_at < NOW()
       RETURNING id`
    );

    const count = result.rowCount || 0;
    if (count > 0) {
      logger.info(`Expired ${count} checkout sessions`);
    }

    return count;
  }
}

export const checkoutService = new CheckoutService();
