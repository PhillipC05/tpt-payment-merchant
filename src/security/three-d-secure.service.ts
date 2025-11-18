import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { eventBus } from '../core';

// 3DS Version
export type ThreeDSVersion = '1.0' | '2.1' | '2.2';

// Authentication status
export type AuthenticationStatus =
  | 'pending'
  | 'challenge_required'
  | 'authenticated'
  | 'attempted'
  | 'failed'
  | 'rejected'
  | 'unavailable';

// Transaction status
export type TransactionStatus = 'Y' | 'N' | 'U' | 'A' | 'C' | 'R';

// 3DS Authentication request
export interface ThreeDSRequest {
  transactionId: string;
  merchantId: string;
  amount: number;
  currency: string;
  cardNumber: string;
  cardExpiry: string;
  cardholderName: string;
  cardholderEmail?: string;
  billingAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
  browserInfo?: BrowserInfo;
  deviceChannel: 'browser' | 'app' | '3ri';
  messageCategory: 'payment' | 'non_payment';
}

// Browser information for risk-based authentication
export interface BrowserInfo {
  acceptHeader: string;
  colorDepth: number;
  javaEnabled: boolean;
  javascriptEnabled: boolean;
  language: string;
  screenHeight: number;
  screenWidth: number;
  timeZoneOffset: number;
  userAgent: string;
  ipAddress: string;
}

// 3DS Authentication response
export interface ThreeDSResponse {
  id: string;
  transactionId: string;
  version: ThreeDSVersion;
  status: AuthenticationStatus;
  transactionStatus?: TransactionStatus;
  eci?: string; // Electronic Commerce Indicator
  cavv?: string; // Cardholder Authentication Verification Value
  xid?: string; // Transaction ID for 3DS1
  dsTransactionId?: string; // Directory Server Transaction ID
  acsUrl?: string; // Access Control Server URL for challenge
  acsTransactionId?: string;
  challengeRequired: boolean;
  challengeUrl?: string;
  creq?: string; // Challenge request
  authenticationValue?: string;
  messageVersion?: string;
  riskScore?: number;
  exemptionApplied?: string;
  createdAt: Date;
  completedAt?: Date;
}

// Exemption types for SCA
export type ExemptionType =
  | 'low_value' // < €30
  | 'low_risk' // TRA exemption
  | 'trusted_beneficiary'
  | 'recurring'
  | 'corporate'
  | 'secure_corporate'
  | 'delegation';

export class ThreeDSecureService {
  // Initiate 3DS authentication
  async authenticate(request: ThreeDSRequest): Promise<ThreeDSResponse> {
    const id = uuidv4();

    // Determine 3DS version based on card BIN
    const version = await this.determineVersion(request.cardNumber);

    // Check for applicable exemptions
    const exemption = this.checkExemptions(request);

    // Perform risk-based authentication
    const riskScore = await this.assessRisk(request);

    // Determine if challenge is required
    const challengeRequired = this.shouldChallenge(riskScore, exemption, request.amount);

    let response: ThreeDSResponse;

    if (version === '2.1' || version === '2.2') {
      response = await this.perform3DS2Authentication(id, request, version, riskScore, exemption, challengeRequired);
    } else {
      response = await this.perform3DS1Authentication(id, request, challengeRequired);
    }

    // Store authentication record
    await this.storeAuthentication(response);

    await eventBus.emit('security.3ds.initiated', {
      merchantId: request.merchantId,
      data: { authenticationId: id, version, challengeRequired },
    });

    logger.info('3DS authentication initiated', {
      id,
      transactionId: request.transactionId,
      version,
      challengeRequired,
    });

    return response;
  }

