import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { RequireModule, PLATFORM_MODULES } from '../core/modules/module-system';
import { eventBus } from '../core';

// Types
export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type PayoutMethod = 'ach' | 'wire' | 'check' | 'paypal' | 'venmo' | 'local_bank';

export interface Payout {
  id: string;
  merchantId: string;
  batchId?: string;
  recipientId: string;
  recipientName: string;
  recipientEmail?: string;
  amount: number;
  fee: number;
  currency: string;
  method: PayoutMethod;
  status: PayoutStatus;
  bankDetails?: {
    accountNumber?: string;
    routingNumber?: string;
    iban?: string;
    swiftBic?: string;
    bankName?: string;
    country?: string;
  };
  reference?: string;
  memo?: string;
  metadata?: Record<string, any>;
  scheduledAt?: Date;
  processedAt?: Date;
  createdAt: Date;
}

export interface PayoutBatch {
  id: string;
  merchantId: string;
  name: string;
  totalAmount: number;
  totalFees: number;
  currency: string;
  payoutCount: number;
  completedCount: number;
  failedCount: number;
  status: 'draft' | 'pending' | 'processing' | 'completed' | 'partial';
  createdAt: Date;
  processedAt?: Date;
}

export interface Contractor {
  id: string;
  merchantId: string;
  name: string;
  email: string;
  taxId?: string;
  address?: Record<string, string>;
  bankDetails?: Record<string, string>;
  totalPaid: number;
  currency: string;
  isActive: boolean;
  createdAt: Date;
}

export class DisbursementsService {
  // ============================================
  // MASS PAYOUTS
  // ============================================

