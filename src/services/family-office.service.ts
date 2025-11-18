import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { eventBus } from '../core';

// ============================================
// TYPES
// ============================================

// Asset types
export type AssetClass =
  | 'cash' | 'fixed_income' | 'equities' | 'real_estate'
  | 'private_equity' | 'hedge_funds' | 'commodities'
  | 'crypto' | 'collectibles' | 'other';

// Family member role
export type FamilyRole =
  | 'patriarch' | 'matriarch' | 'spouse' | 'child'
  | 'grandchild' | 'trustee' | 'beneficiary' | 'advisor';

// Trust types
export type TrustType =
  | 'revocable' | 'irrevocable' | 'charitable' | 'generation_skipping'
  | 'special_needs' | 'spendthrift' | 'grantor' | 'testamentary';

// Distribution types
export type DistributionType = 'income' | 'principal' | 'discretionary' | 'mandatory';

// Interfaces
export interface FamilyMember {
  id: string;
  familyOfficeId: string;
  name: string;
  email?: string;
  role: FamilyRole;
  dateOfBirth?: string;
  relationship?: string;
  accessLevel: 'full' | 'limited' | 'view_only' | 'none';
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface Asset {
  id: string;
  familyOfficeId: string;
  memberId?: string;
  entityId?: string;
  assetClass: AssetClass;
  name: string;
  description?: string;
  custodian?: string;
  accountNumber?: string;
  acquisitionDate?: Date;
  acquisitionCost: number;
  currentValue: number;
  currency: string;
  lastValuationDate: Date;
  targetAllocation?: number;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface Portfolio {
  id: string;
  familyOfficeId: string;
  name: string;
  description?: string;
  targetAllocations: Record<AssetClass, number>;
  currentAllocations: Record<AssetClass, number>;
  totalValue: number;
  currency: string;
  rebalanceThreshold: number;
  lastRebalanceDate?: Date;
  createdAt: Date;
}

export interface Trust {
  id: string;
  familyOfficeId: string;
  name: string;
  trustType: TrustType;
  einTaxId?: string;
  jurisdiction: string;
  establishedDate: Date;
  grantors: string[];
  trustees: string[];
  beneficiaries: Array<{
    memberId: string;
    percentage: number;
    distributionType: DistributionType;
  }>;
  assets: string[];
  totalValue: number;
  currency: string;
  distributionSchedule?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface TrustDistribution {
  id: string;
  trustId: string;
  beneficiaryId: string;
  distributionType: DistributionType;
  amount: number;
  currency: string;
  reason: string;
  approvedBy: string;
  status: 'pending' | 'approved' | 'distributed' | 'rejected';
  distributedAt?: Date;
  createdAt: Date;
}

export interface EstateDocument {
  id: string;
  familyOfficeId: string;
  memberId: string;
  documentType: 'will' | 'poa' | 'healthcare_directive' | 'trust_agreement' | 'beneficiary_designation' | 'other';
  name: string;
  description?: string;
  fileUrl?: string;
  effectiveDate?: Date;
  expirationDate?: Date;
  reviewDate?: Date;
  status: 'draft' | 'active' | 'superseded' | 'revoked';
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface TaxLot {
  id: string;
  assetId: string;
  acquisitionDate: Date;
  quantity: number;
  costBasis: number;
  currentValue: number;
  currency: string;
  holdingPeriod: 'short_term' | 'long_term';
  unrealizedGainLoss: number;
  createdAt: Date;
}

export interface CharitableGift {
  id: string;
  familyOfficeId: string;
  memberId?: string;
  recipientName: string;
  recipientEin?: string;
  giftType: 'cash' | 'securities' | 'property' | 'in_kind';
  amount: number;
  fairMarketValue?: number;
  costBasis?: number;
  currency: string;
  taxYear: number;
  deductionAmount?: number;
  acknowledgmentReceived: boolean;
  purpose?: string;
  grantId?: string;
  createdAt: Date;
}

export interface FamilyMeeting {
  id: string;
  familyOfficeId: string;
  title: string;
  description?: string;
  meetingType: 'annual' | 'quarterly' | 'special' | 'education';
  scheduledAt: Date;
  location?: string;
  virtualLink?: string;
  attendees: string[];
  agenda?: string[];
  minutes?: string;
  decisions?: Array<{ topic: string; decision: string; votes?: Record<string, 'yes' | 'no' | 'abstain'> }>;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: Date;
}

export class FamilyOfficeService {
  // ============================================
  // FAMILY MANAGEMENT
  // ============================================

  async createFamilyOffice(
    merchantId: string,
    input: { name: string; primaryCurrency: string; metadata?: Record<string, any> }
  ): Promise<{ id: string; name: string }> {
    const id = uuidv4();
    await query(
      `INSERT INTO family_offices (id, merchant_id, name, primary_currency, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [id, merchantId, input.name, input.primaryCurrency, JSON.stringify(input.metadata || {})]
    );

    logger.info('Family office created', { id, name: input.name });
    return { id, name: input.name };
  }

  async addFamilyMember(
    familyOfficeId: string,
    input: {
      name: string;
      email?: string;
      role: FamilyRole;
      dateOfBirth?: string;
      relationship?: string;
      accessLevel: 'full' | 'limited' | 'view_only' | 'none';
      metadata?: Record<string, any>;
    }
  ): Promise<FamilyMember> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO family_members (
        id, family_office_id, name, email, role, date_of_birth,
        relationship, access_level, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *`,
      [
        id, familyOfficeId, input.name, input.email, input.role,
        input.dateOfBirth, input.relationship, input.accessLevel,
        JSON.stringify(input.metadata || {}),
      ]
    );

    return this.mapFamilyMember(result.rows[0]);
  }

  async getFamilyMembers(familyOfficeId: string): Promise<FamilyMember[]> {
    const result = await query<any>(
      `SELECT * FROM family_members WHERE family_office_id = $1 ORDER BY created_at`,
      [familyOfficeId]
    );
    return result.rows.map(row => this.mapFamilyMember(row));
  }

  // ============================================
  // WEALTH MANAGEMENT
  // ============================================

  async addAsset(
    familyOfficeId: string,
    input: {
      memberId?: string;
      entityId?: string;
      assetClass: AssetClass;
      name: string;
      description?: string;
      custodian?: string;
      accountNumber?: string;
      acquisitionDate?: Date;
      acquisitionCost: number;
      currentValue: number;
      currency: string;
      targetAllocation?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<Asset> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO family_assets (
        id, family_office_id, member_id, entity_id, asset_class, name, description,
        custodian, account_number, acquisition_date, acquisition_cost, current_value,
        currency, last_valuation_date, target_allocation, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14, $15, NOW())
      RETURNING *`,
      [
        id, familyOfficeId, input.memberId, input.entityId, input.assetClass,
        input.name, input.description, input.custodian, input.accountNumber,
        input.acquisitionDate, input.acquisitionCost, input.currentValue,
        input.currency, input.targetAllocation, JSON.stringify(input.metadata || {}),
      ]
    );

    return this.mapAsset(result.rows[0]);
  }

  async updateAssetValue(assetId: string, newValue: number): Promise<Asset> {
    const result = await query<any>(
      `UPDATE family_assets SET current_value = $1, last_valuation_date = NOW()
       WHERE id = $2 RETURNING *`,
      [newValue, assetId]
    );

    if (result.rows.length === 0) throw new NotFoundError('Asset');
    return this.mapAsset(result.rows[0]);
  }

  async getNetWorth(familyOfficeId: string): Promise<{
    totalAssets: number;
    byAssetClass: Record<AssetClass, number>;
    byMember: Record<string, number>;
    currency: string;
  }> {
    const result = await query<any>(
      `SELECT asset_class, member_id, SUM(current_value) as total
       FROM family_assets WHERE family_office_id = $1
       GROUP BY asset_class, member_id`,
      [familyOfficeId]
    );

    const byAssetClass: Record<string, number> = {};
    const byMember: Record<string, number> = {};
    let totalAssets = 0;

    for (const row of result.rows) {
      const value = parseInt(row.total);
      totalAssets += value;

      byAssetClass[row.asset_class] = (byAssetClass[row.asset_class] || 0) + value;
      if (row.member_id) {
        byMember[row.member_id] = (byMember[row.member_id] || 0) + value;
      }
    }

    return {
      totalAssets,
      byAssetClass: byAssetClass as Record<AssetClass, number>,
      byMember,
      currency: 'USD',
    };
  }

  async getAssetAllocation(familyOfficeId: string): Promise<{
    current: Record<AssetClass, number>;
    target?: Record<AssetClass, number>;
    rebalanceNeeded: AssetClass[];
  }> {
    const netWorth = await this.getNetWorth(familyOfficeId);
    const current: Record<string, number> = {};
    const rebalanceNeeded: AssetClass[] = [];

    for (const [assetClass, value] of Object.entries(netWorth.byAssetClass)) {
      current[assetClass] = Math.round((value / netWorth.totalAssets) * 10000) / 100;
    }

    return {
      current: current as Record<AssetClass, number>,
      rebalanceNeeded,
    };
  }

  async getPerformanceReport(
    familyOfficeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    periodReturn: number;
    twrReturn: number;
    benchmarkReturn?: number;
    byAssetClass: Record<AssetClass, number>;
  }> {
    // Simplified performance calculation
    const startValue = await this.getHistoricalValue(familyOfficeId, startDate);
    const endValue = await this.getHistoricalValue(familyOfficeId, endDate);

    const periodReturn = startValue > 0
      ? ((endValue - startValue) / startValue) * 100
      : 0;

    return {
      periodReturn: Math.round(periodReturn * 100) / 100,
      twrReturn: periodReturn, // Simplified
      byAssetClass: {} as Record<AssetClass, number>,
    };
  }

  // ============================================
  // TRUST SERVICES
  // ============================================

  async createTrust(
    familyOfficeId: string,
    input: {
      name: string;
      trustType: TrustType;
      einTaxId?: string;
      jurisdiction: string;
      establishedDate: Date;
      grantors: string[];
      trustees: string[];
      beneficiaries: Array<{ memberId: string; percentage: number; distributionType: DistributionType }>;
      distributionSchedule?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<Trust> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO family_trusts (
        id, family_office_id, name, trust_type, ein_tax_id, jurisdiction,
        established_date, grantors, trustees, beneficiaries, total_value,
        currency, distribution_schedule, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 'USD', $11, $12, NOW())
      RETURNING *`,
      [
        id, familyOfficeId, input.name, input.trustType, input.einTaxId,
        input.jurisdiction, input.establishedDate,
        JSON.stringify(input.grantors), JSON.stringify(input.trustees),
        JSON.stringify(input.beneficiaries), input.distributionSchedule,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('family_office.trust.created', {
      data: { trustId: id, trustType: input.trustType },
    });

    return this.mapTrust(result.rows[0]);
  }

  async requestDistribution(
    trustId: string,
    input: {
      beneficiaryId: string;
      distributionType: DistributionType;
      amount: number;
      currency: string;
      reason: string;
    }
  ): Promise<TrustDistribution> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO trust_distributions (
        id, trust_id, beneficiary_id, distribution_type, amount, currency,
        reason, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      RETURNING *`,
      [id, trustId, input.beneficiaryId, input.distributionType, input.amount, input.currency, input.reason]
    );

    return this.mapDistribution(result.rows[0]);
  }

  async approveDistribution(
    distributionId: string,
    approvedBy: string
  ): Promise<TrustDistribution> {
    const result = await query<any>(
      `UPDATE trust_distributions
       SET status = 'approved', approved_by = $1
       WHERE id = $2 RETURNING *`,
      [approvedBy, distributionId]
    );

    if (result.rows.length === 0) throw new NotFoundError('Distribution');
    return this.mapDistribution(result.rows[0]);
  }

  // ============================================
  // ESTATE PLANNING
  // ============================================

  async addEstateDocument(
    familyOfficeId: string,
    input: {
      memberId: string;
      documentType: EstateDocument['documentType'];
      name: string;
      description?: string;
      fileUrl?: string;
      effectiveDate?: Date;
      expirationDate?: Date;
      reviewDate?: Date;
      metadata?: Record<string, any>;
    }
  ): Promise<EstateDocument> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO estate_documents (
        id, family_office_id, member_id, document_type, name, description,
        file_url, effective_date, expiration_date, review_date, status, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, NOW())
      RETURNING *`,
      [
        id, familyOfficeId, input.memberId, input.documentType, input.name,
        input.description, input.fileUrl, input.effectiveDate,
        input.expirationDate, input.reviewDate, JSON.stringify(input.metadata || {}),
      ]
    );

    return this.mapEstateDocument(result.rows[0]);
  }

  async getEstateDocuments(
    familyOfficeId: string,
    memberId?: string
  ): Promise<EstateDocument[]> {
    let queryText = `SELECT * FROM estate_documents WHERE family_office_id = $1`;
    const params: any[] = [familyOfficeId];

    if (memberId) {
      queryText += ` AND member_id = $2`;
      params.push(memberId);
    }

    queryText += ` ORDER BY created_at DESC`;
    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapEstateDocument(row));
  }

  async getDocumentsNeedingReview(familyOfficeId: string): Promise<EstateDocument[]> {
    const result = await query<any>(
      `SELECT * FROM estate_documents
       WHERE family_office_id = $1 AND status = 'active'
       AND (review_date <= NOW() OR expiration_date <= NOW() + INTERVAL '30 days')`,
      [familyOfficeId]
    );
    return result.rows.map(row => this.mapEstateDocument(row));
  }

  // ============================================
  // TAX PLANNING
  // ============================================

  async recordTaxLot(
    assetId: string,
    input: {
      acquisitionDate: Date;
      quantity: number;
      costBasis: number;
      currentValue: number;
      currency: string;
    }
  ): Promise<TaxLot> {
    const holdingPeriod = this.calculateHoldingPeriod(input.acquisitionDate);
    const unrealizedGainLoss = input.currentValue - input.costBasis;

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO tax_lots (
        id, asset_id, acquisition_date, quantity, cost_basis, current_value,
        currency, holding_period, unrealized_gain_loss, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *`,
      [
        id, assetId, input.acquisitionDate, input.quantity, input.costBasis,
        input.currentValue, input.currency, holdingPeriod, unrealizedGainLoss,
      ]
    );

    return this.mapTaxLot(result.rows[0]);
  }

  async getTaxLotSummary(familyOfficeId: string, taxYear: number): Promise<{
    shortTermGains: number;
    shortTermLosses: number;
    longTermGains: number;
    longTermLosses: number;
    totalUnrealizedGains: number;
    harvestingOpportunities: TaxLot[];
  }> {
    const result = await query<any>(
      `SELECT tl.* FROM tax_lots tl
       JOIN family_assets fa ON tl.asset_id = fa.id
       WHERE fa.family_office_id = $1`,
      [familyOfficeId]
    );

    let shortTermGains = 0, shortTermLosses = 0;
    let longTermGains = 0, longTermLosses = 0;
    let totalUnrealizedGains = 0;
    const harvestingOpportunities: TaxLot[] = [];

    for (const row of result.rows) {
      const lot = this.mapTaxLot(row);
      totalUnrealizedGains += lot.unrealizedGainLoss;

      if (lot.holdingPeriod === 'short_term') {
        if (lot.unrealizedGainLoss > 0) shortTermGains += lot.unrealizedGainLoss;
        else shortTermLosses += Math.abs(lot.unrealizedGainLoss);
      } else {
        if (lot.unrealizedGainLoss > 0) longTermGains += lot.unrealizedGainLoss;
        else longTermLosses += Math.abs(lot.unrealizedGainLoss);
      }

      // Harvesting opportunity: significant unrealized loss
      if (lot.unrealizedGainLoss < -1000) {
        harvestingOpportunities.push(lot);
      }
    }

    return {
      shortTermGains, shortTermLosses,
      longTermGains, longTermLosses,
      totalUnrealizedGains,
      harvestingOpportunities,
    };
  }

  // ============================================
  // PHILANTHROPY
  // ============================================

  async recordCharitableGift(
    familyOfficeId: string,
    input: {
      memberId?: string;
      recipientName: string;
      recipientEin?: string;
      giftType: CharitableGift['giftType'];
      amount: number;
      fairMarketValue?: number;
      costBasis?: number;
      currency: string;
      taxYear: number;
      purpose?: string;
    }
  ): Promise<CharitableGift> {
    // Calculate deduction
    let deductionAmount = input.amount;
    if (input.giftType === 'securities' && input.fairMarketValue && input.costBasis) {
      // For appreciated securities, deduction is FMV (not cost basis)
      deductionAmount = input.fairMarketValue;
    }

    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO charitable_gifts (
        id, family_office_id, member_id, recipient_name, recipient_ein,
        gift_type, amount, fair_market_value, cost_basis, currency,
        tax_year, deduction_amount, acknowledgment_received, purpose, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, NOW())
      RETURNING *`,
      [
        id, familyOfficeId, input.memberId, input.recipientName, input.recipientEin,
        input.giftType, input.amount, input.fairMarketValue, input.costBasis,
        input.currency, input.taxYear, deductionAmount, input.purpose,
      ]
    );

    return this.mapCharitableGift(result.rows[0]);
  }

  async getCharitableGivingSummary(
    familyOfficeId: string,
    taxYear: number
  ): Promise<{
    totalGiving: number;
    totalDeductions: number;
    byRecipient: Record<string, number>;
    byType: Record<string, number>;
  }> {
    const result = await query<any>(
      `SELECT recipient_name, gift_type, SUM(amount) as total, SUM(deduction_amount) as deductions
       FROM charitable_gifts
       WHERE family_office_id = $1 AND tax_year = $2
       GROUP BY recipient_name, gift_type`,
      [familyOfficeId, taxYear]
    );

    let totalGiving = 0, totalDeductions = 0;
    const byRecipient: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const row of result.rows) {
      const amount = parseInt(row.total);
      totalGiving += amount;
      totalDeductions += parseInt(row.deductions);
      byRecipient[row.recipient_name] = (byRecipient[row.recipient_name] || 0) + amount;
      byType[row.gift_type] = (byType[row.gift_type] || 0) + amount;
    }

    return { totalGiving, totalDeductions, byRecipient, byType };
  }

  // ============================================
  // FAMILY GOVERNANCE
  // ============================================

  async scheduleMeeting(
    familyOfficeId: string,
    input: {
      title: string;
      description?: string;
      meetingType: FamilyMeeting['meetingType'];
      scheduledAt: Date;
      location?: string;
      virtualLink?: string;
      attendees: string[];
      agenda?: string[];
    }
  ): Promise<FamilyMeeting> {
    const id = uuidv4();
    const result = await query<any>(
      `INSERT INTO family_meetings (
        id, family_office_id, title, description, meeting_type,
        scheduled_at, location, virtual_link, attendees, agenda, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scheduled', NOW())
      RETURNING *`,
      [
        id, familyOfficeId, input.title, input.description, input.meetingType,
        input.scheduledAt, input.location, input.virtualLink,
        JSON.stringify(input.attendees), input.agenda ? JSON.stringify(input.agenda) : null,
      ]
    );

    return this.mapFamilyMeeting(result.rows[0]);
  }

  async recordMeetingMinutes(
    meetingId: string,
    minutes: string,
    decisions: Array<{ topic: string; decision: string; votes?: Record<string, 'yes' | 'no' | 'abstain'> }>
  ): Promise<FamilyMeeting> {
    const result = await query<any>(
      `UPDATE family_meetings
       SET minutes = $1, decisions = $2, status = 'completed'
       WHERE id = $3 RETURNING *`,
      [minutes, JSON.stringify(decisions), meetingId]
    );

    if (result.rows.length === 0) throw new NotFoundError('Meeting');
    return this.mapFamilyMeeting(result.rows[0]);
  }

  // ============================================
  // HELPERS
  // ============================================

  private async getHistoricalValue(familyOfficeId: string, date: Date): Promise<number> {
    // Simplified - in production would use historical valuation records
    const result = await query<any>(
      `SELECT SUM(current_value) as total FROM family_assets WHERE family_office_id = $1`,
      [familyOfficeId]
    );
    return parseInt(result.rows[0]?.total || 0);
  }

  private calculateHoldingPeriod(acquisitionDate: Date): 'short_term' | 'long_term' {
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    return (Date.now() - acquisitionDate.getTime()) > oneYear ? 'long_term' : 'short_term';
  }

  private mapFamilyMember(row: any): FamilyMember {
    return {
      id: row.id,
      familyOfficeId: row.family_office_id,
      name: row.name,
      email: row.email,
      role: row.role,
      dateOfBirth: row.date_of_birth,
      relationship: row.relationship,
      accessLevel: row.access_level,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private mapAsset(row: any): Asset {
    return {
      id: row.id,
      familyOfficeId: row.family_office_id,
      memberId: row.member_id,
      entityId: row.entity_id,
      assetClass: row.asset_class,
      name: row.name,
      description: row.description,
      custodian: row.custodian,
      accountNumber: row.account_number,
      acquisitionDate: row.acquisition_date,
      acquisitionCost: parseInt(row.acquisition_cost),
      currentValue: parseInt(row.current_value),
      currency: row.currency,
      lastValuationDate: row.last_valuation_date,
      targetAllocation: row.target_allocation ? parseFloat(row.target_allocation) : undefined,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private mapTrust(row: any): Trust {
    return {
      id: row.id,
      familyOfficeId: row.family_office_id,
      name: row.name,
      trustType: row.trust_type,
      einTaxId: row.ein_tax_id,
      jurisdiction: row.jurisdiction,
      establishedDate: row.established_date,
      grantors: row.grantors,
      trustees: row.trustees,
      beneficiaries: row.beneficiaries,
      assets: row.assets || [],
      totalValue: parseInt(row.total_value),
      currency: row.currency,
      distributionSchedule: row.distribution_schedule,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private mapDistribution(row: any): TrustDistribution {
    return {
      id: row.id,
      trustId: row.trust_id,
      beneficiaryId: row.beneficiary_id,
      distributionType: row.distribution_type,
      amount: parseInt(row.amount),
      currency: row.currency,
      reason: row.reason,
      approvedBy: row.approved_by,
      status: row.status,
      distributedAt: row.distributed_at,
      createdAt: row.created_at,
    };
  }

  private mapEstateDocument(row: any): EstateDocument {
    return {
      id: row.id,
      familyOfficeId: row.family_office_id,
      memberId: row.member_id,
      documentType: row.document_type,
      name: row.name,
      description: row.description,
      fileUrl: row.file_url,
      effectiveDate: row.effective_date,
      expirationDate: row.expiration_date,
      reviewDate: row.review_date,
      status: row.status,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  private mapTaxLot(row: any): TaxLot {
    return {
      id: row.id,
      assetId: row.asset_id,
      acquisitionDate: row.acquisition_date,
      quantity: parseFloat(row.quantity),
      costBasis: parseInt(row.cost_basis),
      currentValue: parseInt(row.current_value),
      currency: row.currency,
      holdingPeriod: row.holding_period,
      unrealizedGainLoss: parseInt(row.unrealized_gain_loss),
      createdAt: row.created_at,
    };
  }

  private mapCharitableGift(row: any): CharitableGift {
    return {
      id: row.id,
      familyOfficeId: row.family_office_id,
      memberId: row.member_id,
      recipientName: row.recipient_name,
      recipientEin: row.recipient_ein,
      giftType: row.gift_type,
      amount: parseInt(row.amount),
      fairMarketValue: row.fair_market_value ? parseInt(row.fair_market_value) : undefined,
      costBasis: row.cost_basis ? parseInt(row.cost_basis) : undefined,
      currency: row.currency,
      taxYear: row.tax_year,
      deductionAmount: row.deduction_amount ? parseInt(row.deduction_amount) : undefined,
      acknowledgmentReceived: row.acknowledgment_received,
      purpose: row.purpose,
      grantId: row.grant_id,
      createdAt: row.created_at,
    };
  }

  private mapFamilyMeeting(row: any): FamilyMeeting {
    return {
      id: row.id,
      familyOfficeId: row.family_office_id,
      title: row.title,
      description: row.description,
      meetingType: row.meeting_type,
      scheduledAt: row.scheduled_at,
      location: row.location,
      virtualLink: row.virtual_link,
      attendees: row.attendees,
      agenda: row.agenda,
      minutes: row.minutes,
      decisions: row.decisions,
      status: row.status,
      createdAt: row.created_at,
    };
  }
}

export const familyOfficeService = new FamilyOfficeService();