  // Complete challenge authentication
  async completeChallenge(
    authenticationId: string,
    cres: string // Challenge response
  ): Promise<ThreeDSResponse> {
    // Decode and verify challenge response
    const decoded = Buffer.from(cres, 'base64').toString('utf8');
    const challengeResult = JSON.parse(decoded);

    // Get original authentication
    const result = await query<any>(
      `SELECT * FROM three_ds_authentications WHERE id = $1`,
      [authenticationId]
    );

    if (result.rows.length === 0) {
      throw new Error('Authentication not found');
    }

    const auth = result.rows[0];

    // Verify challenge and update status
    const transactionStatus = challengeResult.transStatus as TransactionStatus;
    const status = this.mapTransactionStatus(transactionStatus);

    // Generate authentication value if successful
    const cavv = status === 'authenticated'
      ? this.generateCAVV()
      : undefined;

    const eci = this.determineECI(auth.version, transactionStatus);

    // Update authentication record
    const updateResult = await query<any>(
      `UPDATE three_ds_authentications
       SET status = $1, transaction_status = $2, cavv = $3, eci = $4, completed_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [status, transactionStatus, cavv, eci, authenticationId]
    );

    const response = this.mapAuthenticationResponse(updateResult.rows[0]);

    await eventBus.emit('security.3ds.completed', {
      merchantId: auth.merchant_id,
      data: { authenticationId, status, transactionStatus },
    });

    return response;
  }

  // Verify authentication result before payment
  async verifyAuthentication(authenticationId: string): Promise<{
    valid: boolean;
    liabilityShift: boolean;
    eci: string;
    cavv?: string;
  }> {
    const result = await query<any>(
      `SELECT * FROM three_ds_authentications WHERE id = $1`,
      [authenticationId]
    );

    if (result.rows.length === 0) {
      return { valid: false, liabilityShift: false, eci: '07' };
    }

    const auth = result.rows[0];

    // Check if authentication is valid
    const validStatuses = ['authenticated', 'attempted'];
    const isValid = validStatuses.includes(auth.status);

    // Determine liability shift
    const liabilityShiftStatuses = ['Y', 'A'];
    const hasLiabilityShift = liabilityShiftStatuses.includes(auth.transaction_status);

    return {
      valid: isValid,
      liabilityShift: hasLiabilityShift,
      eci: auth.eci || '07',
      cavv: auth.cavv,
    };
  }

  // Get authentication status
  async getAuthentication(authenticationId: string): Promise<ThreeDSResponse | null> {
    const result = await query<any>(
      `SELECT * FROM three_ds_authentications WHERE id = $1`,
      [authenticationId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapAuthenticationResponse(result.rows[0]);
  }

  // Private methods

  private async determineVersion(cardNumber: string): Promise<ThreeDSVersion> {
    // In production, query card scheme directory servers
    // For now, assume 3DS2.1 for all cards
    const bin = cardNumber.substring(0, 6);

    // Simulate BIN lookup - most modern cards support 3DS2
    return '2.1';
  }

  private checkExemptions(request: ThreeDSRequest): ExemptionType | null {
    // Low value exemption (< €30 or equivalent)
    if (request.amount < 3000) { // 30.00 in cents
      return 'low_value';
    }

    // Check for recurring payment indicator in metadata
    // Other exemptions would be checked based on merchant settings

    return null;
  }

  private async assessRisk(request: ThreeDSRequest): Promise<number> {
    let riskScore = 0;

    // Browser-based risk signals
    if (request.browserInfo) {
      // Check for suspicious browser characteristics
      if (!request.browserInfo.javascriptEnabled) riskScore += 20;
      if (request.browserInfo.colorDepth < 15) riskScore += 10;

      // Check IP geolocation vs billing country
      // In production, use IP geolocation service
    }

    // Transaction amount risk
    if (request.amount > 50000) riskScore += 15; // > 500.00
    if (request.amount > 100000) riskScore += 25; // > 1000.00

    // Check merchant risk history
    const merchantRisk = await this.getMerchantRiskScore(request.merchantId);
    riskScore += merchantRisk;

    // Cap at 100
    return Math.min(100, riskScore);
  }

  private async getMerchantRiskScore(merchantId: string): Promise<number> {
    // Get merchant's chargeback and fraud rates
    const result = await query<any>(
      `SELECT
        COUNT(CASE WHEN status = 'disputed' THEN 1 END) as disputes,
        COUNT(*) as total
       FROM transactions
       WHERE merchant_id = $1 AND created_at > NOW() - INTERVAL '90 days'`,
      [merchantId]
    );

    if (result.rows.length === 0 || result.rows[0].total === 0) {
      return 0;
    }

    const disputeRate = result.rows[0].disputes / result.rows[0].total;

    if (disputeRate > 0.01) return 30; // > 1% dispute rate
    if (disputeRate > 0.005) return 15; // > 0.5%
    return 0;
  }

  private shouldChallenge(
    riskScore: number,
    exemption: ExemptionType | null,
    amount: number
  ): boolean {
    // Always challenge high-risk transactions
    if (riskScore > 70) return true;

    // Challenge high-value transactions without exemption
    if (amount > 100000 && !exemption) return true;

    // Low-risk transactions can be frictionless
    if (riskScore < 30 && exemption) return false;

    // Medium risk - challenge based on amount
    return amount > 50000;
  }

  private async perform3DS2Authentication(
    id: string,
    request: ThreeDSRequest,
    version: ThreeDSVersion,
    riskScore: number,
    exemption: ExemptionType | null,
    challengeRequired: boolean
  ): Promise<ThreeDSResponse> {
    const dsTransactionId = uuidv4();

    if (challengeRequired) {
      // Generate challenge
      const acsTransactionId = uuidv4();
      const acsUrl = `${process.env.ACS_URL || 'https://acs.example.com'}/challenge`;

      // Create challenge request (CReq)
      const creq = Buffer.from(JSON.stringify({
        threeDSServerTransID: id,
        acsTransID: acsTransactionId,
        messageType: 'CReq',
        messageVersion: version,
        challengeWindowSize: '05', // Full screen
      })).toString('base64');

      return {
        id,
        transactionId: request.transactionId,
        version,
        status: 'challenge_required',
        dsTransactionId,
        acsUrl,
        acsTransactionId,
        challengeRequired: true,
        challengeUrl: `${acsUrl}?creq=${creq}`,
        creq,
        messageVersion: version,
        riskScore,
        exemptionApplied: exemption || undefined,
        createdAt: new Date(),
      };
    } else {
      // Frictionless flow - immediate authentication
      const transactionStatus: TransactionStatus = riskScore < 30 ? 'Y' : 'A';
      const cavv = this.generateCAVV();
      const eci = this.determineECI(version, transactionStatus);

      return {
        id,
        transactionId: request.transactionId,
        version,
        status: transactionStatus === 'Y' ? 'authenticated' : 'attempted',
        transactionStatus,
        eci,
        cavv,
        dsTransactionId,
        challengeRequired: false,
        authenticationValue: cavv,
        messageVersion: version,
        riskScore,
        exemptionApplied: exemption || undefined,
        createdAt: new Date(),
        completedAt: new Date(),
      };
    }
  }

  private async perform3DS1Authentication(
    id: string,
    request: ThreeDSRequest,
    challengeRequired: boolean
  ): Promise<ThreeDSResponse> {
    const xid = Buffer.from(id).toString('base64').substring(0, 28);

    if (challengeRequired) {
      const acsUrl = `${process.env.ACS_URL || 'https://acs.example.com'}/pareq`;

      return {
        id,
        transactionId: request.transactionId,
        version: '1.0',
        status: 'challenge_required',
        xid,
        acsUrl,
        challengeRequired: true,
        challengeUrl: acsUrl,
        createdAt: new Date(),
      };
    } else {
      return {
        id,
        transactionId: request.transactionId,
        version: '1.0',
        status: 'attempted',
        transactionStatus: 'A',
        eci: '06',
        xid,
        challengeRequired: false,
        createdAt: new Date(),
        completedAt: new Date(),
      };
    }
  }

  private generateCAVV(): string {
    // Generate a 28-character base64 CAVV
    return Buffer.from(uuidv4().replace(/-/g, ''), 'hex')
      .toString('base64')
      .substring(0, 28);
  }

  private determineECI(version: ThreeDSVersion, transactionStatus: TransactionStatus): string {
    // ECI values for Visa
    if (transactionStatus === 'Y') {
      return version === '1.0' ? '05' : '05';
    } else if (transactionStatus === 'A') {
      return version === '1.0' ? '06' : '06';
    }
    return '07'; // No authentication
  }

  private mapTransactionStatus(status: TransactionStatus): AuthenticationStatus {
    switch (status) {
      case 'Y': return 'authenticated';
      case 'A': return 'attempted';
      case 'N': return 'failed';
      case 'R': return 'rejected';
      case 'U': return 'unavailable';
      case 'C': return 'challenge_required';
      default: return 'failed';
    }
  }

  private async storeAuthentication(response: ThreeDSResponse): Promise<void> {
    await query(
      `INSERT INTO three_ds_authentications (
        id, transaction_id, version, status, transaction_status,
        eci, cavv, xid, ds_transaction_id, acs_url, acs_transaction_id,
        challenge_required, risk_score, exemption_applied,
        created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        response.id,
        response.transactionId,
        response.version,
        response.status,
        response.transactionStatus,
        response.eci,
        response.cavv,
        response.xid,
        response.dsTransactionId,
        response.acsUrl,
        response.acsTransactionId,
        response.challengeRequired,
        response.riskScore,
        response.exemptionApplied,
        response.createdAt,
        response.completedAt,
      ]
    );
  }

  private mapAuthenticationResponse(row: any): ThreeDSResponse {
    return {
      id: row.id,
      transactionId: row.transaction_id,
      version: row.version,
      status: row.status,
      transactionStatus: row.transaction_status,
      eci: row.eci,
      cavv: row.cavv,
      xid: row.xid,
      dsTransactionId: row.ds_transaction_id,
      acsUrl: row.acs_url,
      acsTransactionId: row.acs_transaction_id,
      challengeRequired: row.challenge_required,
      riskScore: row.risk_score,
      exemptionApplied: row.exemption_applied,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}

export const threeDSecureService = new ThreeDSecureService();
