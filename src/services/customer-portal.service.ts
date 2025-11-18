// Customer Portal Service
// Self-service subscription management for customers

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

// Portal session
export interface PortalSession {
  id: string;
  merchantId: string;
  customerId: string;
  url: string;
  returnUrl: string;
  expiresAt: Date;
  createdAt: Date;
}

// Portal configuration
export interface PortalConfiguration {
  merchantId: string;
  businessProfile: {
    headline?: string;
    privacyPolicyUrl?: string;
    termsOfServiceUrl?: string;
  };
  features: PortalFeatures;
  defaultReturnUrl: string;
  metadata?: Record<string, string>;
}

export interface PortalFeatures {
  customerUpdate: {
    enabled: boolean;
    allowedUpdates: ('email' | 'address' | 'phone' | 'tax_id')[];
  };
  invoiceHistory: {
    enabled: boolean;
  };
  paymentMethodUpdate: {
    enabled: boolean;
  };
  subscriptionCancel: {
    enabled: boolean;
    mode: 'at_period_end' | 'immediately';
    cancellationReason: {
      enabled: boolean;
      options: CancellationReason[];
    };
    prorationBehavior?: 'create_prorations' | 'none';
  };
  subscriptionPause: {
    enabled: boolean;
  };
  subscriptionUpdate: {
    enabled: boolean;
    defaultAllowedUpdates: ('price' | 'quantity' | 'promotion_code')[];
    products: PortalProductConfig[];
    prorationBehavior: 'create_prorations' | 'none' | 'always_invoice';
  };
}

export interface PortalProductConfig {
  productId: string;
  prices: string[]; // Price IDs customer can switch to
}

export type CancellationReason =
  | 'too_expensive'
  | 'missing_features'
  | 'switched_service'
  | 'unused'
  | 'customer_service'
  | 'too_complex'
  | 'low_quality'
  | 'other';

// Customer portal data
export interface PortalData {
  customer: {
    id: string;
    email: string;
    name?: string;
    phone?: string;
    address?: any;
  };
  subscriptions: PortalSubscription[];
  invoices: PortalInvoice[];
  paymentMethods: PortalPaymentMethod[];
  upcomingInvoice?: PortalInvoice;
}

export interface PortalSubscription {
  id: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  items: {
    id: string;
    productName: string;
    priceId: string;
    quantity: number;
    unitAmount: number;
    currency: string;
    interval: string;
  }[];
  defaultPaymentMethod?: string;
}

export interface PortalInvoice {
  id: string;
  number: string;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: Date;
  dueDate?: Date;
  hostedInvoiceUrl?: string;
  pdfUrl?: string;
}

export interface PortalPaymentMethod {
  id: string;
  type: string;
  card?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  };
  isDefault: boolean;
}

// Flow types for tracking customer actions
export interface PortalFlow {
  type: 'payment_method_update' | 'subscription_cancel' | 'subscription_update';
  afterCompletion?: {
    type: 'redirect' | 'hosted_confirmation';
    redirect?: { returnUrl: string };
  };
  subscriptionCancel?: {
    subscriptionId: string;
  };
  subscriptionUpdate?: {
    subscriptionId: string;
  };
}

export class CustomerPortalService {
  // ==========================================
  // PORTAL CONFIGURATION
  // ==========================================

  // Create or update portal configuration
  async configurePortal(
    merchantId: string,
    config: Omit<PortalConfiguration, 'merchantId'>
  ): Promise<PortalConfiguration> {
    const fullConfig: PortalConfiguration = {
      merchantId,
      ...config,
    };

    await query(
      `INSERT INTO portal_configurations (
        merchant_id, business_profile, features, default_return_url, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (merchant_id)
      DO UPDATE SET
        business_profile = $2, features = $3, default_return_url = $4,
        metadata = $5, updated_at = NOW()`,
      [
        merchantId,
        JSON.stringify(config.businessProfile),
        JSON.stringify(config.features),
        config.defaultReturnUrl,
        JSON.stringify(config.metadata || {}),
      ]
    );

    logger.info('Portal configured', { merchantId });

    return fullConfig;
  }

