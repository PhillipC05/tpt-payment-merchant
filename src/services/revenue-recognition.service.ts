// Revenue Recognition Service
// ASC 606 / IFRS 15 compliant revenue recognition

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';

// Revenue schedule types
export type RecognitionMethod =
  | 'point_in_time'      // Recognize at delivery/transfer
  | 'over_time'          // Recognize ratably over period
  | 'milestone'          // Recognize at milestones
  | 'output'             // Based on output delivered
  | 'input'              // Based on input/effort expended
  | 'usage';             // Based on actual usage

// Deferred revenue (contract liability)
export interface DeferredRevenue {
  id: string;
  merchantId: string;
  customerId: string;
  subscriptionId?: string;
  invoiceId?: string;
  transactionPrice: number;
  currency: string;
  recognizedAmount: number;
  deferredAmount: number;
  recognitionMethod: RecognitionMethod;
  recognitionStartDate: Date;
  recognitionEndDate: Date;
  performanceObligations: PerformanceObligation[];
  scheduleEntries: ScheduleEntry[];
  status: 'active' | 'completed' | 'cancelled';
  createdAt: Date;
}

// Performance obligation (ASC 606 Step 2)
export interface PerformanceObligation {
  id: string;
  description: string;
  standaloneSellingPrice: number;
  allocatedPrice: number;
  satisfactionPattern: 'point_in_time' | 'over_time';
  status: 'pending' | 'satisfied' | 'cancelled';
  satisfiedAt?: Date;
}

// Revenue schedule entry
export interface ScheduleEntry {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  amount: number;
  recognized: boolean;
  recognizedAt?: Date;
  journalEntryId?: string;
}

// Journal entry for double-entry accounting
export interface JournalEntry {
  id: string;
  merchantId: string;
  entryDate: Date;
  description: string;
  lines: JournalLine[];
  reference?: string;
  posted: boolean;
  postedAt?: Date;
}

export interface JournalLine {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

// Revenue summary report
export interface RevenueSummary {
  period: string;
  recognized: number;
  deferred: number;
  byMethod: Record<RecognitionMethod, number>;
  byProduct: { productId: string; productName: string; amount: number }[];
}

// Contract modification
export interface ContractModification {
  id: string;
  deferredRevenueId: string;
  modificationType: 'separate_contract' | 'termination_new' | 'cumulative_catchup';
  adjustmentAmount: number;
  reason: string;
  effectiveDate: Date;
  createdAt: Date;
}

export class RevenueRecognitionService {
  // Standard account codes
  private readonly ACCOUNTS = {
    DEFERRED_REVENUE: '2400',
    REVENUE: '4000',
    ACCOUNTS_RECEIVABLE: '1200',
  };

  // ==========================================
  // DEFERRED REVENUE
  // ==========================================

