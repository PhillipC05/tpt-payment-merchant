import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { RequireModule, PLATFORM_MODULES } from '../core/modules/module-system';
import { eventBus } from '../core';

// Types
export type VerificationStatus = 'pending' | 'in_progress' | 'approved' | 'rejected' | 'expired';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface KYCVerification {
  id: string;
  merchantId: string;
  customerId: string;
  status: VerificationStatus;
  riskLevel?: RiskLevel;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
  documentType?: 'passport' | 'drivers_license' | 'national_id';
  documentNumber?: string;
  verificationResults?: {
    identityMatch: boolean;
    addressMatch: boolean;
    ageVerified: boolean;
    documentAuthentic?: boolean;
    facialMatch?: boolean;
  };
  metadata?: Record<string, any>;
  createdAt: Date;
  verifiedAt?: Date;
  expiresAt?: Date;
}

export interface KYBVerification {
  id: string;
  merchantId: string;
  businessId: string;
  status: VerificationStatus;
  riskLevel?: RiskLevel;
  businessName: string;
  businessType: string;
  registrationNumber: string;
  taxId: string;
  incorporationCountry: string;
  incorporationDate?: string;
  address: Record<string, string>;
  beneficialOwners?: Array<{
    name: string;
    ownershipPercentage: number;
    verified: boolean;
  }>;
  verificationResults?: {
    businessExists: boolean;
    registrationValid: boolean;
    taxIdValid: boolean;
    addressVerified: boolean;
    ownersVerified?: boolean;
  };
  metadata?: Record<string, any>;
  createdAt: Date;
  verifiedAt?: Date;
}

export interface AMLScreening {
  id: string;
  merchantId: string;
  entityId: string;
  entityType: 'individual' | 'business';
  entityName: string;
  status: 'clear' | 'potential_match' | 'confirmed_match';
  screeningResults?: {
    sanctionsList: boolean;
    pepList: boolean;
    adverseMedia: boolean;
    watchlists: boolean;
  };
  matches?: Array<{
    listName: string;
    matchScore: number;
    matchedName: string;
    details?: Record<string, any>;
  }>;
  reviewedBy?: string;
  reviewNotes?: string;
  createdAt: Date;
  reviewedAt?: Date;
}

export interface MonitoringAlert {
  id: string;
  merchantId: string;
  entityId: string;
  entityType: 'individual' | 'business';
  alertType: 'sanctions_update' | 'adverse_media' | 'risk_change' | 'document_expiry';
  severity: RiskLevel;
  description: string;
  status: 'open' | 'reviewed' | 'dismissed';
  createdAt: Date;
  reviewedAt?: Date;
}

export class ComplianceService {
  // ============================================
  // KYC VERIFICATION
  // ============================================

