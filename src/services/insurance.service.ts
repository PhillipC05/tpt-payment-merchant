import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { RequireModule, PLATFORM_MODULES } from '../core/modules/module-system';
import { eventBus } from '../core';

// Types
export type InsuranceType = 'chargeback' | 'fraud' | 'shipping';
export type ClaimStatus = 'pending' | 'under_review' | 'approved' | 'denied' | 'paid';

export interface InsurancePolicy {
  id: string;
  merchantId: string;
  type: InsuranceType;
  coverageAmount: number;
  premium: number;
  deductible: number;
  currency: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  createdAt: Date;
}

export interface InsuranceClaim {
  id: string;
  policyId: string;
  merchantId: string;
  type: InsuranceType;
  transactionId?: string;
  claimAmount: number;
  approvedAmount?: number;
  currency: string;
  status: ClaimStatus;
  reason: string;
  evidence?: Record<string, any>;
  reviewNotes?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export class InsuranceService {
  // ============================================
  // CHARGEBACK PROTECTION
  // ============================================

  @RequireModule(PLATFORM_MODULES.CHARGEBACK_PROTECTION)
  async enrollChargebackProtection(
    merchantId: string,
    input: { coverageAmount: number; currency: string }
  ): Promise<InsurancePolicy> {
    // Premium: 0.4% of coverage
    const premium = Math.round(input.coverageAmount * 0.004);
    const deductible = Math.round(input.coverageAmount * 0.05); // 5% deductible

    return this.createPolicy(merchantId, {
      type: 'chargeback',
      coverageAmount: input.coverageAmount,
      premium,
      deductible,
      currency: input.currency,
      durationDays: 30,
    });
  }

  @RequireModule(PLATFORM_MODULES.CHARGEBACK_PROTECTION)
  async fileChargebackClaim(
    merchantId: string,
    input: {
      transactionId: string;
      claimAmount: number;
      reason: string;
      evidence?: Record<string, any>;
    }
  ): Promise<InsuranceClaim> {
    const policy = await this.getActivePolicy(merchantId, 'chargeback');
    if (!policy) {
      throw new ValidationError('No active chargeback protection policy');
    }

    return this.createClaim(merchantId, {
      policyId: policy.id,
      type: 'chargeback',
      transactionId: input.transactionId,
      claimAmount: input.claimAmount,
      currency: policy.currency,
      reason: input.reason,
      evidence: input.evidence,
    });
  }

  // ============================================
  // FRAUD GUARANTEE
  // ============================================

  @RequireModule(PLATFORM_MODULES.FRAUD_GUARANTEE)
  async enrollFraudGuarantee(
    merchantId: string,
    input: { coverageAmount: number; currency: string }
  ): Promise<InsurancePolicy> {
    const premium = Math.round(input.coverageAmount * 0.003); // 0.3%
    const deductible = 0; // No deductible for fraud guarantee

    return this.createPolicy(merchantId, {
      type: 'fraud',
      coverageAmount: input.coverageAmount,
      premium,
      deductible,
      currency: input.currency,
      durationDays: 30,
    });
  }

  @RequireModule(PLATFORM_MODULES.FRAUD_GUARANTEE)
  async fileFraudClaim(
    merchantId: string,
    input: {
      transactionId: string;
      claimAmount: number;
      fraudType: string;
      evidence?: Record<string, any>;
    }
  ): Promise<InsuranceClaim> {
    const policy = await this.getActivePolicy(merchantId, 'fraud');
    if (!policy) {
      throw new ValidationError('No active fraud guarantee policy');
    }

    return this.createClaim(merchantId, {
      policyId: policy.id,
      type: 'fraud',
      transactionId: input.transactionId,
      claimAmount: input.claimAmount,
      currency: policy.currency,
      reason: `Fraud type: ${input.fraudType}`,
      evidence: input.evidence,
    });
  }

  // ============================================
  // SHIPPING INSURANCE
  // ============================================

  @RequireModule(PLATFORM_MODULES.SHIPPING_INSURANCE)
  async enrollShippingInsurance(
    merchantId: string,
    input: { coverageAmount: number; currency: string }
  ): Promise<InsurancePolicy> {
    const premium = Math.round(input.coverageAmount * 0.015); // 1.5%
    const deductible = Math.round(input.coverageAmount * 0.1); // 10% deductible

    return this.createPolicy(merchantId, {
      type: 'shipping',
      coverageAmount: input.coverageAmount,
      premium,
      deductible,
      currency: input.currency,
      durationDays: 30,
    });
  }

  @RequireModule(PLATFORM_MODULES.SHIPPING_INSURANCE)
  async fileShippingClaim(
    merchantId: string,
    input: {
      transactionId: string;
      claimAmount: number;
      trackingNumber: string;
      issueType: 'lost' | 'damaged' | 'stolen';
      evidence?: Record<string, any>;
    }
  ): Promise<InsuranceClaim> {
    const policy = await this.getActivePolicy(merchantId, 'shipping');
    if (!policy) {
      throw new ValidationError('No active shipping insurance policy');
    }

    return this.createClaim(merchantId, {
      policyId: policy.id,
      type: 'shipping',
      transactionId: input.transactionId,
      claimAmount: input.claimAmount,
      currency: policy.currency,
      reason: `${input.issueType} - Tracking: ${input.trackingNumber}`,
      evidence: input.evidence,
    });
  }

  // ============================================
  // COMMON OPERATIONS
  // ============================================

  async getMerchantPolicies(merchantId: string): Promise<InsurancePolicy[]> {
    const result = await query<any>(
      `SELECT * FROM insurance_policies WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [merchantId]
    );
    return result.rows.map(row => this.mapPolicy(row));
  }

  async getMerchantClaims(merchantId: string, status?: ClaimStatus): Promise<InsuranceClaim[]> {
    let queryText = `SELECT * FROM insurance_claims WHERE merchant_id = $1`;
    const params: any[] = [merchantId];

    if (status) {
      queryText += ` AND status = $2`;
      params.push(status);
    }

    queryText += ` ORDER BY created_at DESC`;
    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapClaim(row));
  }

  async reviewClaim(
    claimId: string,
    decision: { approved: boolean; approvedAmount?: number; notes?: string }
  ): Promise<InsuranceClaim> {
    const status = decision.approved ? 'approved' : 'denied';

    const result = await query<any>(
      `UPDATE insurance_claims
       SET status = $1, approved_amount = $2, review_notes = $3, resolved_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, decision.approvedAmount, decision.notes, claimId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Insurance Claim');
    }

    const claim = this.mapClaim(result.rows[0]);

    if (decision.approved && decision.approvedAmount) {
      await eventBus.emit('insurance.claim.approved', {
        merchantId: claim.merchantId,
        data: { claimId, approvedAmount: decision.approvedAmount },
      });
    }

    return claim;
  }

  async payoutClaim(claimId: string): Promise<InsuranceClaim> {
    const claimResult = await query<any>(
      `SELECT * FROM insurance_claims WHERE id = $1 AND status = 'approved'`,
      [claimId]
    );

    if (claimResult.rows.length === 0) {
      throw new ValidationError('Claim not approved or not found');
    }

    const claim = this.mapClaim(claimResult.rows[0]);

    // Add to merchant balance
    await query(
      `UPDATE balances SET available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [claim.approvedAmount, claim.merchantId, claim.currency]
    );

    // Update claim status
    const result = await query<any>(
      `UPDATE insurance_claims SET status = 'paid' WHERE id = $1 RETURNING *`,
      [claimId]
    );

    return this.mapClaim(result.rows[0]);
  }

  // ============================================
  // HELPERS
  // ============================================

  private async createPolicy(
    merchantId: string,
    input: {
      type: InsuranceType;
      coverageAmount: number;
      premium: number;
      deductible: number;
      currency: string;
      durationDays: number;
    }
  ): Promise<InsurancePolicy> {
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + input.durationDays);

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO insurance_policies (
        id, merchant_id, type, coverage_amount, premium, deductible,
        currency, start_date, end_date, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW())
      RETURNING *`,
      [
        id, merchantId, input.type, input.coverageAmount, input.premium,
        input.deductible, input.currency, startDate, endDate,
      ]
    );

    await eventBus.emit('insurance.policy.created', {
      merchantId,
      data: { policyId: id, type: input.type },
    });

    return this.mapPolicy(result.rows[0]);
  }

  private async createClaim(
    merchantId: string,
    input: {
      policyId: string;
      type: InsuranceType;
      transactionId?: string;
      claimAmount: number;
      currency: string;
      reason: string;
      evidence?: Record<string, any>;
    }
  ): Promise<InsuranceClaim> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO insurance_claims (
        id, policy_id, merchant_id, type, transaction_id, claim_amount,
        currency, status, reason, evidence, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, NOW())
      RETURNING *`,
      [
        id, input.policyId, merchantId, input.type, input.transactionId,
        input.claimAmount, input.currency, input.reason,
        JSON.stringify(input.evidence || {}),
      ]
    );

    await eventBus.emit('insurance.claim.filed', {
      merchantId,
      data: { claimId: id, type: input.type, amount: input.claimAmount },
    });

    return this.mapClaim(result.rows[0]);
  }

  private async getActivePolicy(merchantId: string, type: InsuranceType): Promise<InsurancePolicy | null> {
    const result = await query<any>(
      `SELECT * FROM insurance_policies
       WHERE merchant_id = $1 AND type = $2 AND is_active = true AND end_date > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [merchantId, type]
    );

    return result.rows.length > 0 ? this.mapPolicy(result.rows[0]) : null;
  }

  private mapPolicy(row: any): InsurancePolicy {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      type: row.type,
      coverageAmount: parseInt(row.coverage_amount),
      premium: parseInt(row.premium),
      deductible: parseInt(row.deductible),
      currency: row.currency,
      startDate: row.start_date,
      endDate: row.end_date,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }

  private mapClaim(row: any): InsuranceClaim {
    return {
      id: row.id,
      policyId: row.policy_id,
      merchantId: row.merchant_id,
      type: row.type,
      transactionId: row.transaction_id,
      claimAmount: parseInt(row.claim_amount),
      approvedAmount: row.approved_amount ? parseInt(row.approved_amount) : undefined,
      currency: row.currency,
      status: row.status,
      reason: row.reason,
      evidence: row.evidence,
      reviewNotes: row.review_notes,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }
}

export const insuranceService = new InsuranceService();
