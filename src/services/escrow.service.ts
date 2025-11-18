import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { RequireModule, PLATFORM_MODULES } from '../core/modules/module-system';
import { eventBus } from '../core';

// Types
export type EscrowStatus = 'pending' | 'funded' | 'released' | 'disputed' | 'refunded' | 'cancelled';

export interface EscrowAccount {
  id: string;
  merchantId: string;
  buyerId: string;
  sellerId: string;
  transactionId?: string;
  amount: number;
  fee: number;
  currency: string;
  status: EscrowStatus;
  description: string;
  releaseConditions?: string[];
  milestones?: Milestone[];
  metadata?: Record<string, any>;
  fundedAt?: Date;
  releasedAt?: Date;
  createdAt: Date;
}

export interface Milestone {
  id: string;
  name: string;
  amount: number;
  status: 'pending' | 'completed' | 'released';
  completedAt?: Date;
  releasedAt?: Date;
}

export interface EscrowDispute {
  id: string;
  escrowId: string;
  initiatedBy: 'buyer' | 'seller';
  reason: string;
  evidence?: Record<string, any>;
  status: 'open' | 'under_review' | 'resolved';
  resolution?: string;
  resolvedInFavorOf?: 'buyer' | 'seller' | 'split';
  createdAt: Date;
  resolvedAt?: Date;
}

export class EscrowService {
  // ============================================
  // MARKETPLACE ESCROW
  // ============================================

