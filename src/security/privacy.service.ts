import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { eventBus } from '../core';

// Privacy request types
export type PrivacyRequestType =
  | 'access'           // GDPR Article 15 / CCPA access
  | 'deletion'         // GDPR Article 17 / CCPA deletion
  | 'rectification'    // GDPR Article 16
  | 'portability'      // GDPR Article 20
  | 'restriction'      // GDPR Article 18
  | 'objection'        // GDPR Article 21
  | 'opt_out_sale';    // CCPA opt-out of sale

export type RequestStatus = 'pending' | 'processing' | 'completed' | 'denied' | 'expired';

export interface PrivacyRequest {
  id: string;
  merchantId: string;
  subjectId: string;
  subjectEmail: string;
  requestType: PrivacyRequestType;
  status: RequestStatus;
  regulation: 'gdpr' | 'ccpa' | 'other';
  verificationToken?: string;
  verifiedAt?: Date;
  processedData?: Record<string, any>;
  denialReason?: string;
  createdAt: Date;
  dueDate: Date;
  completedAt?: Date;
}

export interface ConsentRecord {
  id: string;
  merchantId: string;
  subjectId: string;
  subjectEmail: string;
  consentType: string;
  version: string;
  granted: boolean;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  revokedAt?: Date;
}

export interface DataRetentionPolicy {
  id: string;
  merchantId: string;
  dataType: string;
  retentionDays: number;
  legalBasis: string;
  autoDelete: boolean;
  createdAt: Date;
}

export class PrivacyService {
  // ============================================
  // DATA SUBJECT REQUESTS
  // ============================================

  // Create a new privacy request
  async createRequest(input: {
    merchantId: string;
    subjectId: string;
    subjectEmail: string;
    requestType: PrivacyRequestType;
    regulation?: 'gdpr' | 'ccpa' | 'other';
  }): Promise<PrivacyRequest> {
    const id = uuidv4();
    const verificationToken = uuidv4();

    // Calculate due date based on regulation
    const dueDate = new Date();
    if (input.regulation === 'gdpr') {
      dueDate.setDate(dueDate.getDate() + 30); // 30 days for GDPR
    } else {
      dueDate.setDate(dueDate.getDate() + 45); // 45 days for CCPA
    }

    const result = await query<any>(
      `INSERT INTO privacy_requests (
        id, merchant_id, subject_id, subject_email, request_type,
        status, regulation, verification_token, due_date, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, NOW())
      RETURNING *`,
      [
        id,
        input.merchantId,
        input.subjectId,
        input.subjectEmail,
        input.requestType,
        input.regulation || 'gdpr',
        verificationToken,
        dueDate,
      ]
    );

    await eventBus.emit('privacy.request.created', {
      merchantId: input.merchantId,
      data: { requestId: id, type: input.requestType },
    });

    logger.info('Privacy request created', {
      id,
      type: input.requestType,
      subjectEmail: input.subjectEmail,
    });

    return this.mapRequest(result.rows[0]);
  }

  // Verify request (email verification)
  async verifyRequest(requestId: string, token: string): Promise<boolean> {
    const result = await query<any>(
      `UPDATE privacy_requests
       SET verified_at = NOW()
       WHERE id = $1 AND verification_token = $2 AND verified_at IS NULL
       RETURNING *`,
      [requestId, token]
    );

    return result.rows.length > 0;
  }