  @RequireModule(PLATFORM_MODULES.MASS_PAYOUTS)
  async createPayoutBatch(
    merchantId: string,
    input: {
      name: string;
      currency: string;
      payouts: Array<{
        recipientId: string;
        recipientName: string;
        recipientEmail?: string;
        amount: number;
        method: PayoutMethod;
        bankDetails?: Record<string, any>;
        memo?: string;
        metadata?: Record<string, any>;
      }>;
    }
  ): Promise<PayoutBatch> {
    const batchId = uuidv4();
    let totalAmount = 0;
    let totalFees = 0;

    // Calculate fees and create payouts
    const payouts: Payout[] = [];
    for (const p of input.payouts) {
      const fee = this.calculatePayoutFee(p.method, p.amount);
      totalAmount += p.amount;
      totalFees += fee;

      const payout: Payout = {
        id: uuidv4(),
        merchantId,
        batchId,
        recipientId: p.recipientId,
        recipientName: p.recipientName,
        recipientEmail: p.recipientEmail,
        amount: p.amount,
        fee,
        currency: input.currency,
        method: p.method,
        status: 'pending',
        bankDetails: p.bankDetails,
        memo: p.memo,
        metadata: p.metadata,
        createdAt: new Date(),
      };
      payouts.push(payout);
    }

    // Create batch
    await query(
      `INSERT INTO payout_batches (
        id, merchant_id, name, total_amount, total_fees, currency,
        payout_count, completed_count, failed_count, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 'draft', NOW())`,
      [batchId, merchantId, input.name, totalAmount, totalFees, input.currency, payouts.length]
    );

    // Create individual payouts
    for (const payout of payouts) {
      await query(
        `INSERT INTO payouts (
          id, merchant_id, batch_id, recipient_id, recipient_name, recipient_email,
          amount, fee, currency, method, status, bank_details, memo, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
        [
          payout.id, merchantId, batchId, payout.recipientId, payout.recipientName,
          payout.recipientEmail, payout.amount, payout.fee, payout.currency,
          payout.method, payout.status, JSON.stringify(payout.bankDetails || {}),
          payout.memo, JSON.stringify(payout.metadata || {}),
        ]
      );
    }

    await eventBus.emit('disbursements.batch.created', {
      merchantId,
      data: { batchId, payoutCount: payouts.length, totalAmount },
    });

    return {
      id: batchId,
      merchantId,
      name: input.name,
      totalAmount,
      totalFees,
      currency: input.currency,
      payoutCount: payouts.length,
      completedCount: 0,
      failedCount: 0,
      status: 'draft',
      createdAt: new Date(),
    };
  }

  @RequireModule(PLATFORM_MODULES.MASS_PAYOUTS)
  async processBatch(merchantId: string, batchId: string): Promise<PayoutBatch> {
    // Check balance
    const batchResult = await query<any>(
      `SELECT * FROM payout_batches WHERE id = $1 AND merchant_id = $2`,
      [batchId, merchantId]
    );

    if (batchResult.rows.length === 0) {
      throw new NotFoundError('Payout Batch');
    }

    const batch = batchResult.rows[0];
    const totalNeeded = parseInt(batch.total_amount) + parseInt(batch.total_fees);

    const balanceResult = await query<any>(
      `SELECT available FROM balances WHERE merchant_id = $1 AND currency = $2`,
      [merchantId, batch.currency]
    );

    if (!balanceResult.rows.length || balanceResult.rows[0].available < totalNeeded) {
      throw new ValidationError('Insufficient balance');
    }

    // Deduct from balance
    await query(
      `UPDATE balances SET available = available - $1 WHERE merchant_id = $2 AND currency = $3`,
      [totalNeeded, merchantId, batch.currency]
    );

    // Update batch status
    await query(
      `UPDATE payout_batches SET status = 'processing' WHERE id = $1`,
      [batchId]
    );

    // Process payouts (in production, this would be async via job queue)
    const payouts = await query<any>(
      `SELECT * FROM payouts WHERE batch_id = $1`,
      [batchId]
    );

    let completed = 0;
    let failed = 0;

    for (const row of payouts.rows) {
      // Simulate processing
      const success = Math.random() > 0.05; // 95% success rate

      await query(
        `UPDATE payouts SET status = $1, processed_at = NOW() WHERE id = $2`,
        [success ? 'completed' : 'failed', row.id]
      );

      if (success) completed++;
      else failed++;
    }

    // Update batch
    const status = failed === 0 ? 'completed' : completed === 0 ? 'failed' : 'partial';
    const result = await query<any>(
      `UPDATE payout_batches
       SET completed_count = $1, failed_count = $2, status = $3, processed_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [completed, failed, status, batchId]
    );

    await eventBus.emit('disbursements.batch.processed', {
      merchantId,
      data: { batchId, completed, failed },
    });

    return this.mapBatch(result.rows[0]);
  }

  // ============================================
  // CONTRACTOR PAYMENTS
  // ============================================

  @RequireModule(PLATFORM_MODULES.CONTRACTOR_PAYMENTS)
  async createContractor(
    merchantId: string,
    input: {
      name: string;
      email: string;
      taxId?: string;
      address?: Record<string, string>;
      bankDetails?: Record<string, string>;
      currency: string;
    }
  ): Promise<Contractor> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO contractors (
        id, merchant_id, name, email, tax_id, address, bank_details,
        total_paid, currency, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, true, NOW())
      RETURNING *`,
      [
        id, merchantId, input.name, input.email, input.taxId,
        JSON.stringify(input.address || {}), JSON.stringify(input.bankDetails || {}),
        input.currency,
      ]
    );

    return this.mapContractor(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.CONTRACTOR_PAYMENTS)
  async payContractor(
    merchantId: string,
    input: {
      contractorId: string;
      amount: number;
      currency: string;
      memo?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<Payout> {
    // Get contractor
    const contractorResult = await query<any>(
      `SELECT * FROM contractors WHERE id = $1 AND merchant_id = $2`,
      [input.contractorId, merchantId]
    );

    if (contractorResult.rows.length === 0) {
      throw new NotFoundError('Contractor');
    }

    const contractor = this.mapContractor(contractorResult.rows[0]);
    const fee = 100; // $1 per contractor payment

    // Check balance
    const balanceResult = await query<any>(
      `SELECT available FROM balances WHERE merchant_id = $1 AND currency = $2`,
      [merchantId, input.currency]
    );

    if (!balanceResult.rows.length || balanceResult.rows[0].available < input.amount + fee) {
      throw new ValidationError('Insufficient balance');
    }

    // Create payout
    const id = uuidv4();
    await query(
      `INSERT INTO payouts (
        id, merchant_id, recipient_id, recipient_name, recipient_email,
        amount, fee, currency, method, status, bank_details, memo, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ach', 'processing', $9, $10, $11, NOW())`,
      [
        id, merchantId, contractor.id, contractor.name, contractor.email,
        input.amount, fee, input.currency,
        JSON.stringify(contractor.bankDetails || {}),
        input.memo, JSON.stringify({ ...input.metadata, type: '1099' }),
      ]
    );

    // Deduct from balance
    await query(
      `UPDATE balances SET available = available - $1 WHERE merchant_id = $2 AND currency = $3`,
      [input.amount + fee, merchantId, input.currency]
    );

    // Update contractor total paid
    await query(
      `UPDATE contractors SET total_paid = total_paid + $1 WHERE id = $2`,
      [input.amount, contractor.id]
    );

    await eventBus.emit('disbursements.contractor.paid', {
      merchantId,
      data: { contractorId: contractor.id, amount: input.amount },
    });

    return {
      id,
      merchantId,
      recipientId: contractor.id,
      recipientName: contractor.name,
      recipientEmail: contractor.email,
      amount: input.amount,
      fee,
      currency: input.currency,
      method: 'ach',
      status: 'processing',
      memo: input.memo,
      metadata: input.metadata,
      createdAt: new Date(),
    };
  }

