import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ConflictError } from '../utils/errors';
import {
  Customer,
  PaymentMethod,
  PaginationParams,
  PaginatedResponse
} from '../types';
import { getStripeGateway } from './payment-gateway.service';
import { config } from '../config';

export class CustomerService {
  async create(
    merchantId: string,
    data: {
      email: string;
      name?: string;
      phone?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<Customer> {
    // Check for existing customer with same email
    const existing = await query(
      'SELECT id FROM customers WHERE merchant_id = $1 AND email = $2',
      [merchantId, data.email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      throw new ConflictError('Customer with this email already exists');
    }

    const result = await query<any>(
      `INSERT INTO customers (merchant_id, email, name, phone, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        merchantId,
        data.email.toLowerCase(),
        data.name,
        data.phone,
        JSON.stringify(data.metadata || {}),
      ]
    );

    const customer = this.mapCustomer(result.rows[0]);

    logger.info('Customer created', {
      customerId: customer.id,
      merchantId,
    });

    return customer;
  }

  async findById(id: string, merchantId: string): Promise<Customer> {
    const result = await query<any>(
      'SELECT * FROM customers WHERE id = $1 AND merchant_id = $2',
      [id, merchantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Customer');
    }

    return this.mapCustomer(result.rows[0]);
  }

  async findByEmail(email: string, merchantId: string): Promise<Customer | null> {
    const result = await query<any>(
      'SELECT * FROM customers WHERE email = $1 AND merchant_id = $2',
      [email.toLowerCase(), merchantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapCustomer(result.rows[0]);
  }

  async list(
    merchantId: string,
    params: PaginationParams
  ): Promise<PaginatedResponse<Customer>> {
    const { page, limit, sortBy = 'created_at', sortOrder = 'desc' } = params;
    const offset = (page - 1) * limit;

    const allowedSortColumns = ['created_at', 'email', 'name'];
    const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';

    const [dataResult, countResult] = await Promise.all([
      query<any>(
        `SELECT * FROM customers
         WHERE merchant_id = $1
         ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
         LIMIT $2 OFFSET $3`,
        [merchantId, limit, offset]
      ),
      query<{ count: string }>(
        'SELECT COUNT(*) as count FROM customers WHERE merchant_id = $1',
        [merchantId]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    return {
      data: dataResult.rows.map(row => this.mapCustomer(row)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async update(
    id: string,
    merchantId: string,
    data: Partial<Pick<Customer, 'name' | 'phone' | 'metadata'>>
  ): Promise<Customer> {
    const customer = await this.findById(id, merchantId);

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.name !== undefined) {
      updateFields.push(`name = $${paramCount++}`);
      values.push(data.name);
    }

    if (data.phone !== undefined) {
      updateFields.push(`phone = $${paramCount++}`);
      values.push(data.phone);
    }

    if (data.metadata !== undefined) {
      const mergedMetadata = { ...customer.metadata, ...data.metadata };
      updateFields.push(`metadata = $${paramCount++}`);
      values.push(JSON.stringify(mergedMetadata));
    }

    if (updateFields.length === 0) {
      return customer;
    }

    values.push(id, merchantId);

    const result = await query<any>(
      `UPDATE customers SET ${updateFields.join(', ')}
       WHERE id = $${paramCount++} AND merchant_id = $${paramCount}
       RETURNING *`,
      values
    );

    return this.mapCustomer(result.rows[0]);
  }

  async delete(id: string, merchantId: string): Promise<void> {
    const result = await query(
      'DELETE FROM customers WHERE id = $1 AND merchant_id = $2',
      [id, merchantId]
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Customer');
    }

    logger.info('Customer deleted', { customerId: id, merchantId });
  }

  // Payment Methods
  async addPaymentMethod(
    customerId: string,
    merchantId: string,
    token: string
  ): Promise<PaymentMethod> {
    // Verify customer belongs to merchant
    await this.findById(customerId, merchantId);

    // Create payment method via gateway
    let gatewayResult;
    if (config.stripeSecretKey) {
      const gateway = getStripeGateway();
      gatewayResult = await gateway.createPaymentMethod(customerId, token);
    } else {
      // Mock for development
      gatewayResult = {
        id: `pm_mock_${Date.now()}`,
        type: 'card' as const,
        details: {
          brand: 'visa',
          last4: '4242',
          expMonth: 12,
          expYear: 2025,
          fingerprint: 'mock',
          tokenId: token,
        },
      };
    }

    // Check if this should be default
    const existingMethods = await query(
      'SELECT COUNT(*) as count FROM payment_methods WHERE customer_id = $1',
      [customerId]
    );
    const isDefault = parseInt(existingMethods.rows[0].count) === 0;

    // Store payment method
    const result = await query<any>(
      `INSERT INTO payment_methods (customer_id, type, is_default, details)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        customerId,
        gatewayResult.type,
        isDefault,
        JSON.stringify(gatewayResult.details),
      ]
    );

    logger.info('Payment method added', {
      paymentMethodId: result.rows[0].id,
      customerId,
    });

    return this.mapPaymentMethod(result.rows[0]);
  }

  async getPaymentMethods(customerId: string, merchantId: string): Promise<PaymentMethod[]> {
    // Verify customer belongs to merchant
    await this.findById(customerId, merchantId);

    const result = await query<any>(
      `SELECT * FROM payment_methods
       WHERE customer_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [customerId]
    );

    return result.rows.map(row => this.mapPaymentMethod(row));
  }

  async setDefaultPaymentMethod(
    paymentMethodId: string,
    customerId: string,
    merchantId: string
  ): Promise<void> {
    // Verify customer belongs to merchant
    await this.findById(customerId, merchantId);

    // Unset current default
    await query(
      'UPDATE payment_methods SET is_default = false WHERE customer_id = $1',
      [customerId]
    );

    // Set new default
    const result = await query(
      `UPDATE payment_methods SET is_default = true
       WHERE id = $1 AND customer_id = $2`,
      [paymentMethodId, customerId]
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Payment method');
    }
  }

  async deletePaymentMethod(
    paymentMethodId: string,
    customerId: string,
    merchantId: string
  ): Promise<void> {
    // Verify customer belongs to merchant
    await this.findById(customerId, merchantId);

    const result = await query(
      'DELETE FROM payment_methods WHERE id = $1 AND customer_id = $2',
      [paymentMethodId, customerId]
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Payment method');
    }

    logger.info('Payment method deleted', { paymentMethodId, customerId });
  }

  private mapCustomer(row: any): Customer {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapPaymentMethod(row: any): PaymentMethod {
    return {
      id: row.id,
      customerId: row.customer_id,
      type: row.type,
      isDefault: row.is_default,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const customerService = new CustomerService();