  @RequireModule(PLATFORM_MODULES.KYC_VERIFICATION)
  async initiateKYC(
    merchantId: string,
    input: {
      customerId: string;
      firstName: string;
      lastName: string;
      dateOfBirth: string;
      address: {
        line1: string;
        line2?: string;
        city: string;
        state?: string;
        postalCode: string;
        country: string;
      };
      documentType?: 'passport' | 'drivers_license' | 'national_id';
      documentNumber?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<KYCVerification> {
    const id = uuidv4();

    const result = await query<any>(
      `INSERT INTO kyc_verifications (
        id, merchant_id, customer_id, status, first_name, last_name,
        date_of_birth, address, document_type, document_number, metadata, created_at
      ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *`,
      [
        id, merchantId, input.customerId, input.firstName, input.lastName,
        input.dateOfBirth, JSON.stringify(input.address), input.documentType,
        input.documentNumber, JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('compliance.kyc.initiated', {
      merchantId,
      data: { verificationId: id, customerId: input.customerId },
    });

    return this.mapKYCVerification(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.KYC_VERIFICATION)
  async processKYC(verificationId: string): Promise<KYCVerification> {
    const result = await query<any>(
      `SELECT * FROM kyc_verifications WHERE id = $1`,
      [verificationId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('KYC Verification');
    }

    // In production, this would call verification providers (Jumio, Onfido, etc.)
    // Simulated verification
    const verificationResults = {
      identityMatch: Math.random() > 0.1,
      addressMatch: Math.random() > 0.15,
      ageVerified: true,
      documentAuthentic: Math.random() > 0.05,
      facialMatch: Math.random() > 0.1,
    };

    const allPassed = Object.values(verificationResults).every(v => v);
    const status = allPassed ? 'approved' : 'rejected';
    const riskLevel = this.calculateRiskLevel(verificationResults);

    // Set expiry for approved verifications (1 year)
    const expiresAt = status === 'approved'
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : null;

    const updateResult = await query<any>(
      `UPDATE kyc_verifications
       SET status = $1, risk_level = $2, verification_results = $3,
           verified_at = NOW(), expires_at = $4
       WHERE id = $5
       RETURNING *`,
      [status, riskLevel, JSON.stringify(verificationResults), expiresAt, verificationId]
    );

    const verification = this.mapKYCVerification(updateResult.rows[0]);

    await eventBus.emit('compliance.kyc.completed', {
      merchantId: verification.merchantId,
      data: { verificationId, status, riskLevel },
    });

    return verification;
  }

  // ============================================
  // KYB VERIFICATION
  // ============================================

  @RequireModule(PLATFORM_MODULES.KYB_VERIFICATION)
  async initiateKYB(
    merchantId: string,
    input: {
      businessId: string;
      businessName: string;
      businessType: string;
      registrationNumber: string;
      taxId: string;
      incorporationCountry: string;
      incorporationDate?: string;
      address: Record<string, string>;
      beneficialOwners?: Array<{
        name: string;
        ownershipPercentage: number;
      }>;
      metadata?: Record<string, any>;
    }
  ): Promise<KYBVerification> {
    const id = uuidv4();

    const beneficialOwners = input.beneficialOwners?.map(owner => ({
      ...owner,
      verified: false,
    }));

    const result = await query<any>(
      `INSERT INTO kyb_verifications (
        id, merchant_id, business_id, status, business_name, business_type,
        registration_number, tax_id, incorporation_country, incorporation_date,
        address, beneficial_owners, metadata, created_at
      ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      RETURNING *`,
      [
        id, merchantId, input.businessId, input.businessName, input.businessType,
        input.registrationNumber, input.taxId, input.incorporationCountry,
        input.incorporationDate, JSON.stringify(input.address),
        beneficialOwners ? JSON.stringify(beneficialOwners) : null,
        JSON.stringify(input.metadata || {}),
      ]
    );

    await eventBus.emit('compliance.kyb.initiated', {
      merchantId,
      data: { verificationId: id, businessId: input.businessId },
    });

    return this.mapKYBVerification(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.KYB_VERIFICATION)
  async processKYB(verificationId: string): Promise<KYBVerification> {
    const result = await query<any>(
      `SELECT * FROM kyb_verifications WHERE id = $1`,
      [verificationId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('KYB Verification');
    }

    // Simulated verification
    const verificationResults = {
      businessExists: Math.random() > 0.05,
      registrationValid: Math.random() > 0.1,
      taxIdValid: Math.random() > 0.1,
      addressVerified: Math.random() > 0.15,
      ownersVerified: Math.random() > 0.2,
    };

    const allPassed = Object.values(verificationResults).every(v => v);
    const status = allPassed ? 'approved' : 'rejected';
    const riskLevel = this.calculateRiskLevel(verificationResults);

    const updateResult = await query<any>(
      `UPDATE kyb_verifications
       SET status = $1, risk_level = $2, verification_results = $3, verified_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, riskLevel, JSON.stringify(verificationResults), verificationId]
    );

    const verification = this.mapKYBVerification(updateResult.rows[0]);

    await eventBus.emit('compliance.kyb.completed', {
      merchantId: verification.merchantId,
      data: { verificationId, status, riskLevel },
    });

    return verification;
  }

  // ============================================
  // AML SCREENING
  // ============================================

  @RequireModule(PLATFORM_MODULES.AML_SCREENING)
  async screenEntity(
    merchantId: string,
    input: {
      entityId: string;
      entityType: 'individual' | 'business';
      entityName: string;
      additionalInfo?: {
        dateOfBirth?: string;
        country?: string;
        aliases?: string[];
      };
    }
  ): Promise<AMLScreening> {
    const id = uuidv4();

    // Simulated screening against watchlists
    const screeningResults = {
      sanctionsList: Math.random() > 0.98,
      pepList: Math.random() > 0.95,
      adverseMedia: Math.random() > 0.9,
      watchlists: Math.random() > 0.97,
    };

    const hasMatches = Object.values(screeningResults).some(v => v);
    const status = hasMatches ? 'potential_match' : 'clear';

    // Generate mock matches if hits found
    const matches = hasMatches ? [
      {
        listName: screeningResults.sanctionsList ? 'OFAC SDN' : 'PEP Database',
        matchScore: 75 + Math.floor(Math.random() * 25),
        matchedName: input.entityName,
        details: { source: 'Screening Provider' },
      },
    ] : [];

    const result = await query<any>(
      `INSERT INTO aml_screenings (
        id, merchant_id, entity_id, entity_type, entity_name, status,
        screening_results, matches, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *`,
      [
        id, merchantId, input.entityId, input.entityType, input.entityName,
        status, JSON.stringify(screeningResults), JSON.stringify(matches),
      ]
    );

    if (hasMatches) {
      await eventBus.emit('compliance.aml.match', {
        merchantId,
        data: { screeningId: id, entityId: input.entityId, status },
      });
    }

    return this.mapAMLScreening(result.rows[0]);
  }

  @RequireModule(PLATFORM_MODULES.AML_SCREENING)
  async reviewScreening(
    screeningId: string,
    review: {
      status: 'clear' | 'confirmed_match';
      reviewedBy: string;
      notes: string;
    }
  ): Promise<AMLScreening> {
    const result = await query<any>(
      `UPDATE aml_screenings
       SET status = $1, reviewed_by = $2, review_notes = $3, reviewed_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [review.status, review.reviewedBy, review.notes, screeningId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('AML Screening');
    }

    return this.mapAMLScreening(result.rows[0]);
  }

  // ============================================
  // ONGOING MONITORING
  // ============================================

  @RequireModule(PLATFORM_MODULES.ONGOING_MONITORING)
  async enrollMonitoring(
    merchantId: string,
    input: {
      entityId: string;
      entityType: 'individual' | 'business';
      entityName: string;
    }
  ): Promise<{ enrolled: boolean; entityId: string }> {
    await query(
      `INSERT INTO monitored_entities (
        id, merchant_id, entity_id, entity_type, entity_name, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, true, NOW())
      ON CONFLICT (merchant_id, entity_id) DO UPDATE SET is_active = true`,
      [uuidv4(), merchantId, input.entityId, input.entityType, input.entityName]
    );

    return { enrolled: true, entityId: input.entityId };
  }

  @RequireModule(PLATFORM_MODULES.ONGOING_MONITORING)
  async getAlerts(
    merchantId: string,
    status?: 'open' | 'reviewed' | 'dismissed'
  ): Promise<MonitoringAlert[]> {
    let queryText = `SELECT * FROM monitoring_alerts WHERE merchant_id = $1`;
    const params: any[] = [merchantId];

    if (status) {
      queryText += ` AND status = $2`;
      params.push(status);
    }

    queryText += ` ORDER BY created_at DESC`;
    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapAlert(row));
  }

  @RequireModule(PLATFORM_MODULES.ONGOING_MONITORING)
  async reviewAlert(
    alertId: string,
    action: 'reviewed' | 'dismissed'
  ): Promise<MonitoringAlert> {
    const result = await query<any>(
      `UPDATE monitoring_alerts SET status = $1, reviewed_at = NOW()
       WHERE id = $2 RETURNING *`,
      [action, alertId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Monitoring Alert');
    }

    return this.mapAlert(result.rows[0]);
  }

  // ============================================
  // HELPERS
  // ============================================

  async getKYCStatus(merchantId: string, customerId: string): Promise<KYCVerification | null> {
    const result = await query<any>(
      `SELECT * FROM kyc_verifications
       WHERE merchant_id = $1 AND customer_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [merchantId, customerId]
    );

    return result.rows.length > 0 ? this.mapKYCVerification(result.rows[0]) : null;
  }

  async getKYBStatus(merchantId: string, businessId: string): Promise<KYBVerification | null> {
    const result = await query<any>(
      `SELECT * FROM kyb_verifications
       WHERE merchant_id = $1 AND business_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [merchantId, businessId]
    );

    return result.rows.length > 0 ? this.mapKYBVerification(result.rows[0]) : null;
  }

  private calculateRiskLevel(results: Record<string, boolean>): RiskLevel {
    const failedCount = Object.values(results).filter(v => !v).length;
    if (failedCount === 0) return 'low';
    if (failedCount === 1) return 'medium';
    if (failedCount === 2) return 'high';
    return 'critical';
  }

  private mapKYCVerification(row: any): KYCVerification {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      status: row.status,
      riskLevel: row.risk_level,
      firstName: row.first_name,
      lastName: row.last_name,
      dateOfBirth: row.date_of_birth,
      address: row.address,
      documentType: row.document_type,
      documentNumber: row.document_number,
      verificationResults: row.verification_results,
      metadata: row.metadata,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
      expiresAt: row.expires_at,
    };
  }

  private mapKYBVerification(row: any): KYBVerification {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      businessId: row.business_id,
      status: row.status,
      riskLevel: row.risk_level,
      businessName: row.business_name,
      businessType: row.business_type,
      registrationNumber: row.registration_number,
      taxId: row.tax_id,
      incorporationCountry: row.incorporation_country,
      incorporationDate: row.incorporation_date,
      address: row.address,
      beneficialOwners: row.beneficial_owners,
      verificationResults: row.verification_results,
      metadata: row.metadata,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
    };
  }

  private mapAMLScreening(row: any): AMLScreening {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
      entityName: row.entity_name,
      status: row.status,
      screeningResults: row.screening_results,
      matches: row.matches,
      reviewedBy: row.reviewed_by,
      reviewNotes: row.review_notes,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    };
  }

  private mapAlert(row: any): MonitoringAlert {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
      alertType: row.alert_type,
      severity: row.severity,
      description: row.description,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    };
  }
}

export const complianceService = new ComplianceService();