  @RequireModule(PLATFORM_MODULES.CONTRACTOR_PAYMENTS)
  async generate1099Report(merchantId: string, year: number): Promise<any[]> {
    const result = await query<any>(
      `SELECT c.*, SUM(p.amount) as year_total
       FROM contractors c
       JOIN payouts p ON p.recipient_id = c.id
       WHERE c.merchant_id = $1
         AND p.status = 'completed'
         AND EXTRACT(YEAR FROM p.processed_at) = $2
       GROUP BY c.id
       HAVING SUM(p.amount) >= 60000`, // $600 threshold
      [merchantId, year]
    );

    return result.rows.map(row => ({
      contractor: this.mapContractor(row),
      totalPaid: parseInt(row.year_total),
      requiresForm: true,
    }));
  }

  // ============================================
  // GLOBAL PAYOUTS
  // ============================================

  @RequireModule(PLATFORM_MODULES.GLOBAL_PAYOUTS)
  async createGlobalPayout(
    merchantId: string,
    input: {
      recipientId: string;
      recipientName: string;
      recipientEmail?: string;
      amount: number;
      currency: string;
      destinationCountry: string;
      method: PayoutMethod;
      bankDetails: {
        accountNumber?: string;
        iban?: string;
        swiftBic?: string;
        bankName: string;
        country: string;
      };
      memo?: string;
    }
  ): Promise<Payout> {
    const fee = 300; // $3 for global payouts

    // Check balance
    const balanceResult = await query<any>(
      `SELECT available FROM balances WHERE merchant_id = $1 AND currency = $2`,
      [merchantId, input.currency]
    );

    if (!balanceResult.rows.length || balanceResult.rows[0].available < input.amount + fee) {
      throw new ValidationError('Insufficient balance');
    }

    const id = uuidv4();
    await query(
      `INSERT INTO payouts (
        id, merchant_id, recipient_id, recipient_name, recipient_email,
        amount, fee, currency, method, status, bank_details, memo, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing', $10, $11, $12, NOW())`,
      [
        id, merchantId, input.recipientId, input.recipientName, input.recipientEmail,
        input.amount, fee, input.currency, input.method,
        JSON.stringify(input.bankDetails), input.memo,
        JSON.stringify({ destinationCountry: input.destinationCountry, type: 'global' }),
      ]
    );

    // Deduct from balance
    await query(
      `UPDATE balances SET available = available - $1 WHERE merchant_id = $2 AND currency = $3`,
      [input.amount + fee, merchantId, input.currency]
    );

    await eventBus.emit('disbursements.global.created', {
      merchantId,
      data: { payoutId: id, country: input.destinationCountry, amount: input.amount },
    });

    return {
      id,
      merchantId,
      recipientId: input.recipientId,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail,
      amount: input.amount,
      fee,
      currency: input.currency,
      method: input.method,
      status: 'processing',
      bankDetails: input.bankDetails,
      memo: input.memo,
      createdAt: new Date(),
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  private calculatePayoutFee(method: PayoutMethod, amount: number): number {
    const fees: Record<PayoutMethod, number> = {
      ach: 25,       // $0.25
      wire: 2500,    // $25
      check: 100,    // $1
      paypal: Math.round(amount * 0.02), // 2%
      venmo: 25,     // $0.25
      local_bank: 300, // $3
    };
    return fees[method] || 25;
  }

  private mapBatch(row: any): PayoutBatch {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      name: row.name,
      totalAmount: parseInt(row.total_amount),
      totalFees: parseInt(row.total_fees),
      currency: row.currency,
      payoutCount: parseInt(row.payout_count),
      completedCount: parseInt(row.completed_count),
      failedCount: parseInt(row.failed_count),
      status: row.status,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }

  private mapContractor(row: any): Contractor {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      name: row.name,
      email: row.email,
      taxId: row.tax_id,
      address: row.address,
      bankDetails: row.bank_details,
      totalPaid: parseInt(row.total_paid || 0),
      currency: row.currency,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }
}

export const disbursementsService = new DisbursementsService();
