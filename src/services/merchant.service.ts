import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../database/connection';
import { logger } from '../utils/logger';
import {
  generateApiKey,
  hashApiKey,
  generateSecretKey,
  encrypt
} from '../utils/encryption';
import {
  ConflictError,
  NotFoundError,
  ValidationError
} from '../utils/errors';
import {
  Merchant,
  MerchantSettings,
  CreateMerchantInput,
  PaginationParams,
  PaginatedResponse
} from '../types';
import { cacheDelete, cacheGet, cacheSet } from '../database/redis';

const DEFAULT_SETTINGS: MerchantSettings = {
  defaultCurrency: 'USD',
  supportedCurrencies: ['USD'],
  payoutSchedule: 'weekly',
  minimumPayoutAmount: 10000, // $100.00 in cents
  feePercentage: 2.9,
  flatFee: 30, // $0.30 in cents
  chargebackFee: 1500, // $15.00
  refundPolicy: 'full',
  autoCapture: true,
};

export class MerchantService {
  async create(input: CreateMerchantInput): Promise<{ merchant: Merchant; apiKey: string }> {
    // Check if email already exists
    const existing = await query(
      'SELECT id FROM merchants WHERE email = $1',
      [input.email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      throw new ConflictError('A merchant with this email already exists');
    }

    // Generate credentials
    const passwordHash = await bcrypt.hash(input.password, 12);
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const webhookSecret = generateSecretKey();

    const settings = {
      ...DEFAULT_SETTINGS,
      ...input.settings,
    };

    const result = await query<Merchant>(
      `INSERT INTO merchants (
        name, email, password_hash, business_name, business_type,
        tax_id, api_key_hash, webhook_secret, settings, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        input.name,
        input.email.toLowerCase(),
        passwordHash,
        input.businessName,
        input.businessType,
        input.taxId,
        apiKeyHash,
        encrypt(webhookSecret),
        JSON.stringify(settings),
        JSON.stringify({}),
      ]
    );

    const merchant = this.mapMerchant(result.rows[0]);

    // Initialize balance for default currency
    await query(
      `INSERT INTO balances (merchant_id, currency, available, pending)
       VALUES ($1, $2, 0, 0)`,
      [merchant.id, settings.defaultCurrency]
    );

    logger.info('Merchant created', { merchantId: merchant.id, email: merchant.email });

    return { merchant, apiKey };
  }

  async findById(id: string): Promise<Merchant> {
    // Check cache first
    const cached = await cacheGet<Merchant>(`merchant:${id}`);
    if (cached) return cached;

    const result = await query<any>(
      'SELECT * FROM merchants WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Merchant');
    }

    const merchant = this.mapMerchant(result.rows[0]);

    // Cache for 5 minutes
    await cacheSet(`merchant:${id}`, merchant, 300);

    return merchant;
  }

  async findByEmail(email: string): Promise<Merchant | null> {
    const result = await query<any>(
      'SELECT * FROM merchants WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapMerchant(result.rows[0]);
  }

  async findByApiKey(apiKeyHash: string): Promise<Merchant | null> {
    const result = await query<any>(
      'SELECT * FROM merchants WHERE api_key_hash = $1',
      [apiKeyHash]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapMerchant(result.rows[0]);
  }

  async list(params: PaginationParams): Promise<PaginatedResponse<Merchant>> {
    const { page, limit, sortBy = 'created_at', sortOrder = 'desc' } = params;
    const offset = (page - 1) * limit;

    // Validate sort column
    const allowedSortColumns = ['created_at', 'name', 'email', 'status'];
    const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';

    const [dataResult, countResult] = await Promise.all([
      query<any>(
        `SELECT * FROM merchants
         ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      query<{ count: string }>('SELECT COUNT(*) as count FROM merchants'),
    ]);

    const total = parseInt(countResult.rows[0].count);

    return {
      data: dataResult.rows.map(row => this.mapMerchant(row)),
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
    updates: Partial<Pick<Merchant, 'name' | 'businessName' | 'webhookUrl' | 'settings' | 'metadata'>>
  ): Promise<Merchant> {
    const merchant = await this.findById(id);

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (updates.name !== undefined) {
      updateFields.push(`name = $${paramCount++}`);
      values.push(updates.name);
    }

    if (updates.businessName !== undefined) {
      updateFields.push(`business_name = $${paramCount++}`);
      values.push(updates.businessName);
    }

    if (updates.webhookUrl !== undefined) {
      updateFields.push(`webhook_url = $${paramCount++}`);
      values.push(updates.webhookUrl);
    }

    if (updates.settings !== undefined) {
      const mergedSettings = { ...merchant.settings, ...updates.settings };
      updateFields.push(`settings = $${paramCount++}`);
      values.push(JSON.stringify(mergedSettings));
    }

    if (updates.metadata !== undefined) {
      const mergedMetadata = { ...merchant.metadata, ...updates.metadata };
      updateFields.push(`metadata = $${paramCount++}`);
      values.push(JSON.stringify(mergedMetadata));
    }

    if (updateFields.length === 0) {
      return merchant;
    }

    values.push(id);

    const result = await query<any>(
      `UPDATE merchants SET ${updateFields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const updated = this.mapMerchant(result.rows[0]);

    // Clear cache
    await cacheDelete(`merchant:${id}`);

    logger.info('Merchant updated', { merchantId: id });

    return updated;
  }

  async updateStatus(id: string, status: Merchant['status']): Promise<Merchant> {
    const result = await query<any>(
      'UPDATE merchants SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Merchant');
    }

    const merchant = this.mapMerchant(result.rows[0]);

    // Clear cache
    await cacheDelete(`merchant:${id}`);

    logger.info('Merchant status updated', { merchantId: id, status });

    return merchant;
  }

  async rotateApiKey(id: string): Promise<string> {
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const result = await query(
      'UPDATE merchants SET api_key_hash = $1 WHERE id = $2 RETURNING id',
      [apiKeyHash, id]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Merchant');
    }

    // Clear cache
    await cacheDelete(`merchant:${id}`);

    logger.info('Merchant API key rotated', { merchantId: id });

    return apiKey;
  }

  async verifyPassword(merchantId: string, password: string): Promise<boolean> {
    const result = await query<{ password_hash: string }>(
      'SELECT password_hash FROM merchants WHERE id = $1',
      [merchantId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    return bcrypt.compare(password, result.rows[0].password_hash);
  }

  async getWebhookSecret(merchantId: string): Promise<string | null> {
    const result = await query<{ webhook_secret: string }>(
      'SELECT webhook_secret FROM merchants WHERE id = $1',
      [merchantId]
    );

    if (result.rows.length === 0 || !result.rows[0].webhook_secret) {
      return null;
    }

    // Webhook secret is encrypted in database
    const { decrypt } = await import('../utils/encryption');
    return decrypt(result.rows[0].webhook_secret);
  }

  async calculateFees(merchantId: string, amount: number): Promise<{ fee: number; netAmount: number }> {
    const merchant = await this.findById(merchantId);
    const { feePercentage, flatFee } = merchant.settings;

    const percentageFee = Math.round(amount * (feePercentage / 100));
    const totalFee = percentageFee + flatFee;
    const netAmount = amount - totalFee;

    return { fee: totalFee, netAmount };
  }

  private mapMerchant(row: any): Merchant {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      businessName: row.business_name,
      businessType: row.business_type,
      taxId: row.tax_id,
      status: row.status,
      apiKeyHash: row.api_key_hash,
      webhookUrl: row.webhook_url,
      webhookSecret: row.webhook_secret,
      settings: typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const merchantService = new MerchantService();
