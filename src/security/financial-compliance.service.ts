import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { eventBus } from '../core';

// SAR (Suspicious Activity Report) types
export type SARReason =
  | 'structuring'
  | 'unusual_pattern'
  | 'high_risk_jurisdiction'
  | 'rapid_movement'
  | 'unusual_business'
  | 'third_party_transfer'
  | 'customer_behavior'
  | 'other';

export type SARStatus = 'draft' | 'pending_review' | 'submitted' | 'acknowledged';

export interface SuspiciousActivityReport {
  id: string;
  merchantId: string;
  subjectId: string;
  subjectType: 'customer' | 'merchant';
  subjectName: string;
  reason: SARReason;
  description: string;
  transactionIds: string[];
  totalAmount: number;
  currency: string;
  status: SARStatus;
  filingReference?: string;
  filedBy?: string;
  filedAt?: Date;
  createdAt: Date;
}

// Reconciliation types
export type ReconciliationStatus = 'pending' | 'matched' | 'discrepancy' | 'resolved';

export interface ReconciliationRecord {
  id: string;
  merchantId: string;
  reconciliationType: 'daily' | 'weekly' | 'monthly';
  periodStart: Date;
  periodEnd: Date;
  status: ReconciliationStatus;
  expectedAmount: number;
  actualAmount: number;
  discrepancy: number;
  currency: string;
  transactionCount: number;
  matchedCount: number;
  unmatchedTransactions?: string[];
  notes?: string;
  reconciledBy?: string;
  reconciledAt?: Date;
  createdAt: Date;
}

// Transaction monitoring thresholds
const MONITORING_THRESHOLDS = {
  singleTransaction: 1000000, // $10,000
  dailyAggregate: 5000000, // $50,000
  structuringWindow: 86400000, // 24 hours
  structuringThreshold: 900000, // $9,000 (just under reporting threshold)
  velocityCount: 10, // transactions
  velocityWindow: 3600000, // 1 hour
};

export class FinancialComplianceService {
  // ============================================
  // SUSPICIOUS ACTIVITY REPORTING
  // ============================================

  // Monitor transaction for suspicious activity
  async monitorTransaction(transaction: {
    id: string;
    merchantId: string;
    customerId: string;
    amount: number;
    currency: string;
  }): Promise<{ suspicious: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    // Check single transaction threshold
    if (transaction.amount >= MONITORING_THRESHOLDS.singleTransaction) {
      reasons.push('Large single transaction');
    }

    // Check for structuring (multiple transactions just under threshold)
    const structuringCheck = await this.checkStructuring(
      transaction.customerId,
      transaction.amount
    );
    if (structuringCheck.isStructuring) {
      reasons.push('Potential structuring detected');
    }

    // Check velocity (many transactions in short period)
    const velocityCheck = await this.checkVelocity(transaction.customerId);
    if (velocityCheck.highVelocity) {
      reasons.push('High transaction velocity');
    }

    // Check daily aggregate
    const dailyAggregate = await this.getDailyAggregate(transaction.customerId);
    if (dailyAggregate + transaction.amount >= MONITORING_THRESHOLDS.dailyAggregate) {
      reasons.push('Daily aggregate threshold exceeded');
    }

    if (reasons.length > 0) {
      await eventBus.emit('compliance.suspicious_activity', {
        merchantId: transaction.merchantId,
        data: { transactionId: transaction.id, reasons },
      });

      logger.warn('Suspicious activity detected', {
        transactionId: transaction.id,
        reasons,
      });
    }

    return { suspicious: reasons.length > 0, reasons };
  }

  // Create SAR
  async createSAR(input: {
    merchantId: string;
    subjectId: string;
    subjectType: 'customer' | 'merchant';
    subjectName: string;
    reason: SARReason;
    description: string;
    transactionIds: string[];
    totalAmount: number;
    currency: string;
  }): Promise<SuspiciousActivityReport> {
    const id = uuidv4();

    const result = await query<any>(
      `INSERT INTO suspicious_activity_reports (
        id, merchant_id, subject_id, subject_type, subject_name,
        reason, description, transaction_ids, total_amount, currency,
        status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', NOW())
      RETURNING *`,
      [
        id,
        input.merchantId,
        input.subjectId,
        input.subjectType,
        input.subjectName,
        input.reason,
        input.description,
        JSON.stringify(input.transactionIds),
        input.totalAmount,
        input.currency,
      ]
    );

    logger.info('SAR created', { id, reason: input.reason });

    return this.mapSAR(result.rows[0]);
  }