  // Get portal configuration
  async getConfiguration(merchantId: string): Promise<PortalConfiguration | null> {
    const result = await query<any>(
      `SELECT * FROM portal_configurations WHERE merchant_id = $1`,
      [merchantId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      merchantId: row.merchant_id,
      businessProfile: row.business_profile,
      features: row.features,
      defaultReturnUrl: row.default_return_url,
      metadata: row.metadata,
    };
  }

  // ==========================================
  // PORTAL SESSIONS
  // ==========================================

  // Create a portal session
  async createSession(
    merchantId: string,
    customerId: string,
    options?: {
      returnUrl?: string;
      flow?: PortalFlow;
      locale?: string;
    }
  ): Promise<PortalSession> {
    const config = await this.getConfiguration(merchantId);
    if (!config) {
      throw new Error('Portal not configured for this merchant');
    }

    const sessionId = `bps_${uuidv4().replace(/-/g, '')}`;
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const returnUrl = options?.returnUrl || config.defaultReturnUrl;
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    // Generate portal URL
    const portalUrl = `https://billing.example.com/p/${sessionId}?token=${sessionToken}`;

    await query(
      `INSERT INTO portal_sessions (
        id, merchant_id, customer_id, session_token, url, return_url,
        flow, locale, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        sessionId,
        merchantId,
        customerId,
        sessionToken,
        portalUrl,
        returnUrl,
        JSON.stringify(options?.flow || null),
        options?.locale || 'auto',
        expiresAt,
      ]
    );

    logger.info('Portal session created', { sessionId, merchantId, customerId });

    return {
      id: sessionId,
      merchantId,
      customerId,
      url: portalUrl,
      returnUrl,
      expiresAt,
      createdAt: new Date(),
    };
  }

  // Validate portal session
  async validateSession(
    sessionId: string,
    sessionToken: string
  ): Promise<{ valid: boolean; customerId?: string; merchantId?: string }> {
    const result = await query<any>(
      `SELECT * FROM portal_sessions
       WHERE id = $1 AND session_token = $2 AND expires_at > NOW()`,
      [sessionId, sessionToken]
    );

    if (result.rows.length === 0) {
      return { valid: false };
    }

    return {
      valid: true,
      customerId: result.rows[0].customer_id,
      merchantId: result.rows[0].merchant_id,
    };
  }

  // ==========================================
  // PORTAL DATA
  // ==========================================

  // Get all portal data for a customer
  async getPortalData(merchantId: string, customerId: string): Promise<PortalData> {
    // Get customer info
    const customerResult = await query<any>(
      `SELECT * FROM customers WHERE id = $1 AND merchant_id = $2`,
      [customerId, merchantId]
    );

    if (customerResult.rows.length === 0) {
      throw new Error('Customer not found');
    }

    const customer = customerResult.rows[0];

    // Get subscriptions
    const subscriptions = await this.getCustomerSubscriptions(merchantId, customerId);

    // Get invoices
    const invoices = await this.getCustomerInvoices(merchantId, customerId);

    // Get payment methods
    const paymentMethods = await this.getCustomerPaymentMethods(merchantId, customerId);

    // Get upcoming invoice
    const upcomingInvoice = await this.getUpcomingInvoice(merchantId, customerId);

    return {
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
      },
      subscriptions,
      invoices,
      paymentMethods,
      upcomingInvoice,
    };
  }

  // Get customer subscriptions
  private async getCustomerSubscriptions(
    merchantId: string,
    customerId: string
  ): Promise<PortalSubscription[]> {
    const result = await query<any>(
      `SELECT s.*,
        json_agg(json_build_object(
          'id', si.id,
          'price_id', si.price_id,
          'quantity', si.quantity,
          'product_name', p.name,
          'unit_amount', pr.unit_amount,
          'currency', pr.currency,
          'interval', pr.recurring_interval
        )) as items
       FROM subscriptions s
       LEFT JOIN subscription_items si ON si.subscription_id = s.id
       LEFT JOIN prices pr ON pr.id = si.price_id
       LEFT JOIN products p ON p.id = pr.product_id
       WHERE s.customer_id = $1 AND s.merchant_id = $2
         AND s.status IN ('active', 'past_due', 'trialing', 'paused')
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [customerId, merchantId]
    );

    return result.rows.map(row => ({
      id: row.id,
      status: row.status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      items: row.items.filter((i: any) => i.id),
      defaultPaymentMethod: row.default_payment_method,
    }));
  }

  // Get customer invoices
  private async getCustomerInvoices(
    merchantId: string,
    customerId: string
  ): Promise<PortalInvoice[]> {
    const result = await query<any>(
      `SELECT * FROM invoices
       WHERE customer_id = $1 AND merchant_id = $2
       ORDER BY created_at DESC
       LIMIT 24`, // Last 24 invoices
      [customerId, merchantId]
    );

    return result.rows.map(row => ({
      id: row.id,
      number: row.number,
      status: row.status,
      amountDue: row.amount_due,
      amountPaid: row.amount_paid,
      currency: row.currency,
      created: row.created_at,
      dueDate: row.due_date,
      hostedInvoiceUrl: row.hosted_invoice_url,
      pdfUrl: row.pdf_url,
    }));
  }

  // Get customer payment methods
  private async getCustomerPaymentMethods(
    merchantId: string,
    customerId: string
  ): Promise<PortalPaymentMethod[]> {
    const result = await query<any>(
      `SELECT pm.*, c.default_payment_method_id
       FROM payment_methods pm
       JOIN customers c ON c.id = pm.customer_id
       WHERE pm.customer_id = $1 AND pm.merchant_id = $2`,
      [customerId, merchantId]
    );

    return result.rows.map(row => ({
      id: row.id,
      type: row.type,
      card: row.type === 'card' ? {
        brand: row.card_brand,
        last4: row.card_last_four,
        expMonth: row.exp_month,
        expYear: row.exp_year,
      } : undefined,
      isDefault: row.id === row.default_payment_method_id,
    }));
  }

  // Get upcoming invoice preview
  private async getUpcomingInvoice(
    merchantId: string,
    customerId: string
  ): Promise<PortalInvoice | undefined> {
    // Get active subscription and calculate next invoice
    const subResult = await query<any>(
      `SELECT * FROM subscriptions
       WHERE customer_id = $1 AND merchant_id = $2 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [customerId, merchantId]
    );

    if (subResult.rows.length === 0) return undefined;

    const sub = subResult.rows[0];

    // Calculate upcoming invoice amount from subscription items
    const itemsResult = await query<any>(
      `SELECT SUM(si.quantity * p.unit_amount) as total, p.currency
       FROM subscription_items si
       JOIN prices p ON p.id = si.price_id
       WHERE si.subscription_id = $1
       GROUP BY p.currency`,
      [sub.id]
    );

    if (itemsResult.rows.length === 0) return undefined;

    return {
      id: `upcoming_${sub.id}`,
      number: 'Upcoming',
      status: 'draft',
      amountDue: parseInt(itemsResult.rows[0].total) || 0,
      amountPaid: 0,
      currency: itemsResult.rows[0].currency,
      created: new Date(),
      dueDate: sub.current_period_end,
    };
  }

  // ==========================================
  // CUSTOMER ACTIONS
  // ==========================================

  // Update customer information
  async updateCustomer(
    merchantId: string,
    customerId: string,
    updates: {
      email?: string;
      name?: string;
      phone?: string;
      address?: any;
    }
  ): Promise<void> {
    const config = await this.getConfiguration(merchantId);
    if (!config) {
      throw new Error('Portal not configured');
    }

    // Validate allowed updates
    const allowedUpdates = config.features.customerUpdate.allowedUpdates;
    if (updates.email && !allowedUpdates.includes('email')) {
      throw new Error('Email updates not allowed');
    }
    if (updates.phone && !allowedUpdates.includes('phone')) {
      throw new Error('Phone updates not allowed');
    }
    if (updates.address && !allowedUpdates.includes('address')) {
      throw new Error('Address updates not allowed');
    }

    const setClauses: string[] = [];
    const params: any[] = [customerId, merchantId];
    let paramIndex = 3;

    if (updates.email) {
      setClauses.push(`email = $${paramIndex++}`);
      params.push(updates.email);
    }
    if (updates.name) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.phone) {
      setClauses.push(`phone = $${paramIndex++}`);
      params.push(updates.phone);
    }
    if (updates.address) {
      setClauses.push(`address = $${paramIndex++}`);
      params.push(JSON.stringify(updates.address));
    }

    if (setClauses.length > 0) {
      await query(
        `UPDATE customers SET ${setClauses.join(', ')}, updated_at = NOW()
         WHERE id = $1 AND merchant_id = $2`,
        params
      );
    }

    logger.info('Customer updated via portal', { merchantId, customerId, updates: Object.keys(updates) });
  }

  // Cancel subscription
  async cancelSubscription(
    merchantId: string,
    customerId: string,
    subscriptionId: string,
    options?: {
      reason?: CancellationReason;
      feedback?: string;
      cancelAtPeriodEnd?: boolean;
    }
  ): Promise<void> {
    const config = await this.getConfiguration(merchantId);
    if (!config || !config.features.subscriptionCancel.enabled) {
      throw new Error('Subscription cancellation not allowed');
    }

    // Verify subscription belongs to customer
    const subResult = await query<any>(
      `SELECT * FROM subscriptions WHERE id = $1 AND customer_id = $2 AND merchant_id = $3`,
      [subscriptionId, customerId, merchantId]
    );

    if (subResult.rows.length === 0) {
      throw new Error('Subscription not found');
    }

    const cancelAtPeriodEnd = options?.cancelAtPeriodEnd ??
      (config.features.subscriptionCancel.mode === 'at_period_end');

    if (cancelAtPeriodEnd) {
      await query(
        `UPDATE subscriptions
         SET cancel_at_period_end = true, cancellation_reason = $4, cancellation_feedback = $5
         WHERE id = $1`,
        [subscriptionId, options?.reason, options?.feedback]
      );
    } else {
      await query(
        `UPDATE subscriptions
         SET status = 'cancelled', cancelled_at = NOW(),
             cancellation_reason = $4, cancellation_feedback = $5
         WHERE id = $1`,
        [subscriptionId, options?.reason, options?.feedback]
      );
    }

    // Store cancellation details
    await query(
      `INSERT INTO subscription_cancellations (
        subscription_id, customer_id, reason, feedback, cancel_at_period_end, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [subscriptionId, customerId, options?.reason, options?.feedback, cancelAtPeriodEnd]
    );

    logger.info('Subscription cancelled via portal', {
      merchantId, customerId, subscriptionId,
      reason: options?.reason, cancelAtPeriodEnd
    });
  }

  // Pause subscription
  async pauseSubscription(
    merchantId: string,
    customerId: string,
    subscriptionId: string,
    options?: {
      resumeAt?: Date;
    }
  ): Promise<void> {
    const config = await this.getConfiguration(merchantId);
    if (!config || !config.features.subscriptionPause.enabled) {
      throw new Error('Subscription pause not allowed');
    }

    await query(
      `UPDATE subscriptions
       SET status = 'paused', paused_at = NOW(), resume_at = $4
       WHERE id = $1 AND customer_id = $2 AND merchant_id = $3`,
      [subscriptionId, customerId, merchantId, options?.resumeAt]
    );

    logger.info('Subscription paused via portal', { merchantId, customerId, subscriptionId });
  }

  // Update subscription (change plan)
  async updateSubscription(
    merchantId: string,
    customerId: string,
    subscriptionId: string,
    updates: {
      priceId?: string;
      quantity?: number;
      promotionCode?: string;
    }
  ): Promise<{ prorationAmount?: number }> {
    const config = await this.getConfiguration(merchantId);
    if (!config || !config.features.subscriptionUpdate.enabled) {
      throw new Error('Subscription updates not allowed');
    }

    // Verify subscription
    const subResult = await query<any>(
      `SELECT * FROM subscriptions WHERE id = $1 AND customer_id = $2 AND merchant_id = $3`,
      [subscriptionId, customerId, merchantId]
    );

    if (subResult.rows.length === 0) {
      throw new Error('Subscription not found');
    }

    // Validate price is allowed
    if (updates.priceId) {
      const allowedProducts = config.features.subscriptionUpdate.products;
      const priceAllowed = allowedProducts.some(p =>
        p.prices.includes(updates.priceId!)
      );

      if (!priceAllowed) {
        throw new Error('Price not allowed for this subscription');
      }
    }

    // Calculate proration if needed
    let prorationAmount = 0;
    if (config.features.subscriptionUpdate.prorationBehavior === 'create_prorations') {
      // Calculate proration (simplified)
      const sub = subResult.rows[0];
      const daysLeft = Math.ceil(
        (new Date(sub.current_period_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      const totalDays = 30; // Simplified

      if (updates.priceId) {
        const newPriceResult = await query<any>(
          `SELECT unit_amount FROM prices WHERE id = $1`,
          [updates.priceId]
        );
        const oldPriceResult = await query<any>(
          `SELECT p.unit_amount FROM subscription_items si
           JOIN prices p ON p.id = si.price_id
           WHERE si.subscription_id = $1`,
          [subscriptionId]
        );

        if (newPriceResult.rows.length > 0 && oldPriceResult.rows.length > 0) {
          const newPrice = newPriceResult.rows[0].unit_amount;
          const oldPrice = oldPriceResult.rows[0].unit_amount;
          prorationAmount = Math.round(((newPrice - oldPrice) * daysLeft) / totalDays);
        }
      }
    }

    // Apply updates
    if (updates.priceId) {
      await query(
        `UPDATE subscription_items SET price_id = $2 WHERE subscription_id = $1`,
        [subscriptionId, updates.priceId]
      );
    }

    if (updates.quantity !== undefined) {
      await query(
        `UPDATE subscription_items SET quantity = $2 WHERE subscription_id = $1`,
        [subscriptionId, updates.quantity]
      );
    }

    logger.info('Subscription updated via portal', {
      merchantId, customerId, subscriptionId,
      updates, prorationAmount
    });

    return { prorationAmount: prorationAmount > 0 ? prorationAmount : undefined };
  }

  // Add payment method
  async addPaymentMethod(
    merchantId: string,
    customerId: string,
    paymentMethodId: string,
    setAsDefault?: boolean
  ): Promise<void> {
    const config = await this.getConfiguration(merchantId);
    if (!config || !config.features.paymentMethodUpdate.enabled) {
      throw new Error('Payment method updates not allowed');
    }

    // Attach payment method to customer
    await query(
      `UPDATE payment_methods
       SET customer_id = $2
       WHERE id = $1 AND merchant_id = $3`,
      [paymentMethodId, customerId, merchantId]
    );

    if (setAsDefault) {
      await query(
        `UPDATE customers SET default_payment_method_id = $2 WHERE id = $1`,
        [customerId, paymentMethodId]
      );
    }

    logger.info('Payment method added via portal', { merchantId, customerId, paymentMethodId });
  }

  // Remove payment method
  async removePaymentMethod(
    merchantId: string,
    customerId: string,
    paymentMethodId: string
  ): Promise<void> {
    // Check it's not the default for an active subscription
    const subResult = await query<any>(
      `SELECT id FROM subscriptions
       WHERE customer_id = $1 AND default_payment_method = $2 AND status = 'active'`,
      [customerId, paymentMethodId]
    );

    if (subResult.rows.length > 0) {
      throw new Error('Cannot remove payment method used by active subscription');
    }

    await query(
      `DELETE FROM payment_methods WHERE id = $1 AND customer_id = $2 AND merchant_id = $3`,
      [paymentMethodId, customerId, merchantId]
    );

    logger.info('Payment method removed via portal', { merchantId, customerId, paymentMethodId });
  }

  // Set default payment method
  async setDefaultPaymentMethod(
    merchantId: string,
    customerId: string,
    paymentMethodId: string
  ): Promise<void> {
    await query(
      `UPDATE customers
       SET default_payment_method_id = $3
       WHERE id = $1 AND merchant_id = $2`,
      [customerId, merchantId, paymentMethodId]
    );

    logger.info('Default payment method set via portal', { merchantId, customerId, paymentMethodId });
  }
}

export const customerPortalService = new CustomerPortalService();
