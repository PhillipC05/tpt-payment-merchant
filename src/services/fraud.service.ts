import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { checkRateLimit, cacheGet, cacheSet } from '../database/redis';
import { logger } from '../utils/logger';
import { webhookService } from './webhook.service';
import {
  FraudCheck, FraudSignal, FraudRule, Blocklist, RiskLevel, FraudAction
} from '../types';

// Risk score thresholds
const RISK_THRESHOLDS = {
  low: 25,
  medium: 50,
  high: 75,
};

export class FraudService {
  async analyzeTransaction(merchantId: string, transactionData: {
    transactionId: string;
    amount: number;
    currency: string;
    customerId?: string;
    customerEmail?: string;
    customerIp?: string;
    cardFingerprint?: string;
    cardCountry?: string;
    billingCountry?: string;
    metadata?: Record<string, any>;
  }): Promise<FraudCheck> {
    const signals: FraudSignal[] = [];
    let totalScore = 0;

    // Check blocklists
    const blocklistSignals = await this.checkBlocklists(merchantId, transactionData);
    signals.push(...blocklistSignals);
    totalScore += blocklistSignals.reduce((sum, s) => sum + s.score, 0);

    // Velocity checks
    const velocitySignals = await this.checkVelocity(transactionData);
    signals.push(...velocitySignals);
    totalScore += velocitySignals.reduce((sum, s) => sum + s.score, 0);

    // Amount analysis
    const amountSignals = this.analyzeAmount(merchantId, transactionData.amount);
    signals.push(...amountSignals);
    totalScore += amountSignals.reduce((sum, s) => sum + s.score, 0);

    // Geographic analysis
    const geoSignals = this.analyzeGeography(transactionData);
    signals.push(...geoSignals);
    totalScore += geoSignals.reduce((sum, s) => sum + s.score, 0);

    // Apply custom rules
    const ruleSignals = await this.applyCustomRules(merchantId, transactionData);
    signals.push(...ruleSignals);
    totalScore += ruleSignals.reduce((sum, s) => sum + s.score, 0);

    // Calculate risk level and action
    const riskScore = Math.min(100, totalScore);
    const riskLevel = this.calculateRiskLevel(riskScore);
    const action = this.determineAction(riskLevel, signals);

    // Store fraud check
    const fraudCheckId = uuidv4();
    const result = await query<any>(
      `INSERT INTO fraud_checks (id, transaction_id, merchant_id, risk_score, risk_level, action, signals, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [fraudCheckId, transactionData.transactionId, merchantId, riskScore, riskLevel, action,
       JSON.stringify(signals), JSON.stringify(transactionData.metadata || {})]
    );

    const fraudCheck = this.mapFraudCheck(result.rows[0]);

    // Send alert for high risk
    if (riskLevel === 'high' || riskLevel === 'critical') {
      await webhookService.send(merchantId, 'fraud.alert' as any, { fraudCheck });
    }

    logger.info('Fraud analysis completed', {
      transactionId: transactionData.transactionId,
      riskScore,
      riskLevel,
      action,
      signalCount: signals.length,
    });

    return fraudCheck;
  }

  // Blocklist management
  async addToBlocklist(merchantId: string, data: {
    type: 'email' | 'ip' | 'card_fingerprint' | 'country';
    value: string;
    reason?: string;
    expiresAt?: Date;
  }): Promise<Blocklist> {
    const result = await query<any>(
      `INSERT INTO blocklist (merchant_id, type, value, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [merchantId, data.type, data.value.toLowerCase(), data.reason, data.expiresAt]
    );
    return this.mapBlocklist(result.rows[0]);
  }

  async removeFromBlocklist(id: string, merchantId: string): Promise<void> {
    await query('DELETE FROM blocklist WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
  }

  async getBlocklist(merchantId: string, type?: string): Promise<Blocklist[]> {
    let queryText = 'SELECT * FROM blocklist WHERE merchant_id = $1';
    const values: any[] = [merchantId];
    if (type) {
      queryText += ' AND type = $2';
      values.push(type);
    }
    queryText += ' ORDER BY created_at DESC';
    const result = await query<any>(queryText, values);
    return result.rows.map(row => this.mapBlocklist(row));
  }

  // Custom rules
  async createRule(merchantId: string, data: {
    name: string;
    description?: string;
    conditions: { field: string; operator: string; value: any }[];
    action: FraudAction;
    priority?: number;
  }): Promise<FraudRule> {
    const result = await query<any>(
      `INSERT INTO fraud_rules (merchant_id, name, description, conditions, action, priority)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [merchantId, data.name, data.description, JSON.stringify(data.conditions), data.action, data.priority || 0]
    );
    return this.mapFraudRule(result.rows[0]);
  }

  async getRules(merchantId: string): Promise<FraudRule[]> {
    const result = await query<any>(
      'SELECT * FROM fraud_rules WHERE merchant_id = $1 ORDER BY priority DESC',
      [merchantId]
    );
    return result.rows.map(row => this.mapFraudRule(row));
  }

  async deleteRule(ruleId: string, merchantId: string): Promise<void> {
    await query('DELETE FROM fraud_rules WHERE id = $1 AND merchant_id = $2', [ruleId, merchantId]);
  }

  // Analysis helpers
  private async checkBlocklists(merchantId: string, data: any): Promise<FraudSignal[]> {
    const signals: FraudSignal[] = [];
    const checks = [
      { type: 'email', value: data.customerEmail },
      { type: 'ip', value: data.customerIp },
      { type: 'card_fingerprint', value: data.cardFingerprint },
      { type: 'country', value: data.cardCountry },
    ].filter(c => c.value);

    for (const check of checks) {
      const result = await query(
        `SELECT * FROM blocklist WHERE merchant_id = $1 AND type = $2 AND value = $3 AND (expires_at IS NULL OR expires_at > NOW())`,
        [merchantId, check.type, check.value.toLowerCase()]
      );
      if (result.rows.length > 0) {
        signals.push({
          type: `blocklist_${check.type}`,
          severity: 'critical',
          message: `${check.type} is blocklisted`,
          score: 100,
        });
      }
    }
    return signals;
  }

  private async checkVelocity(data: any): Promise<FraudSignal[]> {
    const signals: FraudSignal[] = [];

    // Check card velocity (max 5 transactions per hour)
    if (data.cardFingerprint) {
      const cardResult = await checkRateLimit(`velocity:card:${data.cardFingerprint}`, 5, 3600000);
      if (!cardResult.allowed) {
        signals.push({
          type: 'velocity_card',
          severity: 'high',
          message: 'Too many transactions with this card',
          score: 40,
        });
      }
    }

    // Check IP velocity (max 10 transactions per hour)
    if (data.customerIp) {
      const ipResult = await checkRateLimit(`velocity:ip:${data.customerIp}`, 10, 3600000);
      if (!ipResult.allowed) {
        signals.push({
          type: 'velocity_ip',
          severity: 'medium',
          message: 'Too many transactions from this IP',
          score: 25,
        });
      }
    }

    // Check email velocity (max 3 transactions per hour)
    if (data.customerEmail) {
      const emailResult = await checkRateLimit(`velocity:email:${data.customerEmail}`, 3, 3600000);
      if (!emailResult.allowed) {
        signals.push({
          type: 'velocity_email',
          severity: 'medium',
          message: 'Too many transactions with this email',
          score: 30,
        });
      }
    }

    return signals;
  }

  private analyzeAmount(merchantId: string, amount: number): FraudSignal[] {
    const signals: FraudSignal[] = [];

    // High amount threshold (>$5000)
    if (amount > 500000) {
      signals.push({
        type: 'high_amount',
        severity: 'medium',
        message: 'Transaction amount exceeds $5,000',
        score: 20,
      });
    }

    // Very high amount threshold (>$10000)
    if (amount > 1000000) {
      signals.push({
        type: 'very_high_amount',
        severity: 'high',
        message: 'Transaction amount exceeds $10,000',
        score: 30,
      });
    }

    return signals;
  }

  private analyzeGeography(data: any): FraudSignal[] {
    const signals: FraudSignal[] = [];

    // Card country mismatch
    if (data.cardCountry && data.billingCountry && data.cardCountry !== data.billingCountry) {
      signals.push({
        type: 'country_mismatch',
        severity: 'medium',
        message: 'Card country does not match billing country',
        score: 25,
      });
    }

    // High risk countries (example list)
    const highRiskCountries = ['NG', 'RU', 'UA', 'BY', 'KZ'];
    if (data.cardCountry && highRiskCountries.includes(data.cardCountry)) {
      signals.push({
        type: 'high_risk_country',
        severity: 'medium',
        message: 'Card issued in high-risk country',
        score: 30,
      });
    }

    return signals;
  }

  private async applyCustomRules(merchantId: string, data: any): Promise<FraudSignal[]> {
    const signals: FraudSignal[] = [];
    const rules = await this.getRules(merchantId);

    for (const rule of rules) {
      if (!rule.active) continue;

      let match = true;
      for (const condition of rule.conditions) {
        const fieldValue = data[condition.field];
        if (!this.evaluateCondition(fieldValue, condition.operator, condition.value)) {
          match = false;
          break;
        }
      }

      if (match) {
        const score = rule.action === 'block' ? 100 : rule.action === 'review' ? 50 : 0;
        signals.push({
          type: `rule_${rule.id}`,
          severity: rule.action === 'block' ? 'critical' : 'medium',
          message: `Custom rule matched: ${rule.name}`,
          score,
        });
      }
    }

    return signals;
  }

  private evaluateCondition(value: any, operator: string, expected: any): boolean {
    switch (operator) {
      case 'eq': return value === expected;
      case 'ne': return value !== expected;
      case 'gt': return value > expected;
      case 'lt': return value < expected;
      case 'gte': return value >= expected;
      case 'lte': return value <= expected;
      case 'in': return Array.isArray(expected) && expected.includes(value);
      case 'contains': return typeof value === 'string' && value.includes(expected);
      case 'regex': return new RegExp(expected).test(value);
      default: return false;
    }
  }

  private calculateRiskLevel(score: number): RiskLevel {
    if (score >= RISK_THRESHOLDS.high) return 'critical';
    if (score >= RISK_THRESHOLDS.medium) return 'high';
    if (score >= RISK_THRESHOLDS.low) return 'medium';
    return 'low';
  }

  private determineAction(riskLevel: RiskLevel, signals: FraudSignal[]): FraudAction {
    if (signals.some(s => s.severity === 'critical')) return 'block';
    if (riskLevel === 'critical' || riskLevel === 'high') return 'review';
    return 'allow';
  }

  private mapFraudCheck(row: any): FraudCheck {
    return {
      id: row.id, transactionId: row.transaction_id, merchantId: row.merchant_id,
      riskScore: row.risk_score, riskLevel: row.risk_level, action: row.action,
      signals: row.signals, metadata: row.metadata, createdAt: row.created_at
    };
  }

  private mapBlocklist(row: any): Blocklist {
    return {
      id: row.id, merchantId: row.merchant_id, type: row.type, value: row.value,
      reason: row.reason, expiresAt: row.expires_at, createdAt: row.created_at
    };
  }

  private mapFraudRule(row: any): FraudRule {
    return {
      id: row.id, merchantId: row.merchant_id, name: row.name, description: row.description,
      conditions: row.conditions, action: row.action, priority: row.priority,
      active: row.active, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }
}

export const fraudService = new FraudService();