  // Process access request (data export)
  async processAccessRequest(requestId: string): Promise<Record<string, any>> {
    const request = await this.getRequest(requestId);

    if (request.requestType !== 'access') {
      throw new Error('Invalid request type');
    }

    // Collect all data for the subject
    const data: Record<string, any> = {};

    // Personal information
    const customerData = await query<any>(
      `SELECT id, email, name, phone, address, metadata, created_at
       FROM customers WHERE id = $1 OR email = $2`,
      [request.subjectId, request.subjectEmail]
    );
    data.personal_information = customerData.rows;

    // Transactions
    const transactions = await query<any>(
      `SELECT id, type, status, amount, currency, created_at
       FROM transactions WHERE customer_id = $1`,
      [request.subjectId]
    );
    data.transactions = transactions.rows;

    // Payment methods (masked)
    const paymentMethods = await query<any>(
      `SELECT id, type, last4, exp_month, exp_year, created_at
       FROM payment_methods WHERE customer_id = $1`,
      [request.subjectId]
    );
    data.payment_methods = paymentMethods.rows;

    // Consents
    const consents = await query<any>(
      `SELECT consent_type, version, granted, created_at
       FROM consent_records WHERE subject_id = $1`,
      [request.subjectId]
    );
    data.consents = consents.rows;

    // Update request
    await query(
      `UPDATE privacy_requests
       SET status = 'completed', processed_data = $1, completed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(data), requestId]
    );

    await eventBus.emit('privacy.request.completed', {
      merchantId: request.merchantId,
      data: { requestId, type: 'access' },
    });

    return data;
  }

  // Process deletion request (right to be forgotten)
  async processDeletionRequest(requestId: string): Promise<{ deleted: boolean; details: string[] }> {
    const request = await this.getRequest(requestId);

    if (request.requestType !== 'deletion') {
      throw new Error('Invalid request type');
    }

    const details: string[] = [];

    // Check for legal holds
    const hasLegalHold = await this.checkLegalHold(request.subjectId);
    if (hasLegalHold) {
      await query(
        `UPDATE privacy_requests
         SET status = 'denied', denial_reason = 'Legal hold in effect'
         WHERE id = $1`,
        [requestId]
      );
      return { deleted: false, details: ['Deletion blocked due to legal hold'] };
    }

    // Anonymize transactions (keep for accounting but remove PII)
    await query(
      `UPDATE transactions
       SET customer_id = NULL, metadata = metadata - 'customer_email' - 'customer_name'
       WHERE customer_id = $1`,
      [request.subjectId]
    );
    details.push('Transactions anonymized');

    // Delete payment methods
    await query(
      `DELETE FROM payment_methods WHERE customer_id = $1`,
      [request.subjectId]
    );
    details.push('Payment methods deleted');

    // Delete customer record
    await query(
      `DELETE FROM customers WHERE id = $1`,
      [request.subjectId]
    );
    details.push('Customer record deleted');

    // Delete consent records
    await query(
      `DELETE FROM consent_records WHERE subject_id = $1`,
      [request.subjectId]
    );
    details.push('Consent records deleted');

    // Update request
    await query(
      `UPDATE privacy_requests
       SET status = 'completed', processed_data = $1, completed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ deletedItems: details }), requestId]
    );

    await eventBus.emit('privacy.request.completed', {
      merchantId: request.merchantId,
      data: { requestId, type: 'deletion', details },
    });

    logger.info('Deletion request completed', { requestId, details });

    return { deleted: true, details };
  }

  // Process data portability request
  async processPortabilityRequest(requestId: string): Promise<string> {
    const data = await this.processAccessRequest(requestId);

    // Format as machine-readable JSON
    return JSON.stringify(data, null, 2);
  }

  // Get request status
  async getRequest(requestId: string): Promise<PrivacyRequest> {
    const result = await query<any>(
      `SELECT * FROM privacy_requests WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      throw new Error('Privacy request not found');
    }

    return this.mapRequest(result.rows[0]);
  }

  // Get all requests for a merchant
  async getMerchantRequests(
    merchantId: string,
    status?: RequestStatus
  ): Promise<PrivacyRequest[]> {
    let queryText = `SELECT * FROM privacy_requests WHERE merchant_id = $1`;
    const params: any[] = [merchantId];

    if (status) {
      queryText += ` AND status = $2`;
      params.push(status);
    }

    queryText += ` ORDER BY created_at DESC`;
    const result = await query<any>(queryText, params);
    return result.rows.map(row => this.mapRequest(row));
  }

  // ============================================
  // CONSENT MANAGEMENT
  // ============================================

  // Record consent
  async recordConsent(input: {
    merchantId: string;
    subjectId: string;
    subjectEmail: string;
    consentType: string;
    version: string;
    granted: boolean;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, any>;
  }): Promise<ConsentRecord> {
    const id = uuidv4();

    const result = await query<any>(
      `INSERT INTO consent_records (
        id, merchant_id, subject_id, subject_email, consent_type,
        version, granted, ip_address, user_agent, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *`,
      [
        id,
        input.merchantId,
        input.subjectId,
        input.subjectEmail,
        input.consentType,
        input.version,
        input.granted,
        input.ipAddress,
        input.userAgent,
        JSON.stringify(input.metadata || {}),
      ]
    );

    logger.info('Consent recorded', {
      id,
      type: input.consentType,
      granted: input.granted,
    });

    return this.mapConsent(result.rows[0]);
  }

  // Revoke consent
  async revokeConsent(subjectId: string, consentType: string): Promise<void> {
    await query(
      `UPDATE consent_records
       SET revoked_at = NOW()
       WHERE subject_id = $1 AND consent_type = $2 AND revoked_at IS NULL`,
      [subjectId, consentType]
    );

    logger.info('Consent revoked', { subjectId, consentType });
  }

  // Check consent status
  async checkConsent(
    subjectId: string,
    consentType: string
  ): Promise<{ hasConsent: boolean; version?: string }> {
    const result = await query<any>(
      `SELECT * FROM consent_records
       WHERE subject_id = $1 AND consent_type = $2 AND granted = true AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [subjectId, consentType]
    );

    if (result.rows.length === 0) {
      return { hasConsent: false };
    }

    return {
      hasConsent: true,
      version: result.rows[0].version,
    };
  }

  // Get all consents for a subject
  async getSubjectConsents(subjectId: string): Promise<ConsentRecord[]> {
    const result = await query<any>(
      `SELECT * FROM consent_records
       WHERE subject_id = $1
       ORDER BY created_at DESC`,
      [subjectId]
    );

    return result.rows.map(row => this.mapConsent(row));
  }

  // ============================================
  // DATA RETENTION
  // ============================================

  // Set retention policy
  async setRetentionPolicy(input: {
    merchantId: string;
    dataType: string;
    retentionDays: number;
    legalBasis: string;
    autoDelete?: boolean;
  }): Promise<DataRetentionPolicy> {
    const id = uuidv4();

    const result = await query<any>(
      `INSERT INTO data_retention_policies (
        id, merchant_id, data_type, retention_days, legal_basis, auto_delete, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (merchant_id, data_type)
      DO UPDATE SET retention_days = $4, legal_basis = $5, auto_delete = $6
      RETURNING *`,
      [
        id,
        input.merchantId,
        input.dataType,
        input.retentionDays,
        input.legalBasis,
        input.autoDelete ?? true,
      ]
    );

    return this.mapRetentionPolicy(result.rows[0]);
  }

  // Get retention policies
  async getRetentionPolicies(merchantId: string): Promise<DataRetentionPolicy[]> {
    const result = await query<any>(
      `SELECT * FROM data_retention_policies WHERE merchant_id = $1`,
      [merchantId]
    );

    return result.rows.map(row => this.mapRetentionPolicy(row));
  }

  // Apply retention policies (run periodically)
  async applyRetentionPolicies(): Promise<{ deleted: number; dataType: string }[]> {
    const results: { deleted: number; dataType: string }[] = [];

    const policies = await query<any>(
      `SELECT * FROM data_retention_policies WHERE auto_delete = true`
    );

    for (const policy of policies.rows) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - policy.retention_days);

      let deleted = 0;

      // Apply policy based on data type
      switch (policy.data_type) {
        case 'audit_logs':
          const auditResult = await query<any>(
            `DELETE FROM audit_logs WHERE created_at < $1 RETURNING id`,
            [cutoffDate]
          );
          deleted = auditResult.rows.length;
          break;

        case 'session_data':
          const sessionResult = await query<any>(
            `DELETE FROM sessions WHERE created_at < $1 RETURNING id`,
            [cutoffDate]
          );
          deleted = sessionResult.rows.length;
          break;

        case 'inactive_customers':
          const customerResult = await query<any>(
            `DELETE FROM customers
             WHERE last_activity < $1
             AND id NOT IN (SELECT customer_id FROM transactions WHERE created_at > $1)
             RETURNING id`,
            [cutoffDate]
          );
          deleted = customerResult.rows.length;
          break;
      }

      if (deleted > 0) {
        results.push({ deleted, dataType: policy.data_type });
        logger.info('Retention policy applied', {
          dataType: policy.data_type,
          deleted,
          cutoffDate,
        });
      }
    }

    return results;
  }

  // ============================================
  // HELPERS
  // ============================================

  private async checkLegalHold(subjectId: string): Promise<boolean> {
    const result = await query<any>(
      `SELECT * FROM legal_holds WHERE subject_id = $1 AND active = true`,
      [subjectId]
    );
    return result.rows.length > 0;
  }

  private mapRequest(row: any): PrivacyRequest {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      subjectId: row.subject_id,
      subjectEmail: row.subject_email,
      requestType: row.request_type,
      status: row.status,
      regulation: row.regulation,
      verificationToken: row.verification_token,
      verifiedAt: row.verified_at,
      processedData: row.processed_data,
      denialReason: row.denial_reason,
      createdAt: row.created_at,
      dueDate: row.due_date,
      completedAt: row.completed_at,
    };
  }

  private mapConsent(row: any): ConsentRecord {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      subjectId: row.subject_id,
      subjectEmail: row.subject_email,
      consentType: row.consent_type,
      version: row.version,
      granted: row.granted,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      metadata: row.metadata,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  private mapRetentionPolicy(row: any): DataRetentionPolicy {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      dataType: row.data_type,
      retentionDays: row.retention_days,
      legalBasis: row.legal_basis,
      autoDelete: row.auto_delete,
      createdAt: row.created_at,
    };
  }
}

export const privacyService = new PrivacyService();