  // Create deferred revenue schedule for a transaction
  async createDeferredRevenue(
    merchantId: string,
    input: {
      customerId: string;
      subscriptionId?: string;
      invoiceId?: string;
      transactionPrice: number;
      currency: string;
      recognitionMethod: RecognitionMethod;
      recognitionStartDate: Date;
      recognitionEndDate: Date;
      performanceObligations: Omit<PerformanceObligation, 'id' | 'allocatedPrice'>[];
    }
  ): Promise<DeferredRevenue> {
    const deferredId = `def_${uuidv4().replace(/-/g, '')}`;

    // Step 3: Determine transaction price (already provided)
    const transactionPrice = input.transactionPrice;

    // Step 4: Allocate transaction price to performance obligations
    const totalSSP = input.performanceObligations.reduce(
      (sum, po) => sum + po.standaloneSellingPrice, 0
    );

    const allocatedObligations: PerformanceObligation[] = input.performanceObligations.map(po => ({
      id: `po_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
      description: po.description,
      standaloneSellingPrice: po.standaloneSellingPrice,
      allocatedPrice: Math.round((po.standaloneSellingPrice / totalSSP) * transactionPrice),
      satisfactionPattern: po.satisfactionPattern,
      status: po.status,
      satisfiedAt: po.satisfiedAt,
    }));

    // Adjust for rounding
    const allocatedTotal = allocatedObligations.reduce((sum, po) => sum + po.allocatedPrice, 0);
    if (allocatedTotal !== transactionPrice && allocatedObligations.length > 0) {
      allocatedObligations[0].allocatedPrice += (transactionPrice - allocatedTotal);
    }

    // Step 5: Generate recognition schedule
    const scheduleEntries = this.generateSchedule(
      transactionPrice,
      input.recognitionStartDate,
      input.recognitionEndDate,
      input.recognitionMethod
    );

    await query(
      `INSERT INTO deferred_revenue (
        id, merchant_id, customer_id, subscription_id, invoice_id,
        transaction_price, currency, recognized_amount, deferred_amount,
        recognition_method, recognition_start_date, recognition_end_date,
        performance_obligations, schedule_entries, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $6, $8, $9, $10, $11, $12, 'active', NOW())`,
      [
        deferredId, merchantId, input.customerId, input.subscriptionId, input.invoiceId,
        transactionPrice, input.currency, input.recognitionMethod,
        input.recognitionStartDate, input.recognitionEndDate,
        JSON.stringify(allocatedObligations), JSON.stringify(scheduleEntries)
      ]
    );

    logger.info('Deferred revenue created', {
      deferredId, merchantId, transactionPrice, method: input.recognitionMethod
    });

    return {
      id: deferredId,
      merchantId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      invoiceId: input.invoiceId,
      transactionPrice,
      currency: input.currency,
      recognizedAmount: 0,
      deferredAmount: transactionPrice,
      recognitionMethod: input.recognitionMethod,
      recognitionStartDate: input.recognitionStartDate,
      recognitionEndDate: input.recognitionEndDate,
      performanceObligations: allocatedObligations,
      scheduleEntries,
      status: 'active',
      createdAt: new Date(),
    };
  }

  // Generate recognition schedule based on method
  private generateSchedule(
    amount: number,
    startDate: Date,
    endDate: Date,
    method: RecognitionMethod
  ): ScheduleEntry[] {
    const entries: ScheduleEntry[] = [];

    switch (method) {
      case 'point_in_time':
        // Recognize all at once
        entries.push({
          id: `se_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
          periodStart: startDate,
          periodEnd: startDate,
          amount,
          recognized: false,
        });
        break;

      case 'over_time':
      case 'usage':
      default:
        // Recognize ratably over period (monthly)
        const months = this.monthsBetween(startDate, endDate);
        const monthlyAmount = Math.round(amount / months);
        let remaining = amount;

        let currentDate = new Date(startDate);
        for (let i = 0; i < months; i++) {
          const periodStart = new Date(currentDate);
          const periodEnd = new Date(currentDate);
          periodEnd.setMonth(periodEnd.getMonth() + 1);
          periodEnd.setDate(periodEnd.getDate() - 1);

          // Last period gets any remaining amount
          const periodAmount = i === months - 1 ? remaining : monthlyAmount;
          remaining -= periodAmount;

          entries.push({
            id: `se_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
            periodStart,
            periodEnd,
            amount: periodAmount,
            recognized: false,
          });

          currentDate.setMonth(currentDate.getMonth() + 1);
        }
        break;
    }

    return entries;
  }

  // Calculate months between two dates
  private monthsBetween(start: Date, end: Date): number {
    const months = (end.getFullYear() - start.getFullYear()) * 12
      + (end.getMonth() - start.getMonth()) + 1;
    return Math.max(1, months);
  }

  // ==========================================
  // REVENUE RECOGNITION
  // ==========================================

  // Process scheduled revenue recognition
  async processScheduledRecognition(asOfDate: Date = new Date()): Promise<{
    processed: number;
    totalAmount: number;
  }> {
    // Get all deferred revenue with unrecognized schedule entries
    const deferredResult = await query<any>(
      `SELECT * FROM deferred_revenue
       WHERE status = 'active'
       ORDER BY created_at`
    );

    let processed = 0;
    let totalAmount = 0;

    for (const row of deferredResult.rows) {
      const scheduleEntries: ScheduleEntry[] = row.schedule_entries;

      for (const entry of scheduleEntries) {
        if (!entry.recognized && new Date(entry.periodEnd) <= asOfDate) {
          // Recognize this entry
          await this.recognizeEntry(row.id, entry.id, row.merchant_id);
          processed++;
          totalAmount += entry.amount;
        }
      }
    }

    if (processed > 0) {
      logger.info('Processed scheduled recognition', { processed, totalAmount });
    }

    return { processed, totalAmount };
  }

  // Recognize a specific schedule entry
  async recognizeEntry(
    deferredId: string,
    entryId: string,
    merchantId: string
  ): Promise<JournalEntry> {
    // Get deferred revenue record
    const result = await query<any>(
      `SELECT * FROM deferred_revenue WHERE id = $1`,
      [deferredId]
    );

    if (result.rows.length === 0) {
      throw new Error('Deferred revenue not found');
    }

    const deferred = result.rows[0];
    const scheduleEntries: ScheduleEntry[] = deferred.schedule_entries;
    const entry = scheduleEntries.find(e => e.id === entryId);

    if (!entry) {
      throw new Error('Schedule entry not found');
    }

    if (entry.recognized) {
      throw new Error('Entry already recognized');
    }

    // Create journal entry
    const journalEntry = await this.createJournalEntry(merchantId, {
      entryDate: new Date(),
      description: `Revenue recognition - ${entry.periodStart} to ${entry.periodEnd}`,
      lines: [
        {
          accountCode: this.ACCOUNTS.DEFERRED_REVENUE,
          accountName: 'Deferred Revenue',
          debit: entry.amount,
          credit: 0,
        },
        {
          accountCode: this.ACCOUNTS.REVENUE,
          accountName: 'Revenue',
          debit: 0,
          credit: entry.amount,
        },
      ],
      reference: deferredId,
    });

    // Update entry as recognized
    entry.recognized = true;
    entry.recognizedAt = new Date();
    entry.journalEntryId = journalEntry.id;

    // Update deferred revenue record
    const newRecognized = deferred.recognized_amount + entry.amount;
    const newDeferred = deferred.deferred_amount - entry.amount;
    const newStatus = newDeferred <= 0 ? 'completed' : 'active';

    await query(
      `UPDATE deferred_revenue
       SET schedule_entries = $2, recognized_amount = $3,
           deferred_amount = $4, status = $5, updated_at = NOW()
       WHERE id = $1`,
      [deferredId, JSON.stringify(scheduleEntries), newRecognized, newDeferred, newStatus]
    );

    logger.info('Revenue recognized', {
      deferredId, entryId, amount: entry.amount, journalEntryId: journalEntry.id
    });

    return journalEntry;
  }

  // Satisfy performance obligation
  async satisfyPerformanceObligation(
    deferredId: string,
    obligationId: string
  ): Promise<void> {
    const result = await query<any>(
      `SELECT * FROM deferred_revenue WHERE id = $1`,
      [deferredId]
    );

    if (result.rows.length === 0) {
      throw new Error('Deferred revenue not found');
    }

    const obligations: PerformanceObligation[] = result.rows[0].performance_obligations;
    const obligation = obligations.find(o => o.id === obligationId);

    if (!obligation) {
      throw new Error('Performance obligation not found');
    }

    obligation.status = 'satisfied';
    obligation.satisfiedAt = new Date();

    await query(
      `UPDATE deferred_revenue SET performance_obligations = $2, updated_at = NOW() WHERE id = $1`,
      [deferredId, JSON.stringify(obligations)]
    );

    // If point-in-time satisfaction, recognize allocated amount
    if (obligation.satisfactionPattern === 'point_in_time') {
      // Create one-time recognition
      await this.recognizeAmount(deferredId, obligation.allocatedPrice, result.rows[0].merchant_id);
    }

    logger.info('Performance obligation satisfied', { deferredId, obligationId });
  }

  // Recognize specific amount (for point-in-time or manual recognition)
  private async recognizeAmount(
    deferredId: string,
    amount: number,
    merchantId: string
  ): Promise<void> {
    const journalEntry = await this.createJournalEntry(merchantId, {
      entryDate: new Date(),
      description: `Point-in-time revenue recognition`,
      lines: [
        {
          accountCode: this.ACCOUNTS.DEFERRED_REVENUE,
          accountName: 'Deferred Revenue',
          debit: amount,
          credit: 0,
        },
        {
          accountCode: this.ACCOUNTS.REVENUE,
          accountName: 'Revenue',
          debit: 0,
          credit: amount,
        },
      ],
      reference: deferredId,
    });

    // Update deferred revenue
    await query(
      `UPDATE deferred_revenue
       SET recognized_amount = recognized_amount + $2,
           deferred_amount = deferred_amount - $2,
           updated_at = NOW()
       WHERE id = $1`,
      [deferredId, amount]
    );
  }

  // ==========================================
  // CONTRACT MODIFICATIONS
  // ==========================================

  // Handle contract modification (ASC 606-10-25-10)
  async modifyContract(
    deferredId: string,
    modification: {
      type: ContractModification['modificationType'];
      adjustmentAmount: number;
      reason: string;
      effectiveDate?: Date;
    }
  ): Promise<ContractModification> {
    const modId = `mod_${uuidv4().replace(/-/g, '')}`;
    const effectiveDate = modification.effectiveDate || new Date();

    // Get current deferred revenue
    const result = await query<any>(
      `SELECT * FROM deferred_revenue WHERE id = $1`,
      [deferredId]
    );

    if (result.rows.length === 0) {
      throw new Error('Deferred revenue not found');
    }

    const deferred = result.rows[0];

    switch (modification.type) {
      case 'separate_contract':
        // Treat as separate contract - create new deferred revenue
        // The adjustment is handled separately
        break;

      case 'termination_new':
        // Cancel existing and create new
        await query(
          `UPDATE deferred_revenue SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
          [deferredId]
        );
        break;

      case 'cumulative_catchup':
        // Adjust remaining deferred and apply catch-up
        const scheduleEntries: ScheduleEntry[] = deferred.schedule_entries;

        // Find unrecognized entries and adjust
        let remainingAdjustment = modification.adjustmentAmount;
        for (const entry of scheduleEntries) {
          if (!entry.recognized && remainingAdjustment !== 0) {
            const oldAmount = entry.amount;
            entry.amount = Math.max(0, entry.amount + remainingAdjustment);
            remainingAdjustment -= (entry.amount - oldAmount);
          }
        }

        // Update transaction price and deferred amount
        const newTransactionPrice = deferred.transaction_price + modification.adjustmentAmount;
        const newDeferred = deferred.deferred_amount + modification.adjustmentAmount;

        await query(
          `UPDATE deferred_revenue
           SET transaction_price = $2, deferred_amount = $3,
               schedule_entries = $4, updated_at = NOW()
           WHERE id = $1`,
          [deferredId, newTransactionPrice, newDeferred, JSON.stringify(scheduleEntries)]
        );
        break;
    }

    // Store modification record
    await query(
      `INSERT INTO contract_modifications (
        id, deferred_revenue_id, modification_type, adjustment_amount,
        reason, effective_date, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [modId, deferredId, modification.type, modification.adjustmentAmount,
       modification.reason, effectiveDate]
    );

    logger.info('Contract modified', {
      modId, deferredId, type: modification.type, adjustment: modification.adjustmentAmount
    });

    return {
      id: modId,
      deferredRevenueId: deferredId,
      modificationType: modification.type,
      adjustmentAmount: modification.adjustmentAmount,
      reason: modification.reason,
      effectiveDate,
      createdAt: new Date(),
    };
  }

  // ==========================================
  // JOURNAL ENTRIES
  // ==========================================

  // Create journal entry
  async createJournalEntry(
    merchantId: string,
    input: {
      entryDate: Date;
      description: string;
      lines: JournalLine[];
      reference?: string;
    }
  ): Promise<JournalEntry> {
    // Validate debits = credits
    const totalDebits = input.lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredits = input.lines.reduce((sum, l) => sum + l.credit, 0);

    if (totalDebits !== totalCredits) {
      throw new Error('Journal entry must balance (debits must equal credits)');
    }

    const entryId = `je_${uuidv4().replace(/-/g, '')}`;

    await query(
      `INSERT INTO journal_entries (
        id, merchant_id, entry_date, description, lines, reference, posted, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, false, NOW())`,
      [entryId, merchantId, input.entryDate, input.description,
       JSON.stringify(input.lines), input.reference]
    );

    return {
      id: entryId,
      merchantId,
      entryDate: input.entryDate,
      description: input.description,
      lines: input.lines,
      reference: input.reference,
      posted: false,
    };
  }

  // Post journal entry
  async postJournalEntry(entryId: string): Promise<void> {
    await query(
      `UPDATE journal_entries SET posted = true, posted_at = NOW() WHERE id = $1`,
      [entryId]
    );
  }

  // ==========================================
  // REPORTING
  // ==========================================

  // Get revenue summary for a period
  async getRevenueSummary(
    merchantId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<RevenueSummary> {
    // Get recognized revenue in period
    const recognizedResult = await query<any>(
      `SELECT
        SUM(CASE WHEN se->>'recognized' = 'true' THEN (se->>'amount')::int ELSE 0 END) as recognized,
        recognition_method
       FROM deferred_revenue,
         jsonb_array_elements(schedule_entries) as se
       WHERE merchant_id = $1
         AND (se->>'recognizedAt')::timestamp >= $2
         AND (se->>'recognizedAt')::timestamp < $3
       GROUP BY recognition_method`,
      [merchantId, periodStart, periodEnd]
    );

    // Get current deferred balance
    const deferredResult = await query<any>(
      `SELECT SUM(deferred_amount) as deferred
       FROM deferred_revenue
       WHERE merchant_id = $1 AND status = 'active'`,
      [merchantId]
    );

    // Get revenue by product
    const byProductResult = await query<any>(
      `SELECT p.id as product_id, p.name as product_name,
        SUM(CASE WHEN se->>'recognized' = 'true' THEN (se->>'amount')::int ELSE 0 END) as amount
       FROM deferred_revenue dr
       JOIN subscriptions s ON s.id = dr.subscription_id
       JOIN subscription_items si ON si.subscription_id = s.id
       JOIN prices pr ON pr.id = si.price_id
       JOIN products p ON p.id = pr.product_id,
         jsonb_array_elements(dr.schedule_entries) as se
       WHERE dr.merchant_id = $1
         AND (se->>'recognizedAt')::timestamp >= $2
         AND (se->>'recognizedAt')::timestamp < $3
       GROUP BY p.id, p.name`,
      [merchantId, periodStart, periodEnd]
    );

    const byMethod: Record<RecognitionMethod, number> = {
      point_in_time: 0,
      over_time: 0,
      milestone: 0,
      output: 0,
      input: 0,
      usage: 0,
    };

    let totalRecognized = 0;
    for (const row of recognizedResult.rows) {
      const method = row.recognition_method as RecognitionMethod;
      const amount = parseInt(row.recognized) || 0;
      byMethod[method] = amount;
      totalRecognized += amount;
    }

    return {
      period: `${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`,
      recognized: totalRecognized,
      deferred: parseInt(deferredResult.rows[0]?.deferred) || 0,
      byMethod,
      byProduct: byProductResult.rows.map(r => ({
        productId: r.product_id,
        productName: r.product_name,
        amount: parseInt(r.amount) || 0,
      })),
    };
  }

  // Get deferred revenue waterfall (for forecasting)
  async getDeferredRevenueWaterfall(
    merchantId: string,
    months: number = 12
  ): Promise<{ period: string; amount: number }[]> {
    const waterfall: { period: string; amount: number }[] = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
      const periodStart = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + i + 1, 0);

      const result = await query<any>(
        `SELECT SUM((se->>'amount')::int) as amount
         FROM deferred_revenue,
           jsonb_array_elements(schedule_entries) as se
         WHERE merchant_id = $1
           AND status = 'active'
           AND se->>'recognized' = 'false'
           AND (se->>'periodEnd')::date >= $2
           AND (se->>'periodEnd')::date <= $3`,
        [merchantId, periodStart, periodEnd]
      );

      waterfall.push({
        period: `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}`,
        amount: parseInt(result.rows[0]?.amount) || 0,
      });
    }

    return waterfall;
  }

  // Get deferred revenue by customer
  async getDeferredByCustomer(merchantId: string): Promise<{
    customerId: string;
    deferred: number;
    recognized: number;
  }[]> {
    const result = await query<any>(
      `SELECT customer_id,
        SUM(deferred_amount) as deferred,
        SUM(recognized_amount) as recognized
       FROM deferred_revenue
       WHERE merchant_id = $1 AND status = 'active'
       GROUP BY customer_id
       ORDER BY deferred DESC`,
      [merchantId]
    );

    return result.rows.map(r => ({
      customerId: r.customer_id,
      deferred: parseInt(r.deferred) || 0,
      recognized: parseInt(r.recognized) || 0,
    }));
  }
}

export const revenueRecognitionService = new RevenueRecognitionService();
