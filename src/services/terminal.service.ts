// Terminal/POS Service
// In-person payments with card readers and point-of-sale

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';

// Terminal/Reader device
export interface Reader {
  id: string;
  merchantId: string;
  locationId: string;
  label: string;
  serialNumber: string;
  deviceType: ReaderDeviceType;
  status: 'online' | 'offline';
  ipAddress?: string;
  deviceSwVersion?: string;
  livemodePIN?: string;
  lastSeenAt?: Date;
  createdAt: Date;
}

export type ReaderDeviceType =
  | 'bbpos_wisepos_e'
  | 'stripe_m2'
  | 'bbpos_chipper2x'
  | 'verifone_P400'
  | 'simulated';

// Location for in-person payments
export interface Location {
  id: string;
  merchantId: string;
  displayName: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
  metadata?: Record<string, string>;
  createdAt: Date;
}

// Connection token for SDK
export interface ConnectionToken {
  secret: string;
  locationId?: string;
}

// Payment intent for terminal
export interface TerminalPaymentIntent {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'processing' | 'succeeded' | 'cancelled';
  captureMethod: 'automatic' | 'manual';
  statementDescriptor?: string;
  receiptEmail?: string;
  metadata?: Record<string, string>;
  paymentMethod?: TerminalPaymentMethod;
  createdAt: Date;
}

export interface TerminalPaymentMethod {
  id: string;
  type: 'card_present' | 'interac_present';
  cardPresent?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    funding: 'credit' | 'debit' | 'prepaid' | 'unknown';
    readMethod: 'contact_emv' | 'contactless_emv' | 'magnetic_stripe_track2' | 'contactless_magstripe';
    receipt?: CardPresentReceipt;
  };
}

export interface CardPresentReceipt {
  accountType?: 'credit' | 'checking' | 'savings';
  applicationPreferredName?: string;
  applicationCryptogram?: string;
  authorizationCode?: string;
  authorizationResponseCode?: string;
  dedicatedFileName?: string;
  terminalVerificationResults?: string;
  transactionStatusInformation?: string;
}

// Reader action
export interface ReaderAction {
  type: 'process_payment_intent' | 'set_reader_display' | 'refund_payment';
  status: 'in_progress' | 'succeeded' | 'failed';
  failureCode?: string;
  failureMessage?: string;
  processPaymentIntent?: {
    paymentIntentId: string;
  };
  setReaderDisplay?: {
    type: 'cart';
    cart: CartDisplay;
  };
  refundPayment?: {
    refundId: string;
    paymentIntentId: string;
    amount: number;
  };
}

// Cart display for reader screen
export interface CartDisplay {
  lineItems: CartLineItem[];
  tax?: number;
  total: number;
  currency: string;
}

export interface CartLineItem {
  description: string;
  amount: number;
  quantity: number;
}

// Simulated reader for testing
export interface SimulatedReaderConfig {
  testCardNumber?: string;
  presentedPaymentMethod?: string;
}

export class TerminalService {
  // ==========================================
  // LOCATIONS
  // ==========================================

