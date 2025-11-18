import { v4 as uuidv4 } from 'uuid';
import { query, transaction as dbTransaction } from '../database/connection';
import { getPaymentGateway } from './payment-gateway.service';
import { merchantService } from './merchant.service';
import { webhookService } from './webhook.service';
import { logger } from '../utils/logger';
import {
  NotFoundError,
  PaymentError,
  IdempotencyError,
  ValidationError
} from '../utils/errors';
import {
  Transaction,
  CreateChargeInput,
  RefundInput,
  PaginationParams,
  PaginatedResponse,
  TransactionStatus
} from '../types';
import {
  getIdempotencyKey,
  setIdempotencyKey,
  acquireLock,
  releaseLock
} from '../database/redis';
import { eventBus, hookSystem } from '../core';

export class TransactionService {
  async createCharge(
    merchantId: string,
    input: CreateChargeInput
  ): Promise<Transaction> {
    // Check idempotency
    if (input.idempotencyKey) {
      const existing = await getIdempotencyKey(input.idempotencyKey);
      if (existing) {
        logger.info('Returning idempotent response', {
          idempotencyKey: input.idempotencyKey
        });
        return existing;
      }
    }

    // Execute pre-transaction hook
    const hookResult = await hookSystem.execute('pre:transaction.create', {
      merchantId,
      data: { input },
    });

    if (hookResult.aborted) {
      throw new ValidationError(hookResult.abortReason || 'Transaction blocked by hook');
    }

    // Use potentially modified input from hooks
    const processedInput = hookResult.data?.input || input;

    // Emit transaction initiated event
    await eventBus.emit('transaction.initiated', {
      merchantId,
      data: { input: processedInput },
    });

    // Calculate fees
    const { fee, netAmount } = await merchantService.calculateFees(merchantId, processedInput.amount);

    // Create pending transaction
    const transactionId = uuidv4();
    const result = await query<any>(
      `INSERT INTO transactions (
        id, merchant_id, customer_id, payment_method_id, type, status,
        amount, currency, fee, net_amount, description, statement_descriptor,
        metadata, idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        transactionId,
        merchantId,
        processedInput.customerId,
        processedInput.paymentMethodId,
        'charge',
        'pending',
        processedInput.amount,
        processedInput.currency.toUpperCase(),
        fee,
        netAmount,
        processedInput.description,
        processedInput.statementDescriptor,
        JSON.stringify(processedInput.metadata || {}),
        processedInput.idempotencyKey,
      ]
    );

    let transaction = this.mapTransaction(result.rows[0]);

    try {
      // Process through payment gateway
      const gateway = getPaymentGateway();
      const chargeResult = await gateway.charge({
        amount: processedInput.amount,
        currency: processedInput.currency,
        paymentMethodId: processedInput.paymentMethodId || '',
        description: processedInput.description,
        metadata: {
          transaction_id: transactionId,
          merchant_id: merchantId,
        },
        capture: processedInput.capture !== false,
        idempotencyKey: processedInput.idempotencyKey,
      });

      // Update transaction with gateway response
      const updateResult = await query<any>(
        `UPDATE transactions SET
          status = $1,
          gateway_reference = $2,
          gateway_response = $3,
          error_code = $4,
          error_message = $5,
          captured_at = $6
        WHERE id = $7
        RETURNING *`,
        [
          chargeResult.status === 'succeeded' ? 'completed' :
          chargeResult.status === 'failed' ? 'failed' : 'processing',
          chargeResult.id,
          JSON.stringify(chargeResult.rawResponse),
          chargeResult.failureCode,
          chargeResult.failureMessage,
          chargeResult.captured ? new Date() : null,
          transactionId,
        ]
      );

      transaction = this.mapTransaction(updateResult.rows[0]);

      // Update merchant balance if successful
      if (transaction.status === 'completed') {
        await this.updateMerchantBalance(merchantId, processedInput.currency, netAmount, 'pending');

        // Emit transaction completed event
        await eventBus.emit('transaction.completed', {
          merchantId,
          data: { transaction: this.sanitizeTransaction(transaction) },
        });

        // Send webhook
        await webhookService.send(merchantId, 'transaction.completed', {
          transaction: this.sanitizeTransaction(transaction),
        });
      } else if (transaction.status === 'failed') {
        // Emit transaction failed event
        await eventBus.emit('transaction.failed', {
          merchantId,
          data: { transaction: this.sanitizeTransaction(transaction) },
        });

        await webhookService.send(merchantId, 'transaction.failed', {
          transaction: this.sanitizeTransaction(transaction),
        });
      }

    } catch (error) {
      // Update transaction as failed
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await query(
        `UPDATE transactions SET status = 'failed', error_message = $1 WHERE id = $2`,
        [errorMessage, transactionId]
      );

      transaction.status = 'failed';
      transaction.errorMessage = errorMessage;

      // Emit transaction failed event
      await eventBus.emit('transaction.failed', {
        merchantId,
        data: { transaction: this.sanitizeTransaction(transaction), error: errorMessage },
      });

      await webhookService.send(merchantId, 'transaction.failed', {
        transaction: this.sanitizeTransaction(transaction),
      });
    }

    // Execute post-transaction hook
    await hookSystem.execute('post:transaction.create', {
      merchantId,
      data: { transaction },
    });

    // Store idempotency response
    if (processedInput.idempotencyKey) {
      await setIdempotencyKey(processedInput.idempotencyKey, transaction);
    }

    logger.info('Charge processed', {
      transactionId: transaction.id,
      status: transaction.status,
      amount: transaction.amount,
    });

    return transaction;
  }

  async refund(merchantId: string, input: RefundInput): Promise<Transaction> {
    // Get original transaction
    const original = await this.findById(input.transactionId, merchantId);

    if (original.type !== 'charge') {
      throw new ValidationError('Can only refund charge transactions');
    }

    if (original.status !== 'completed') {
      throw new ValidationError('Can only refund completed transactions');
    }

    const refundAmount = input.amount || (original.amount - original.refundedAmount);

    if (refundAmount <= 0) {
      throw new ValidationError('Invalid refund amount');
    }

    if (refundAmount > original.amount - original.refundedAmount) {
      throw new ValidationError('Refund amount exceeds available amount');
    }

    // Execute pre-refund hook
    const hookResult = await hookSystem.execute('pre:transaction.refund', {
      merchantId,
      data: { input, original, refundAmount },
    });

    if (hookResult.aborted) {
      throw new ValidationError(hookResult.abortReason || 'Refund blocked by hook');
    }

    // Acquire lock to prevent double refunds
    const lockKey = `refund:${input.transactionId}`;
    const lockId = await acquireLock(lockKey);

    if (!lockId) {
      throw new PaymentError('Refund already in progress');
    }

    try {
      // Calculate refund fee (typically proportional)
      const feeRefundRatio = refundAmount / original.amount;
      const feeRefund = Math.round(original.fee * feeRefundRatio);
      const netRefund = refundAmount - feeRefund;

      // Create refund transaction
      const refundId = uuidv4();
      const result = await query<any>(
        `INSERT INTO transactions (
          id, merchant_id, customer_id, type, status,
          amount, currency, fee, net_amount, description, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          refundId,
          merchantId,
          original.customerId,
          'refund',
          'pending',
          refundAmount,
          original.currency,
          feeRefund,
          netRefund,
          input.reason || `Refund for ${original.id}`,
          JSON.stringify({
            ...input.metadata,
            original_transaction_id: original.id,
          }),
        ]
      );

      let refundTransaction = this.mapTransaction(result.rows[0]);

      // Process through gateway
      if (original.gatewayReference) {
        const gateway = getPaymentGateway();
        const refundResult = await gateway.refund({
          chargeId: original.gatewayReference,
          amount: refundAmount,
          reason: input.reason,
        });

        // Update refund transaction
        const updateResult = await query<any>(
          `UPDATE transactions SET
            status = $1,
            gateway_reference = $2,
            gateway_response = $3,
            error_message = $4
          WHERE id = $5
          RETURNING *`,
          [
            refundResult.status === 'succeeded' ? 'completed' :
            refundResult.status === 'failed' ? 'failed' : 'processing',
            refundResult.id,
            JSON.stringify(refundResult.rawResponse),
            refundResult.failureReason,
            refundId,
          ]
        );

        refundTransaction = this.mapTransaction(updateResult.rows[0]);
      } else {
        // Mock gateway - mark as completed
        const updateResult = await query<any>(
          `UPDATE transactions SET status = 'completed' WHERE id = $1 RETURNING *`,
          [refundId]
        );
        refundTransaction = this.mapTransaction(updateResult.rows[0]);
      }

      // Update original transaction
      if (refundTransaction.status === 'completed') {
        const newRefundedAmount = original.refundedAmount + refundAmount;
        const newStatus = newRefundedAmount >= original.amount ? 'refunded' : original.status;

        await query(
          `UPDATE transactions SET refunded_amount = $1, status = $2 WHERE id = $3`,
          [newRefundedAmount, newStatus, original.id]
        );

        // Update merchant balance
        await this.updateMerchantBalance(merchantId, original.currency, -netRefund, 'pending');

        // Emit transaction refunded event
        await eventBus.emit('transaction.refunded', {
          merchantId,
          data: {
            transaction: this.sanitizeTransaction(refundTransaction),
            originalTransaction: this.sanitizeTransaction(original),
            refundAmount,
          },
        });

        await webhookService.send(merchantId, 'transaction.refunded', {
          transaction: this.sanitizeTransaction(refundTransaction),
          originalTransaction: this.sanitizeTransaction(original),
        });
      }

      // Execute post-refund hook
      await hookSystem.execute('post:transaction.refund', {
        merchantId,
        data: { refundTransaction, original },
      });

      logger.info('Refund processed', {
        refundId: refundTransaction.id,
        originalId: original.id,
        amount: refundAmount,
        status: refundTransaction.status,
      });

      return refundTransaction;
    } finally {
      await releaseLock(lockKey, lockId);
    }
  }

  async findById(id: string, merchantId?: string): Promise<Transaction> {
    let queryText = 'SELECT * FROM transactions WHERE id = $1';
    const params: any[] = [id];

    if (merchantId) {
      queryText += ' AND merchant_id = $2';
      params.push(merchantId);
    }

    const result = await query<any>(queryText, params);

    if (result.rows.length === 0) {
      throw new NotFoundError('Transaction');
    }

    return this.mapTransaction(result.rows[0]);
  }

  async list(
    merchantId: string,
    params: PaginationParams & {
      status?: TransactionStatus;
      type?: string;
      startDate?: Date;
      endDate?: Date;
      customerId?: string;
    }
  ): Promise<PaginatedResponse<Transaction>> {
    const {
      page,
      limit,
      sortBy = 'created_at',
      sortOrder = 'desc',
      status,
      type,
      startDate,
      endDate,
      customerId,
    } = params;

    const offset = (page - 1) * limit;
    const conditions: string[] = ['merchant_id = $1'];
    const values: any[] = [merchantId];
    let paramCount = 2;

    if (status) {
      conditions.push(`status = $${paramCount++}`);
      values.push(status);
    }

    if (type) {
      conditions.push(`type = $${paramCount++}`);
      values.push(type);
    }

    if (customerId) {
      conditions.push(`customer_id = $${paramCount++}`);
      values.push(customerId);
    }

    if (startDate) {
      conditions.push(`created_at >= $${paramCount++}`);
      values.push(startDate);
    }

    if (endDate) {
      conditions.push(`created_at <= $${paramCount++}`);
      values.push(endDate);
    }

    const whereClause = conditions.join(' AND ');
    const allowedSortColumns = ['created_at', 'amount', 'status'];
    const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';

    const [dataResult, countResult] = await Promise.all([
      query<any>(
        `SELECT * FROM transactions
         WHERE ${whereClause}
         ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
         LIMIT $${paramCount++} OFFSET $${paramCount}`,
        [...values, limit, offset]
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM transactions WHERE ${whereClause}`,
        values
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    return {
      data: dataResult.rows.map(row => this.mapTransaction(row)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getStats(
    merchantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    totalVolume: number;
    totalTransactions: number;
    successRate: number;
    averageAmount: number;
  }> {
    const result = await query<any>(
      `SELECT
        COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as total_volume,
        COUNT(*) as total_transactions,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful,
        COALESCE(AVG(CASE WHEN status = 'completed' THEN amount END), 0) as average_amount
      FROM transactions
      WHERE merchant_id = $1
        AND type = 'charge'
        AND created_at >= $2
        AND created_at <= $3`,
      [merchantId, startDate, endDate]
    );

    const row = result.rows[0];
    const totalTransactions = parseInt(row.total_transactions);
    const successful = parseInt(row.successful);

    return {
      totalVolume: parseInt(row.total_volume),
      totalTransactions,
      successRate: totalTransactions > 0 ? (successful / totalTransactions) * 100 : 0,
      averageAmount: Math.round(parseFloat(row.average_amount)),
    };
  }

  private async updateMerchantBalance(
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

  private mapTransaction(row: any): Transaction {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      paymentMethodId: row.payment_method_id,
      type: row.type,
      status: row.status,
      amount: parseInt(row.amount),
      currency: row.currency,
      fee: parseInt(row.fee),
      netAmount: parseInt(row.net_amount),
      description: row.description,
      statementDescriptor: row.statement_descriptor,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      gatewayReference: row.gateway_reference,
      gatewayResponse: row.gateway_response,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      refundedAmount: parseInt(row.refunded_amount || 0),
      capturedAt: row.captured_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private sanitizeTransaction(transaction: Transaction): Partial<Transaction> {
    // Remove sensitive fields for webhooks
    const { gatewayResponse, ...safe } = transaction;
    return safe;
  }
}

export const transactionService = new TransactionService();
