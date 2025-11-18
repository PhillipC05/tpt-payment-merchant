import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { Balance, Payout, PayoutStatus, PaginationParams, PaginatedResponse } from '../types';

export class BalanceService {
  async getBalance(merchantId: string): Promise<Balance> {
    const result = await query<any>(
      `SELECT currency, available, pending
       FROM balances
       WHERE merchant_id = $1`,
      [merchantId]
    );

    const available = result.rows.map(row => ({
      currency: row.currency,
      amount: parseInt(row.available),
    }));

    const pending = result.rows.map(row => ({
      currency: row.currency,
      amount: parseInt(row.pending),
    }));

    return {
      merchantId,
      available,
      pending,
    };
  }

  async updateBalance(
    merchantId: string,
    currency: string,
    amount: number,
    type: 'available' | 'pending'
  ): Promise<void> {
    const column = type === 'available' ? 'available' : 'pending';

    await query(
      `INSERT INTO balances (merchant_id, currency, ${column})
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_id, currency)
       DO UPDATE SET ${column} = balances.${column} + $3`,
      [merchantId, currency, amount]
    );
  }

  async movePendingToAvailable(
    merchantId: string,
    currency: string,
    amount: number
  ): Promise<void> {
    await query(
      `UPDATE balances
       SET pending = pending - $1, available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [amount, merchantId, currency]
    );
  }

  async createPayout(
    merchantId: string,
    currency: string,
    amount?: number
  ): Promise<Payout> {
    // Get available balance
    const balance = await this.getBalance(merchantId);
    const currencyBalance = balance.available.find(b => b.currency === currency);

    if (!currencyBalance || currencyBalance.amount === 0) {
      throw new Error('No available balance for payout');
    }

    const payoutAmount = amount || currencyBalance.amount;

    if (payoutAmount > currencyBalance.amount) {
      throw new Error('Insufficient balance for payout');
    }

    // Calculate payout fee (example: 0.25% + $0.25)
    const feePercentage = 0.0025;
    const flatFee = 25; // cents
    const fee = Math.round(payoutAmount * feePercentage) + flatFee;
    const netAmount = payoutAmount - fee;

    // Get transactions for this period
    const now = new Date();
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    const transactionsResult = await query<{ id: string }>(
      `SELECT id FROM transactions
       WHERE merchant_id = $1
         AND currency = $2
         AND status = 'completed'
         AND type = 'charge'
         AND created_at >= $3
         AND created_at <= $4`,
      [merchantId, currency, periodStart, now]
    );

    const transactionIds = transactionsResult.rows.map(r => r.id);

    // Create payout record
    const result = await query<any>(
      `INSERT INTO payouts (
        merchant_id, status, amount, currency, fee, net_amount,
        transaction_ids, period_start, period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        merchantId,
        'pending',
        payoutAmount,
        currency,
        fee,
        netAmount,
        transactionIds,
        periodStart,
        now,
      ]
    );

    // Deduct from available balance
    await query(
      `UPDATE balances
       SET available = available - $1
       WHERE merchant_id = $2 AND currency = $3`,
      [payoutAmount, merchantId, currency]
    );

    logger.info('Payout created', {
      payoutId: result.rows[0].id,
      merchantId,
      amount: payoutAmount,
      currency,
    });

    return this.mapPayout(result.rows[0]);
  }

  async getPayout(payoutId: string, merchantId: string): Promise<Payout> {
    const result = await query<any>(
      'SELECT * FROM payouts WHERE id = $1 AND merchant_id = $2',
      [payoutId, merchantId]
    );

    if (result.rows.length === 0) {
      throw new Error('Payout not found');
    }

    return this.mapPayout(result.rows[0]);
  }

  async listPayouts(
    merchantId: string,
    params: PaginationParams & { status?: PayoutStatus }
  ): Promise<PaginatedResponse<Payout>> {
    const { page, limit, sortBy = 'created_at', sortOrder = 'desc', status } = params;
    const offset = (page - 1) * limit;

    let whereClause = 'merchant_id = $1';
    const values: any[] = [merchantId];

    if (status) {
      whereClause += ' AND status = $2';
      values.push(status);
    }

    const allowedSortColumns = ['created_at', 'amount', 'status'];
    const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';

    const [dataResult, countResult] = await Promise.all([
      query<any>(
        `SELECT * FROM payouts
         WHERE ${whereClause}
         ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payouts WHERE ${whereClause}`,
        values
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    return {
      data: dataResult.rows.map(row => this.mapPayout(row)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async updatePayoutStatus(
    payoutId: string,
    status: PayoutStatus,
    failureReason?: string
  ): Promise<Payout> {
    const updates: string[] = ['status = $1'];
    const values: any[] = [status];

    if (status === 'completed') {
      updates.push('arrived_at = NOW()');
    }

    if (failureReason) {
      updates.push(`failure_reason = $${values.length + 1}`);
      values.push(failureReason);
    }

    values.push(payoutId);

    const result = await query<any>(
      `UPDATE payouts SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error('Payout not found');
    }

    // If failed, restore balance
    if (status === 'failed') {
      const payout = this.mapPayout(result.rows[0]);
      await query(
        `UPDATE balances
         SET available = available + $1
         WHERE merchant_id = $2 AND currency = $3`,
        [payout.amount, payout.merchantId, payout.currency]
      );
    }

    return this.mapPayout(result.rows[0]);
  }

  private mapPayout(row: any): Payout {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      status: row.status,
      amount: parseInt(row.amount),
      currency: row.currency,
      fee: parseInt(row.fee),
      netAmount: parseInt(row.net_amount),
      bankAccountId: row.bank_account_id,
      transactionIds: row.transaction_ids || [],
      periodStart: row.period_start,
      periodEnd: row.period_end,
      arrivedAt: row.arrived_at,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const balanceService = new BalanceService();