  // Create a location
  async createLocation(
    merchantId: string,
    input: {
      displayName: string;
      address: Location['address'];
      metadata?: Record<string, string>;
    }
  ): Promise<Location> {
    const locationId = `loc_${uuidv4().replace(/-/g, '')}`;

    await query(
      `INSERT INTO terminal_locations (
        id, merchant_id, display_name, address, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [locationId, merchantId, input.displayName, JSON.stringify(input.address),
       JSON.stringify(input.metadata || {})]
    );

    logger.info('Terminal location created', { locationId, merchantId });

    return {
      id: locationId,
      merchantId,
      displayName: input.displayName,
      address: input.address,
      metadata: input.metadata,
      createdAt: new Date(),
    };
  }

  // List locations
  async listLocations(merchantId: string): Promise<Location[]> {
    const result = await query<any>(
      `SELECT * FROM terminal_locations WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [merchantId]
    );

    return result.rows.map(row => ({
      id: row.id,
      merchantId: row.merchant_id,
      displayName: row.display_name,
      address: row.address,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
  }

  // Update location
  async updateLocation(
    locationId: string,
    updates: {
      displayName?: string;
      address?: Partial<Location['address']>;
      metadata?: Record<string, string>;
    }
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: any[] = [locationId];
    let paramIndex = 2;

    if (updates.displayName) {
      setClauses.push(`display_name = $${paramIndex++}`);
      params.push(updates.displayName);
    }
    if (updates.address) {
      setClauses.push(`address = address || $${paramIndex++}`);
      params.push(JSON.stringify(updates.address));
    }
    if (updates.metadata) {
      setClauses.push(`metadata = $${paramIndex++}`);
      params.push(JSON.stringify(updates.metadata));
    }

    if (setClauses.length > 0) {
      await query(
        `UPDATE terminal_locations SET ${setClauses.join(', ')} WHERE id = $1`,
        params
      );
    }
  }

  // Delete location
  async deleteLocation(locationId: string): Promise<void> {
    // Check for readers at this location
    const readers = await query<any>(
      `SELECT id FROM terminal_readers WHERE location_id = $1`,
      [locationId]
    );

    if (readers.rows.length > 0) {
      throw new Error('Cannot delete location with registered readers');
    }

    await query(`DELETE FROM terminal_locations WHERE id = $1`, [locationId]);
    logger.info('Terminal location deleted', { locationId });
  }

  // ==========================================
  // READERS
  // ==========================================

  // Register a reader
  async registerReader(
    merchantId: string,
    input: {
      registrationCode: string;
      locationId: string;
      label?: string;
    }
  ): Promise<Reader> {
    // In production, would validate registration code with device
    const readerId = `tmr_${uuidv4().replace(/-/g, '')}`;
    const serialNumber = `SN_${uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase()}`;

    // Determine device type from registration code prefix
    let deviceType: ReaderDeviceType = 'bbpos_wisepos_e';
    if (input.registrationCode.startsWith('simulated')) {
      deviceType = 'simulated';
    }

    await query(
      `INSERT INTO terminal_readers (
        id, merchant_id, location_id, label, serial_number,
        device_type, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'offline', NOW())`,
      [readerId, merchantId, input.locationId, input.label || `Reader ${readerId.slice(-4)}`,
       serialNumber, deviceType]
    );

    logger.info('Terminal reader registered', { readerId, merchantId, deviceType });

    return {
      id: readerId,
      merchantId,
      locationId: input.locationId,
      label: input.label || `Reader ${readerId.slice(-4)}`,
      serialNumber,
      deviceType,
      status: 'offline',
      createdAt: new Date(),
    };
  }

  // List readers
  async listReaders(
    merchantId: string,
    options?: {
      locationId?: string;
      status?: 'online' | 'offline';
    }
  ): Promise<Reader[]> {
    let sql = `SELECT * FROM terminal_readers WHERE merchant_id = $1`;
    const params: any[] = [merchantId];
    let paramIndex = 2;

    if (options?.locationId) {
      sql += ` AND location_id = $${paramIndex++}`;
      params.push(options.locationId);
    }

    if (options?.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(options.status);
    }

    sql += ` ORDER BY created_at DESC`;

    const result = await query<any>(sql, params);

    return result.rows.map(row => ({
      id: row.id,
      merchantId: row.merchant_id,
      locationId: row.location_id,
      label: row.label,
      serialNumber: row.serial_number,
      deviceType: row.device_type,
      status: row.status,
      ipAddress: row.ip_address,
      deviceSwVersion: row.device_sw_version,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    }));
  }

  // Get reader
  async getReader(readerId: string): Promise<Reader | null> {
    const result = await query<any>(
      `SELECT * FROM terminal_readers WHERE id = $1`,
      [readerId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      merchantId: row.merchant_id,
      locationId: row.location_id,
      label: row.label,
      serialNumber: row.serial_number,
      deviceType: row.device_type,
      status: row.status,
      ipAddress: row.ip_address,
      deviceSwVersion: row.device_sw_version,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  }

  // Update reader status
  async updateReaderStatus(
    readerId: string,
    status: 'online' | 'offline',
    ipAddress?: string
  ): Promise<void> {
    await query(
      `UPDATE terminal_readers
       SET status = $2, ip_address = $3, last_seen_at = NOW()
       WHERE id = $1`,
      [readerId, status, ipAddress]
    );
  }

  // Delete reader
  async deleteReader(readerId: string): Promise<void> {
    await query(`DELETE FROM terminal_readers WHERE id = $1`, [readerId]);
    logger.info('Terminal reader deleted', { readerId });
  }

  // ==========================================
  // CONNECTION TOKENS
  // ==========================================

  // Create connection token for Terminal SDK
  async createConnectionToken(
    merchantId: string,
    locationId?: string
  ): Promise<ConnectionToken> {
    const secret = `pst_${uuidv4().replace(/-/g, '')}`;

    // Store token (expires in 1 hour)
    await query(
      `INSERT INTO terminal_connection_tokens (
        secret, merchant_id, location_id, expires_at, created_at
      ) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour', NOW())`,
      [secret, merchantId, locationId]
    );

    return {
      secret,
      locationId,
    };
  }

  // Validate connection token
  async validateConnectionToken(secret: string): Promise<{
    valid: boolean;
    merchantId?: string;
    locationId?: string;
  }> {
    const result = await query<any>(
      `SELECT * FROM terminal_connection_tokens
       WHERE secret = $1 AND expires_at > NOW()`,
      [secret]
    );

    if (result.rows.length === 0) {
      return { valid: false };
    }

    return {
      valid: true,
      merchantId: result.rows[0].merchant_id,
      locationId: result.rows[0].location_id,
    };
  }

  // ==========================================
  // PAYMENT PROCESSING
  // ==========================================

  // Create payment intent for terminal
  async createPaymentIntent(
    merchantId: string,
    input: {
      amount: number;
      currency: string;
      captureMethod?: 'automatic' | 'manual';
      statementDescriptor?: string;
      receiptEmail?: string;
      metadata?: Record<string, string>;
    }
  ): Promise<TerminalPaymentIntent> {
    const intentId = `pi_${uuidv4().replace(/-/g, '')}`;

    await query(
      `INSERT INTO terminal_payment_intents (
        id, merchant_id, amount, currency, status, capture_method,
        statement_descriptor, receipt_email, metadata, created_at
      ) VALUES ($1, $2, $3, $4, 'requires_payment_method', $5, $6, $7, $8, NOW())`,
      [
        intentId, merchantId, input.amount, input.currency,
        input.captureMethod || 'automatic', input.statementDescriptor,
        input.receiptEmail, JSON.stringify(input.metadata || {})
      ]
    );

    logger.info('Terminal payment intent created', { intentId, merchantId, amount: input.amount });

    return {
      id: intentId,
      merchantId,
      amount: input.amount,
      currency: input.currency,
      status: 'requires_payment_method',
      captureMethod: input.captureMethod || 'automatic',
      statementDescriptor: input.statementDescriptor,
      receiptEmail: input.receiptEmail,
      metadata: input.metadata,
      createdAt: new Date(),
    };
  }

  // Process payment intent on reader
  async processPaymentIntent(
    readerId: string,
    paymentIntentId: string
  ): Promise<ReaderAction> {
    const reader = await this.getReader(readerId);
    if (!reader) {
      throw new Error('Reader not found');
    }

    if (reader.status !== 'online') {
      throw new Error('Reader is offline');
    }

    // Update payment intent status
    await query(
      `UPDATE terminal_payment_intents SET status = 'requires_confirmation' WHERE id = $1`,
      [paymentIntentId]
    );

    // Store action
    const actionId = `ract_${uuidv4().replace(/-/g, '')}`;
    await query(
      `INSERT INTO terminal_reader_actions (
        id, reader_id, type, status, payment_intent_id, created_at
      ) VALUES ($1, $2, 'process_payment_intent', 'in_progress', $3, NOW())`,
      [actionId, readerId, paymentIntentId]
    );

    logger.info('Processing payment on reader', { readerId, paymentIntentId });

    return {
      type: 'process_payment_intent',
      status: 'in_progress',
      processPaymentIntent: {
        paymentIntentId,
      },
    };
  }

  // Collect payment method from reader (called after card presented)
  async collectPaymentMethod(
    paymentIntentId: string,
    paymentMethod: TerminalPaymentMethod
  ): Promise<TerminalPaymentIntent> {
    await query(
      `UPDATE terminal_payment_intents
       SET status = 'requires_confirmation', payment_method = $2
       WHERE id = $1`,
      [paymentIntentId, JSON.stringify(paymentMethod)]
    );

    const result = await query<any>(
      `SELECT * FROM terminal_payment_intents WHERE id = $1`,
      [paymentIntentId]
    );

    return this.mapPaymentIntent(result.rows[0]);
  }

  // Confirm payment intent
  async confirmPaymentIntent(paymentIntentId: string): Promise<TerminalPaymentIntent> {
    // Process payment
    await query(
      `UPDATE terminal_payment_intents SET status = 'processing' WHERE id = $1`,
      [paymentIntentId]
    );

    // In production, would process with payment processor
    // Simulate success
    await query(
      `UPDATE terminal_payment_intents SET status = 'succeeded' WHERE id = $1`,
      [paymentIntentId]
    );

    const result = await query<any>(
      `SELECT * FROM terminal_payment_intents WHERE id = $1`,
      [paymentIntentId]
    );

    logger.info('Terminal payment succeeded', { paymentIntentId });

    return this.mapPaymentIntent(result.rows[0]);
  }

  // Cancel payment intent
  async cancelPaymentIntent(paymentIntentId: string): Promise<void> {
    await query(
      `UPDATE terminal_payment_intents SET status = 'cancelled' WHERE id = $1`,
      [paymentIntentId]
    );

    logger.info('Terminal payment cancelled', { paymentIntentId });
  }

  // Capture payment (for manual capture)
  async capturePayment(
    paymentIntentId: string,
    amountToCapture?: number
  ): Promise<TerminalPaymentIntent> {
    const result = await query<any>(
      `SELECT * FROM terminal_payment_intents WHERE id = $1`,
      [paymentIntentId]
    );

    if (result.rows.length === 0) {
      throw new Error('Payment intent not found');
    }

    const intent = result.rows[0];
    if (intent.capture_method !== 'manual') {
      throw new Error('Payment intent was already captured automatically');
    }

    const captureAmount = amountToCapture || intent.amount;

    // Would process capture with payment processor
    await query(
      `UPDATE terminal_payment_intents
       SET amount = $2, status = 'succeeded'
       WHERE id = $1`,
      [paymentIntentId, captureAmount]
    );

    logger.info('Terminal payment captured', { paymentIntentId, amount: captureAmount });

    return this.mapPaymentIntent({
      ...intent,
      amount: captureAmount,
      status: 'succeeded',
    });
  }

  // ==========================================
  // READER DISPLAY
  // ==========================================

  // Set reader display to show cart
  async setReaderDisplay(
    readerId: string,
    cart: CartDisplay
  ): Promise<ReaderAction> {
    const reader = await this.getReader(readerId);
    if (!reader) {
      throw new Error('Reader not found');
    }

    // Store action
    const actionId = `ract_${uuidv4().replace(/-/g, '')}`;
    await query(
      `INSERT INTO terminal_reader_actions (
        id, reader_id, type, status, display_cart, created_at
      ) VALUES ($1, $2, 'set_reader_display', 'succeeded', $3, NOW())`,
      [actionId, readerId, JSON.stringify(cart)]
    );

    logger.info('Reader display set', { readerId, total: cart.total });

    return {
      type: 'set_reader_display',
      status: 'succeeded',
      setReaderDisplay: {
        type: 'cart',
        cart,
      },
    };
  }

  // Clear reader display
  async clearReaderDisplay(readerId: string): Promise<void> {
    // Would send command to clear display
    logger.info('Reader display cleared', { readerId });
  }

  // ==========================================
  // REFUNDS
  // ==========================================

  // Refund a terminal payment
  async refundPayment(
    paymentIntentId: string,
    amount?: number,
    reverseTransfer?: boolean
  ): Promise<ReaderAction> {
    const intentResult = await query<any>(
      `SELECT * FROM terminal_payment_intents WHERE id = $1 AND status = 'succeeded'`,
      [paymentIntentId]
    );

    if (intentResult.rows.length === 0) {
      throw new Error('Payment intent not found or not succeeded');
    }

    const intent = intentResult.rows[0];
    const refundAmount = amount || intent.amount;
    const refundId = `re_${uuidv4().replace(/-/g, '')}`;

    // Create refund record
    await query(
      `INSERT INTO terminal_refunds (
        id, payment_intent_id, amount, status, created_at
      ) VALUES ($1, $2, $3, 'succeeded', NOW())`,
      [refundId, paymentIntentId, refundAmount]
    );

    logger.info('Terminal refund processed', { refundId, paymentIntentId, amount: refundAmount });

    return {
      type: 'refund_payment',
      status: 'succeeded',
      refundPayment: {
        refundId,
        paymentIntentId,
        amount: refundAmount,
      },
    };
  }

  // ==========================================
  // SIMULATED READER
  // ==========================================

  // Create simulated reader for testing
  async createSimulatedReader(
    merchantId: string,
    locationId: string
  ): Promise<Reader> {
    return this.registerReader(merchantId, {
      registrationCode: 'simulated-reader',
      locationId,
      label: 'Simulated Reader',
    });
  }

  // Present simulated payment method
  async presentPaymentMethod(
    readerId: string,
    config?: SimulatedReaderConfig
  ): Promise<TerminalPaymentMethod> {
    // Get current action
    const actionResult = await query<any>(
      `SELECT * FROM terminal_reader_actions
       WHERE reader_id = $1 AND type = 'process_payment_intent' AND status = 'in_progress'
       ORDER BY created_at DESC
       LIMIT 1`,
      [readerId]
    );

    if (actionResult.rows.length === 0) {
      throw new Error('No payment in progress on this reader');
    }

    // Simulate card presentation
    const paymentMethod: TerminalPaymentMethod = {
      id: `pm_${uuidv4().replace(/-/g, '')}`,
      type: 'card_present',
      cardPresent: {
        brand: 'visa',
        last4: config?.testCardNumber?.slice(-4) || '4242',
        expMonth: 12,
        expYear: 2025,
        funding: 'credit',
        readMethod: 'contactless_emv',
        receipt: {
          applicationPreferredName: 'VISA CREDIT',
          authorizationCode: '123456',
          authorizationResponseCode: '00',
        },
      },
    };

    // Update action to succeeded
    await query(
      `UPDATE terminal_reader_actions SET status = 'succeeded' WHERE id = $1`,
      [actionResult.rows[0].id]
    );

    // Collect payment method on payment intent
    await this.collectPaymentMethod(actionResult.rows[0].payment_intent_id, paymentMethod);

    return paymentMethod;
  }

  // Helper: Map database row to payment intent
  private mapPaymentIntent(row: any): TerminalPaymentIntent {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      captureMethod: row.capture_method,
      statementDescriptor: row.statement_descriptor,
      receiptEmail: row.receipt_email,
      metadata: row.metadata,
      paymentMethod: row.payment_method,
      createdAt: row.created_at,
    };
  }
}

export const terminalService = new TerminalService();