  // Submit SAR for filing
  async submitSAR(sarId: string, filedBy: string): Promise<SuspiciousActivityReport> {
    // Generate filing reference
    const filingReference = `SAR-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    const result = await query<any>(
      `UPDATE suspicious_activity_reports
       SET status = 'submitted', filing_reference = $1, filed_by = $2, filed_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [filingReference, filedBy, sarId]
    );

    if (result.rows.length === 0) {
      throw new Error('SAR not found');
    }

    const sar = this.mapSAR(result.rows[0]);

    await eventBus.emit('compliance.sar.submitted', {
      merchantId: sar.merchantId,
      data: { sarId, filingReference },
    });

    logger.info('SAR submitted', { sarId, filingReference });

    return sar;
  }

  // Get SARs for merchant
  async getMerchantSARs(
    merchantId: string,
    status?: SARStatus
  ): Promise<SuspiciousActivityReport[]> {
    let queryText = `SELECT * FROM suspicious_activity_reports WHERE merchant_id = $1`;
    const params: any[] = [merchantId];

    if (status) {
      queryText += ` AND status = $2`;
      params.push(status);
    }

    queryText += ` ORDER BY created_at DESC`;

    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapSAR(row));
  }

  // ============================================
  // RECONCILIATION
  // ============================================

  // Run daily reconciliation
  async runReconciliation(
    merchantId: string,
    date: Date
  ): Promise<ReconciliationRecord> {
    const periodStart = new Date(date);
    periodStart.setHours(0, 0, 0, 0);

    const periodEnd = new Date(date);
    periodEnd.setHours(23, 59, 59, 999);

    // Get platform transaction totals
    const platformResult = await query<any>(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'charge' AND status = 'completed' THEN amount ELSE 0 END), 0) as charges,
        COALESCE(SUM(CASE WHEN type = 'refund' AND status = 'completed' THEN amount ELSE 0 END), 0) as refunds,
        COUNT(*) as transaction_count
       FROM transactions
       WHERE merchant_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [merchantId, periodStart, periodEnd]
    );

    const charges = parseInt(platformResult.rows[0].charges);
    const refunds = parseInt(platformResult.rows[0].refunds);
    const expectedAmount = charges - refunds;
    const transactionCount = parseInt(platformResult.rows[0].transaction_count);

    // Get actual settled amounts (from gateway settlements)
    // In production, this would query the gateway's settlement reports
    const actualAmount = expectedAmount; // Simulated

    const discrepancy = actualAmount - expectedAmount;
    const status: ReconciliationStatus = discrepancy === 0 ? 'matched' : 'discrepancy';

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO reconciliation_records (
        id, merchant_id, reconciliation_type, period_start, period_end,
        status, expected_amount, actual_amount, discrepancy, currency,
        transaction_count, matched_count, created_at
      ) VALUES ($1, $2, 'daily', $3, $4, $5, $6, $7, $8, 'USD', $9, $9, NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        periodStart,
        periodEnd,
        status,
        expectedAmount,
        actualAmount,
        discrepancy,
        transactionCount,
      ]
    );

    const record = this.mapReconciliation(result.rows[0]);

    if (status === 'discrepancy') {
      await eventBus.emit('compliance.reconciliation.discrepancy', {
        merchantId,
        data: { reconciliationId: id, discrepancy },
      });

      logger.warn('Reconciliation discrepancy', {
        id,
        merchantId,
        expected: expectedAmount,
        actual: actualAmount,
        discrepancy,
      });
    }

    return record;
  }

  // Resolve discrepancy
  async resolveDiscrepancy(
    reconciliationId: string,
    notes: string,
    reconciledBy: string
  ): Promise<ReconciliationRecord> {
    const result = await query<any>(
      `UPDATE reconciliation_records
       SET status = 'resolved', notes = $1, reconciled_by = $2, reconciled_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [notes, reconciledBy, reconciliationId]
    );

    if (result.rows.length === 0) {
      throw new Error('Reconciliation record not found');
    }

    return this.mapReconciliation(result.rows[0]);
  }

  // Get reconciliation history
  async getReconciliationHistory(
    merchantId: string,
    days: number = 30
  ): Promise<ReconciliationRecord[]> {
    const result = await query<any>(
      `SELECT * FROM reconciliation_records
       WHERE merchant_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
       ORDER BY period_start DESC`,
      [merchantId]
    );

    return result.rows.map(row => this.mapReconciliation(row));
  }

  // ============================================
  // CTR (Currency Transaction Report)
  // ============================================

  // Check if CTR is required
  async checkCTRRequired(
    customerId: string,
    amount: number
  ): Promise<{ required: boolean; reason?: string }> {
    // CTR required for cash transactions over $10,000
    if (amount >= 1000000) {
      return { required: true, reason: 'Single transaction over $10,000' };
    }

    // Check aggregated cash transactions in 24 hours
    const aggregate = await this.getDailyAggregate(customerId);
    if (aggregate + amount >= 1000000) {
      return { required: true, reason: 'Aggregated transactions over $10,000' };
    }

    return { required: false };
  }

  // ============================================
  // HELPERS
  // ============================================

  private async checkStructuring(
    customerId: string,
    currentAmount: number
  ): Promise<{ isStructuring: boolean; transactions: string[] }> {
    // Look for multiple transactions just under the reporting threshold
    const windowStart = new Date(Date.now() - MONITORING_THRESHOLDS.structuringWindow);

    const result = await query<any>(
      `SELECT id, amount FROM transactions
       WHERE customer_id = $1
         AND created_at > $2
         AND amount >= $3
         AND amount < $4
         AND status = 'completed'`,
      [
        customerId,
        windowStart,
        MONITORING_THRESHOLDS.structuringThreshold * 0.8, // 80% of threshold
        MONITORING_THRESHOLDS.singleTransaction,
      ]
    );

    // If 3+ transactions in this range, flag as potential structuring
    if (result.rows.length >= 2 &&
        currentAmount >= MONITORING_THRESHOLDS.structuringThreshold * 0.8) {
      return {
        isStructuring: true,
        transactions: result.rows.map((r: any) => r.id),
      };
    }

    return { isStructuring: false, transactions: [] };
  }

  private async checkVelocity(
    customerId: string
  ): Promise<{ highVelocity: boolean; count: number }> {
    const windowStart = new Date(Date.now() - MONITORING_THRESHOLDS.velocityWindow);

    const result = await query<any>(
      `SELECT COUNT(*) as count FROM transactions
       WHERE customer_id = $1 AND created_at > $2`,
      [customerId, windowStart]
    );

    const count = parseInt(result.rows[0].count);

    return {
      highVelocity: count >= MONITORING_THRESHOLDS.velocityCount,
      count,
    };
  }

  private async getDailyAggregate(customerId: string): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await query<any>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE customer_id = $1
         AND created_at >= $2
         AND status = 'completed'
         AND type = 'charge'`,
      [customerId, today]
    );

    return parseInt(result.rows[0].total);
  }

  private mapSAR(row: any): SuspiciousActivityReport {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      subjectId: row.subject_id,
      subjectType: row.subject_type,
      subjectName: row.subject_name,
      reason: row.reason,
      description: row.description,
      transactionIds: row.transaction_ids,
      totalAmount: parseInt(row.total_amount),
      currency: row.currency,
      status: row.status,
      filingReference: row.filing_reference,
      filedBy: row.filed_by,
      filedAt: row.filed_at,
      createdAt: row.created_at,
    };
  }

  private mapReconciliation(row: any): ReconciliationRecord {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      reconciliationType: row.reconciliation_type,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      status: row.status,
      expectedAmount: parseInt(row.expected_amount),
      actualAmount: parseInt(row.actual_amount),
      discrepancy: parseInt(row.discrepancy),
      currency: row.currency,
      transactionCount: parseInt(row.transaction_count),
      matchedCount: parseInt(row.matched_count),
      unmatchedTransactions: row.unmatched_transactions,
      notes: row.notes,
      reconciledBy: row.reconciled_by,
      reconciledAt: row.reconciled_at,
      createdAt: row.created_at,
    };
  }
}

export const financialComplianceService = new FinancialComplianceService();