  @RequireModule(PLATFORM_MODULES.MARKETPLACE_ESCROW)
  async createEscrow(
    merchantId: string,
    input: {
      buyerId: string;
      sellerId: string;
      amount: number;
      currency: string;
      description: string;
      releaseConditions?: string[];
      metadata?: Record<string, any>;
    }
  ): Promise<EscrowAccount> {
    const fee = Math.round(input.amount * 0.01); // 1% escrow fee
    const id = uuidv4();

    const result = await query<any>(
      `INSERT INTO escrow_accounts (
        id, merchant_id, buyer_id, seller_id, amount, fee, currency,
        status, description, release_conditions, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, NOW())
      RETURNING *`,
      [
        id, merchantId, input.buyerId, input.sellerId, input.amount, fee,
        input.currency, input.description,
        input.releaseConditions ? JSON.stringify(input.releaseConditions) : null,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('escrow.created', {
      merchantId,
      data: { escrowId: id, amount: input.amount },
    });

    return this.mapEscrowAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MARKETPLACE_ESCROW)
  async fundEscrow(merchantId: string, escrowId: string): Promise<EscrowAccount> {
    const escrow = await this.getEscrow(escrowId, merchantId);

    if (escrow.status !== 'pending') {
      throw new ValidationError('Escrow is not pending');
    }

    // In real implementation, this would charge the buyer
    const result = await query<any>(
      `UPDATE escrow_accounts SET status = 'funded', funded_at = NOW()
       WHERE id = $1 RETURNING *`,
      [escrowId]
    );

    await eventBus.emit('escrow.funded', {
      merchantId,
      data: { escrowId, amount: escrow.amount },
    });

    return this.mapEscrowAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MARKETPLACE_ESCROW)
  async releaseEscrow(merchantId: string, escrowId: string): Promise<EscrowAccount> {
    const escrow = await this.getEscrow(escrowId, merchantId);

    if (escrow.status !== 'funded') {
      throw new ValidationError('Escrow is not funded');
    }

    // Release funds to seller
    const sellerAmount = escrow.amount - escrow.fee;

    await query(
      `UPDATE balances SET available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [sellerAmount, escrow.sellerId, escrow.currency]
    );

    const result = await query<any>(
      `UPDATE escrow_accounts SET status = 'released', released_at = NOW()
       WHERE id = $1 RETURNING *`,
      [escrowId]
    );

    await eventBus.emit('escrow.released', {
      merchantId,
      data: { escrowId, sellerId: escrow.sellerId, amount: sellerAmount },
    });

    return this.mapEscrowAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MARKETPLACE_ESCROW)
  async refundEscrow(merchantId: string, escrowId: string): Promise<EscrowAccount> {
    const escrow = await this.getEscrow(escrowId, merchantId);

    if (escrow.status !== 'funded') {
      throw new ValidationError('Escrow is not funded');
    }

    // Refund to buyer (full amount, fee absorbed)
    await query(
      `UPDATE balances SET available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [escrow.amount, escrow.buyerId, escrow.currency]
    );

    const result = await query<any>(
      `UPDATE escrow_accounts SET status = 'refunded' WHERE id = $1 RETURNING *`,
      [escrowId]
    );

    await eventBus.emit('escrow.refunded', {
      merchantId,
      data: { escrowId, buyerId: escrow.buyerId, amount: escrow.amount },
    });

    return this.mapEscrowAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MARKETPLACE_ESCROW)
  async disputeEscrow(
    escrowId: string,
    input: {
      initiatedBy: 'buyer' | 'seller';
      reason: string;
      evidence?: Record<string, any>;
    }
  ): Promise<EscrowDispute> {
    const id = uuidv4();

    // Update escrow status
    await query(
      `UPDATE escrow_accounts SET status = 'disputed' WHERE id = $1`,
      [escrowId]
    );

    const result = await query<any>(
      `INSERT INTO escrow_disputes (
        id, escrow_id, initiated_by, reason, evidence, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'open', NOW())
      RETURNING *`,
      [id, escrowId, input.initiatedBy, input.reason, JSON.stringify(input.evidence || {})]
    );

    return this.mapDispute(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MARKETPLACE_ESCROW)
  async resolveDispute(
    disputeId: string,
    resolution: {
      resolvedInFavorOf: 'buyer' | 'seller' | 'split';
      splitPercentage?: number; // For buyer if split
      notes: string;
    }
  ): Promise<{ dispute: EscrowDispute; escrow: EscrowAccount }> {
    const disputeResult = await query<any>(
      `SELECT * FROM escrow_disputes WHERE id = $1`,
      [disputeId]
    );

    if (disputeResult.rows.length === 0) {
      throw new NotFoundError('Escrow Dispute');
    }

    const dispute = this.mapDispute(disputeResult.rows[0]);
    const escrow = await this.getEscrow(dispute.escrowId);

    // Distribute funds based on resolution
    if (resolution.resolvedInFavorOf === 'buyer') {
      await query(
        `UPDATE balances SET available = available + $1
         WHERE merchant_id = $2 AND currency = $3`,
        [escrow.amount, escrow.buyerId, escrow.currency]
      );
    } else if (resolution.resolvedInFavorOf === 'seller') {
      const sellerAmount = escrow.amount - escrow.fee;
      await query(
        `UPDATE balances SET available = available + $1
         WHERE merchant_id = $2 AND currency = $3`,
        [sellerAmount, escrow.sellerId, escrow.currency]
      );
    } else {
      // Split
      const buyerPct = resolution.splitPercentage || 50;
      const buyerAmount = Math.round(escrow.amount * buyerPct / 100);
      const sellerAmount = escrow.amount - buyerAmount - escrow.fee;

      await query(
        `UPDATE balances SET available = available + $1
         WHERE merchant_id = $2 AND currency = $3`,
        [buyerAmount, escrow.buyerId, escrow.currency]
      );

      await query(
        `UPDATE balances SET available = available + $1
         WHERE merchant_id = $2 AND currency = $3`,
        [sellerAmount, escrow.sellerId, escrow.currency]
      );
    }

    // Update dispute
    const updatedDispute = await query<any>(
      `UPDATE escrow_disputes
       SET status = 'resolved', resolved_in_favor_of = $1, resolution = $2, resolved_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [resolution.resolvedInFavorOf, resolution.notes, disputeId]
    );

    // Update escrow
    const updatedEscrow = await query<any>(
      `UPDATE escrow_accounts SET status = 'released' WHERE id = $1 RETURNING *`,
      [dispute.escrowId]
    );

    return {
      dispute: this.mapDispute(updatedDispute.rows[0]),
      escrow: this.mapEscrowAccount(updatedEscrow.rows[0]),
    };
  }

  // ============================================
  // MILESTONE PAYMENTS
  // ============================================

  @RequireModule(PLATFORM_MODULES.MILESTONE_PAYMENTS)
  async createMilestoneEscrow(
    merchantId: string,
    input: {
      buyerId: string;
      sellerId: string;
      totalAmount: number;
      currency: string;
      description: string;
      milestones: Array<{ name: string; amount: number }>;
      metadata?: Record<string, any>;
    }
  ): Promise<EscrowAccount> {
    const fee = Math.round(input.totalAmount * 0.005); // 0.5% for milestone escrow
    const id = uuidv4();

    // Validate milestones add up
    const milestoneTotal = input.milestones.reduce((sum, m) => sum + m.amount, 0);
    if (milestoneTotal !== input.totalAmount) {
      throw new ValidationError('Milestone amounts must equal total amount');
    }

    const milestones: Milestone[] = input.milestones.map(m => ({
      id: uuidv4(),
      name: m.name,
      amount: m.amount,
      status: 'pending',
    }));

    const result = await query<any>(
      `INSERT INTO escrow_accounts (
        id, merchant_id, buyer_id, seller_id, amount, fee, currency,
        status, description, milestones, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, NOW())
      RETURNING *`,
      [
        id, merchantId, input.buyerId, input.sellerId, input.totalAmount, fee,
        input.currency, input.description, JSON.stringify(milestones),
        JSON.stringify(input.metadata || {}),
      ]
    );

    return this.mapEscrowAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MILESTONE_PAYMENTS)
  async completeMilestone(
    merchantId: string,
    escrowId: string,
    milestoneId: string
  ): Promise<EscrowAccount> {
    const escrow = await this.getEscrow(escrowId, merchantId);

    if (!escrow.milestones) {
      throw new ValidationError('Escrow has no milestones');
    }

    const milestone = escrow.milestones.find(m => m.id === milestoneId);
    if (!milestone) {
      throw new NotFoundError('Milestone');
    }

    if (milestone.status !== 'pending') {
      throw new ValidationError('Milestone already completed');
    }

    milestone.status = 'completed';
    milestone.completedAt = new Date();

    const result = await query<any>(
      `UPDATE escrow_accounts SET milestones = $1 WHERE id = $2 RETURNING *`,
      [JSON.stringify(escrow.milestones), escrowId]
    );

    return this.mapEscrowAccount(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.MILESTONE_PAYMENTS)
  async releaseMilestone(
    merchantId: string,
    escrowId: string,
    milestoneId: string
  ): Promise<EscrowAccount> {
    const escrow = await this.getEscrow(escrowId, merchantId);

    if (!escrow.milestones) {
      throw new ValidationError('Escrow has no milestones');
    }

    const milestone = escrow.milestones.find(m => m.id === milestoneId);
    if (!milestone) {
      throw new NotFoundError('Milestone');
    }

    if (milestone.status !== 'completed') {
      throw new ValidationError('Milestone not completed');
    }

    // Calculate proportional fee
    const milestoneFee = Math.round(escrow.fee * milestone.amount / escrow.amount);
    const sellerAmount = milestone.amount - milestoneFee;

    // Release to seller
    await query(
      `UPDATE balances SET available = available + $1
       WHERE merchant_id = $2 AND currency = $3`,
      [sellerAmount, escrow.sellerId, escrow.currency]
    );

    milestone.status = 'released';
    milestone.releasedAt = new Date();

    // Check if all milestones are released
    const allReleased = escrow.milestones.every(m => m.status === 'released');

    const result = await query<any>(
      `UPDATE escrow_accounts SET milestones = $1, status = $2
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(escrow.milestones), allReleased ? 'released' : 'funded', escrowId]
    );

    await eventBus.emit('escrow.milestone.released', {
      merchantId,
      data: { escrowId, milestoneId, amount: sellerAmount },
    });

    return this.mapEscrowAccount(result.rows[0]);
  }

  // ============================================
  // HELPERS
  // ============================================

  async getEscrow(escrowId: string, merchantId?: string): Promise<EscrowAccount> {
    let queryText = 'SELECT * FROM escrow_accounts WHERE id = $1';
    const params: any[] = [escrowId];

    if (merchantId) {
      queryText += ' AND merchant_id = $2';
      params.push(merchantId);
    }

    const result = await query<any>(queryText, params);

    if (result.rows.length === 0) {
      throw new NotFoundError('Escrow Account');
    }

    return this.mapEscrowAccount(result.rows[0]);
  }

  async getMerchantEscrows(merchantId: string, status?: EscrowStatus): Promise<EscrowAccount[]> {
    let queryText = 'SELECT * FROM escrow_accounts WHERE merchant_id = $1';
    const params: any[] = [merchantId];

    if (status) {
      queryText += ' AND status = $2';
      params.push(status);
    }

    queryText += ' ORDER BY created_at DESC';
    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapEscrowAccount(row));
  }

  private mapEscrowAccount(row: any): EscrowAccount {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      buyerId: row.buyer_id,
      sellerId: row.seller_id,
      transactionId: row.transaction_id,
      amount: parseInt(row.amount),
      fee: parseInt(row.fee),
      currency: row.currency,
      status: row.status,
      description: row.description,
      releaseConditions: row.release_conditions,
      milestones: row.milestones,
      metadata: row.metadata,
      fundedAt: row.funded_at,
      releasedAt: row.released_at,
      createdAt: row.created_at,
    };
  }

  private mapDispute(row: any): EscrowDispute {
    return {
      id: row.id,
      escrowId: row.escrow_id,
      initiatedBy: row.initiated_by,
      reason: row.reason,
      evidence: row.evidence,
      status: row.status,
      resolution: row.resolution,
      resolvedInFavorOf: row.resolved_in_favor_of,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }
}

export const escrowService = new EscrowService();
