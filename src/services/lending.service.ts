import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { RequireModule, PLATFORM_MODULES } from '../core/modules/module-system';
import { eventBus } from '../core';

// Types
export type LoanType = 'mca' | 'revenue_financing' | 'bnpl' | 'invoice_factoring';
export type LoanStatus = 'pending' | 'approved' | 'active' | 'repaying' | 'paid_off' | 'defaulted' | 'rejected';
export type BNPLPlan = '4_installments' | '6_installments' | '12_installments';

export interface LoanApplication {
  id: string;
  merchantId: string;
  customerId?: string; // For BNPL
  type: LoanType;
  requestedAmount: number;
  currency: string;
  status: LoanStatus;
  approvedAmount?: number;
  interestRate?: number;
  factorRate?: number; // For MCA
  termDays?: number;
  repaymentPercentage?: number; // For revenue financing
  totalRepayment?: number;
  amountRepaid: number;
  metadata?: Record<string, any>;
  appliedAt: Date;
  approvedAt?: Date;
  fundedAt?: Date;
  completedAt?: Date;
}

export interface BNPLPurchase {
  id: string;
  merchantId: string;
  customerId: string;
  transactionId: string;
  plan: BNPLPlan;
  totalAmount: number;
  currency: string;
  installmentAmount: number;
  installmentsPaid: number;
  totalInstallments: number;
  nextPaymentDate: Date;
  status: 'active' | 'completed' | 'defaulted';
  createdAt: Date;
}

export interface InvoiceFactoring {
  id: string;
  merchantId: string;
  invoiceId: string;
  invoiceAmount: number;
  advanceAmount: number;
  advancePercentage: number;
  feePercentage: number;
  feeAmount: number;
  currency: string;
  status: 'pending' | 'funded' | 'collected' | 'defaulted';
  fundedAt?: Date;
  collectedAt?: Date;
  createdAt: Date;
}

export class LendingService {
  // ============================================
  // MERCHANT CASH ADVANCE
  // ============================================

  @RequireModule(PLATFORM_MODULES.MERCHANT_CASH_ADVANCE)
  async applyForMCA(
    merchantId: string,
    input: {
      requestedAmount: number;
      currency: string;
      metadata?: Record<string, any>;
    }
  ): Promise<LoanApplication> {
    // Get merchant's transaction history for underwriting
    const stats = await this.getMerchantStats(merchantId, 90);

    // Simple underwriting - approve up to 1x monthly revenue
    const maxApproval = stats.monthlyRevenue;
    const approvedAmount = Math.min(input.requestedAmount, maxApproval);

    // Calculate factor rate based on risk (1.1 to 1.5)
    const riskScore = this.calculateRiskScore(stats);
    const factorRate = 1.1 + (riskScore / 100) * 0.4;
    const totalRepayment = Math.round(approvedAmount * factorRate);

    // Default repayment: 10-20% of daily sales
    const repaymentPercentage = 10 + (riskScore / 100) * 10;

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO loan_applications (
        id, merchant_id, type, requested_amount, currency, status,
        approved_amount, factor_rate, total_repayment, repayment_percentage,
        amount_repaid, metadata, applied_at, approved_at
      ) VALUES ($1, $2, 'mca', $3, $4, $5, $6, $7, $8, $9, 0, $10, NOW(), $11)
      RETURNING *`,
      [
        id,
        merchantId,
        input.requestedAmount,
        input.currency,
        approvedAmount > 0 ? 'approved' : 'rejected',
        approvedAmount,
        factorRate,
        totalRepayment,
        repaymentPercentage,
        JSON.stringify(input.metadata || {}),
        approvedAmount > 0 ? new Date() : null,
      ]
    );

    const application = this.mapLoanApplication(result.rows[0]);

    await eventBus.emit('lending.mca.applied', {
      merchantId,
      data: { application },
    });

    logger.info('MCA application processed', {
      id,
      merchantId,
      requested: input.requestedAmount,
      approved: approvedAmount,
    });

    return application;
  }

  @RequireModule(PLATFORM_MODULES.MERCHANT_CASH_ADVANCE)
  async fundMCA(merchantId: string, applicationId: string): Promise<LoanApplication> {
    const application = await this.getLoanApplication(applicationId, merchantId);

    if (application.status !== 'approved') {
      throw new ValidationError('Can only fund approved applications');
    }

    // Transfer funds to merchant balance
    await query(
      `UPDATE balances SET available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [application.approvedAmount, merchantId, application.currency]
    );

    // Update application status
    const result = await query<any>(
      `UPDATE loan_applications SET status = 'active', funded_at = NOW()
       WHERE id = $1 RETURNING *`,
      [applicationId]
    );

    await eventBus.emit('lending.mca.funded', {
      merchantId,
      data: { applicationId, amount: application.approvedAmount },
    });

    return this.mapLoanApplication(result.rows[0]);
  }

  // Process MCA repayment from transaction (called during payment processing)
  async processMCARepayment(
    merchantId: string,
    transactionAmount: number,
    currency: string
  ): Promise<void> {
    // Get active MCA loans
    const result = await query<any>(
      `SELECT * FROM loan_applications
       WHERE merchant_id = $1 AND type = 'mca' AND status = 'active' AND currency = $2`,
      [merchantId, currency]
    );

    for (const row of result.rows) {
      const loan = this.mapLoanApplication(row);
      const remaining = (loan.totalRepayment || 0) - loan.amountRepaid;

      if (remaining <= 0) continue;

      // Calculate repayment amount
      const repaymentPercent = loan.repaymentPercentage || 15;
      const repayment = Math.min(
        Math.round(transactionAmount * repaymentPercent / 100),
        remaining
      );

      // Apply repayment
      const newAmountRepaid = loan.amountRepaid + repayment;
      const newStatus = newAmountRepaid >= (loan.totalRepayment || 0) ? 'paid_off' : 'active';

      await query(
        `UPDATE loan_applications
         SET amount_repaid = $1, status = $2, completed_at = $3
         WHERE id = $4`,
        [
          newAmountRepaid,
          newStatus,
          newStatus === 'paid_off' ? new Date() : null,
          loan.id,
        ]
      );

      // Deduct from merchant balance
      await query(
        `UPDATE balances SET pending = pending - $1
         WHERE merchant_id = $2 AND currency = $3`,
        [repayment, merchantId, currency]
      );

      logger.debug('MCA repayment processed', {
        loanId: loan.id,
        repayment,
        remaining: remaining - repayment,
      });
    }
  }

  // ============================================
  // REVENUE-BASED FINANCING
  // ============================================

  @RequireModule(PLATFORM_MODULES.REVENUE_FINANCING)
  async applyForRevenueFinancing(
    merchantId: string,
    input: {
      requestedAmount: number;
      currency: string;
      termMonths: number;
      metadata?: Record<string, any>;
    }
  ): Promise<LoanApplication> {
    const stats = await this.getMerchantStats(merchantId, 180);

    // Approve up to 3x monthly revenue
    const maxApproval = stats.monthlyRevenue * 3;
    const approvedAmount = Math.min(input.requestedAmount, maxApproval);

    // Calculate interest rate based on risk and term
    const riskScore = this.calculateRiskScore(stats);
    const baseRate = 8 + (riskScore / 100) * 12; // 8-20% annual
    const interestRate = baseRate * (input.termMonths / 12);

    const totalRepayment = Math.round(approvedAmount * (1 + interestRate / 100));
    const repaymentPercentage = 5 + (riskScore / 100) * 10;

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO loan_applications (
        id, merchant_id, type, requested_amount, currency, status,
        approved_amount, interest_rate, term_days, total_repayment,
        repayment_percentage, amount_repaid, metadata, applied_at, approved_at
      ) VALUES ($1, $2, 'revenue_financing', $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, NOW(), $12)
      RETURNING *`,
      [
        id,
        merchantId,
        input.requestedAmount,
        input.currency,
        approvedAmount > 0 ? 'approved' : 'rejected',
        approvedAmount,
        interestRate,
        input.termMonths * 30,
        totalRepayment,
        repaymentPercentage,
        JSON.stringify(input.metadata || {}),
        approvedAmount > 0 ? new Date() : null,
      ]
    );

    return this.mapLoanApplication(result.rows[0]);
  }

  // ============================================
  // BUY NOW PAY LATER
  // ============================================

  @RequireModule(PLATFORM_MODULES.BNPL)
  async createBNPLPurchase(
    merchantId: string,
    input: {
      customerId: string;
      transactionId: string;
      totalAmount: number;
      currency: string;
      plan: BNPLPlan;
    }
  ): Promise<BNPLPurchase> {
    // Determine installments based on plan
    const installmentCounts: Record<BNPLPlan, number> = {
      '4_installments': 4,
      '6_installments': 6,
      '12_installments': 12,
    };

    const totalInstallments = installmentCounts[input.plan];
    const installmentAmount = Math.ceil(input.totalAmount / totalInstallments);

    // First installment is due today
    const nextPaymentDate = new Date();
    nextPaymentDate.setDate(nextPaymentDate.getDate() + 14); // Bi-weekly

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO bnpl_purchases (
        id, merchant_id, customer_id, transaction_id, plan,
        total_amount, currency, installment_amount, installments_paid,
        total_installments, next_payment_date, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, 'active', NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        input.customerId,
        input.transactionId,
        input.plan,
        input.totalAmount,
        input.currency,
        installmentAmount,
        totalInstallments,
        nextPaymentDate,
      ]
    );

    await eventBus.emit('lending.bnpl.created', {
      merchantId,
      data: { purchase: this.mapBNPLPurchase(result.rows[0]) },
    });

    return this.mapBNPLPurchase(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.BNPL)
  async processBNPLInstallment(purchaseId: string): Promise<BNPLPurchase> {
    const result = await query<any>(
      `SELECT * FROM bnpl_purchases WHERE id = $1`,
      [purchaseId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('BNPL Purchase');
    }

    const purchase = this.mapBNPLPurchase(result.rows[0]);

    if (purchase.status !== 'active') {
      throw new ValidationError('Purchase is not active');
    }

    // Process the installment payment
    // In real implementation, this would charge the customer's payment method
    const newInstallmentsPaid = purchase.installmentsPaid + 1;
    const isComplete = newInstallmentsPaid >= purchase.totalInstallments;

    // Calculate next payment date (bi-weekly)
    const nextPaymentDate = new Date();
    nextPaymentDate.setDate(nextPaymentDate.getDate() + 14);

    const updateResult = await query<any>(
      `UPDATE bnpl_purchases
       SET installments_paid = $1, status = $2, next_payment_date = $3
       WHERE id = $4
       RETURNING *`,
      [
        newInstallmentsPaid,
        isComplete ? 'completed' : 'active',
        isComplete ? null : nextPaymentDate,
        purchaseId,
      ]
    );

    return this.mapBNPLPurchase(updateResult.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.BNPL)
  async getCustomerBNPLPurchases(
    customerId: string,
    status?: 'active' | 'completed' | 'defaulted'
  ): Promise<BNPLPurchase[]> {
    let queryText = 'SELECT * FROM bnpl_purchases WHERE customer_id = $1';
    const params: any[] = [customerId];

    if (status) {
      queryText += ' AND status = $2';
      params.push(status);
    }

    queryText += ' ORDER BY created_at DESC';

    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapBNPLPurchase(row));
  }

  // ============================================
  // INVOICE FACTORING
  // ============================================

  @RequireModule(PLATFORM_MODULES.INVOICE_FACTORING)
  async factorInvoice(
    merchantId: string,
    input: {
      invoiceId: string;
      invoiceAmount: number;
      currency: string;
      advancePercentage?: number; // Default 80%
    }
  ): Promise<InvoiceFactoring> {
    // Verify invoice exists and is unpaid
    const invoiceResult = await query<any>(
      `SELECT * FROM invoices WHERE id = $1 AND merchant_id = $2`,
      [input.invoiceId, merchantId]
    );

    if (invoiceResult.rows.length === 0) {
      throw new NotFoundError('Invoice');
    }

    const invoice = invoiceResult.rows[0];
    if (invoice.status === 'paid') {
      throw new ValidationError('Invoice is already paid');
    }

    // Calculate advance
    const advancePercentage = input.advancePercentage || 80;
    const advanceAmount = Math.round(input.invoiceAmount * advancePercentage / 100);

    // Fee: 2-5% based on days until due
    const daysUntilDue = Math.max(1, Math.ceil(
      (new Date(invoice.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    ));
    const feePercentage = Math.min(5, 2 + (daysUntilDue / 30) * 1);
    const feeAmount = Math.round(advanceAmount * feePercentage / 100);

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO invoice_factoring (
        id, merchant_id, invoice_id, invoice_amount, advance_amount,
        advance_percentage, fee_percentage, fee_amount, currency, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW())
      RETURNING *`,
      [
        id,
        merchantId,
        input.invoiceId,
        input.invoiceAmount,
        advanceAmount,
        advancePercentage,
        feePercentage,
        feeAmount,
        input.currency,
      ]
    );

    return this.mapInvoiceFactoring(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.INVOICE_FACTORING)
  async fundFactoredInvoice(
    merchantId: string,
    factoringId: string
  ): Promise<InvoiceFactoring> {
    const result = await query<any>(
      `SELECT * FROM invoice_factoring WHERE id = $1 AND merchant_id = $2`,
      [factoringId, merchantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Invoice Factoring');
    }

    const factoring = this.mapInvoiceFactoring(result.rows[0]);

    if (factoring.status !== 'pending') {
      throw new ValidationError('Factoring is not pending');
    }

    // Transfer advance to merchant (minus fee)
    const netAdvance = factoring.advanceAmount - factoring.feeAmount;

    await query(
      `UPDATE balances SET available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [netAdvance, merchantId, factoring.currency]
    );

    // Update status
    const updateResult = await query<any>(
      `UPDATE invoice_factoring SET status = 'funded', funded_at = NOW()
       WHERE id = $1 RETURNING *`,
      [factoringId]
    );

    await eventBus.emit('lending.factoring.funded', {
      merchantId,
      data: { factoringId, netAdvance },
    });

    return this.mapInvoiceFactoring(updateResult.rows[0]);
  }

  // When invoice is paid, mark factoring as collected
  async markFactoringCollected(invoiceId: string): Promise<void> {
    await query(
      `UPDATE invoice_factoring SET status = 'collected', collected_at = NOW()
       WHERE invoice_id = $1 AND status = 'funded'`,
      [invoiceId]
    );
  }

  // ============================================
  // HELPERS
  // ============================================

  async getLoanApplication(id: string, merchantId?: string): Promise<LoanApplication> {
    let queryText = 'SELECT * FROM loan_applications WHERE id = $1';
    const params: any[] = [id];

    if (merchantId) {
      queryText += ' AND merchant_id = $2';
      params.push(merchantId);
    }

    const result = await query<any>(queryText, params);

    if (result.rows.length === 0) {
      throw new NotFoundError('Loan Application');
    }

    return this.mapLoanApplication(result.rows[0]);
  }

  async getMerchantLoans(
    merchantId: string,
    type?: LoanType,
    status?: LoanStatus
  ): Promise<LoanApplication[]> {
    let queryText = 'SELECT * FROM loan_applications WHERE merchant_id = $1';
    const params: any[] = [merchantId];
    let paramCount = 2;

    if (type) {
      queryText += ` AND type = $${paramCount++}`;
      params.push(type);
    }

    if (status) {
      queryText += ` AND status = $${paramCount++}`;
      params.push(status);
    }

    queryText += ' ORDER BY applied_at DESC';

    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapLoanApplication(row));
  }

  private async getMerchantStats(merchantId: string, days: number) {
    const result = await query<any>(
      `SELECT
        COALESCE(SUM(amount), 0) as total_volume,
        COUNT(*) as transaction_count,
        COALESCE(AVG(amount), 0) as avg_transaction,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM transactions
      WHERE merchant_id = $1
        AND type = 'charge'
        AND created_at >= NOW() - INTERVAL '${days} days'`,
      [merchantId]
    );

    const row = result.rows[0];
    const monthlyRevenue = Math.round(parseInt(row.total_volume) / (days / 30));

    return {
      totalVolume: parseInt(row.total_volume),
      transactionCount: parseInt(row.transaction_count),
      avgTransaction: parseFloat(row.avg_transaction),
      successRate: row.transaction_count > 0
        ? (parseInt(row.successful) / parseInt(row.transaction_count)) * 100
        : 0,
      monthlyRevenue,
    };
  }

  private calculateRiskScore(stats: any): number {
    // Simple risk score 0-100 (higher = more risk)
    let score = 50;

    // Lower volume = higher risk
    if (stats.monthlyRevenue < 10000) score += 20;
    else if (stats.monthlyRevenue > 100000) score -= 20;

    // Low success rate = higher risk
    if (stats.successRate < 90) score += 15;
    else if (stats.successRate > 98) score -= 10;

    // Low transaction count = higher risk
    if (stats.transactionCount < 100) score += 15;
    else if (stats.transactionCount > 1000) score -= 15;

    return Math.max(0, Math.min(100, score));
  }

  private mapLoanApplication(row: any): LoanApplication {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      type: row.type,
      requestedAmount: parseInt(row.requested_amount),
      currency: row.currency,
      status: row.status,
      approvedAmount: row.approved_amount ? parseInt(row.approved_amount) : undefined,
      interestRate: row.interest_rate ? parseFloat(row.interest_rate) : undefined,
      factorRate: row.factor_rate ? parseFloat(row.factor_rate) : undefined,
      termDays: row.term_days ? parseInt(row.term_days) : undefined,
      repaymentPercentage: row.repayment_percentage ? parseFloat(row.repayment_percentage) : undefined,
      totalRepayment: row.total_repayment ? parseInt(row.total_repayment) : undefined,
      amountRepaid: parseInt(row.amount_repaid || 0),
      metadata: row.metadata,
      appliedAt: row.applied_at,
      approvedAt: row.approved_at,
      fundedAt: row.funded_at,
      completedAt: row.completed_at,
    };
  }

  private mapBNPLPurchase(row: any): BNPLPurchase {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      transactionId: row.transaction_id,
      plan: row.plan,
      totalAmount: parseInt(row.total_amount),
      currency: row.currency,
      installmentAmount: parseInt(row.installment_amount),
      installmentsPaid: parseInt(row.installments_paid),
      totalInstallments: parseInt(row.total_installments),
      nextPaymentDate: row.next_payment_date,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private mapInvoiceFactoring(row: any): InvoiceFactoring {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      invoiceId: row.invoice_id,
      invoiceAmount: parseInt(row.invoice_amount),
      advanceAmount: parseInt(row.advance_amount),
      advancePercentage: parseFloat(row.advance_percentage),
      feePercentage: parseFloat(row.fee_percentage),
      feeAmount: parseInt(row.fee_amount),
      currency: row.currency,
      status: row.status,
      fundedAt: row.funded_at,
      collectedAt: row.collected_at,
      createdAt: row.created_at,
    };
  }
}

export const lendingService = new LendingService();
