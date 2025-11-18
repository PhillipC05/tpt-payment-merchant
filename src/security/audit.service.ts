import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { dataMasking } from './encryption.service';

// Audit event categories
export type AuditCategory =
  | 'authentication'
  | 'authorization'
  | 'data_access'
  | 'data_modification'
  | 'transaction'
  | 'configuration'
  | 'security'
  | 'compliance'
  | 'system';

// Audit event severity
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

// Audit event
export interface AuditEvent {
  id: string;
  timestamp: Date;
  category: AuditCategory;
  action: string;
  severity: AuditSeverity;
  actorId?: string;
  actorType: 'user' | 'merchant' | 'system' | 'api_key';
  actorEmail?: string;
  merchantId?: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, any>;
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
  };
}

// Sensitive fields to redact
const SENSITIVE_FIELDS = [
  'password', 'token', 'secret', 'key', 'cvv', 'cvc', 'card_number',
  'ssn', 'tax_id', 'bank_account', 'routing_number', 'pin',
];

class AuditService {
  private buffer: AuditEvent[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private bufferSize = 100;
  private flushIntervalMs = 5000;

  constructor() {
    this.startFlushInterval();
  }

  // Log an audit event
  async log(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<string> {
    const id = uuidv4();

    const auditEvent: AuditEvent = {
      id,
      timestamp: new Date(),
      ...event,
      metadata: this.sanitizeData(event.metadata),
      changes: event.changes ? {
        before: this.sanitizeData(event.changes.before),
        after: this.sanitizeData(event.changes.after),
      } : undefined,
    };

    this.buffer.push(auditEvent);

    // Flush if buffer is full
    if (this.buffer.length >= this.bufferSize) {
      await this.flush();
    }

    // Log critical events immediately
    if (event.severity === 'critical') {
      await this.flush();
      logger.error('Critical audit event', { event: auditEvent });
    }

    return id;
  }

  // Convenience methods for common events
  async logAuthentication(input: {
    actorId: string;
    actorEmail?: string;
    merchantId?: string;
    success: boolean;
    method: string;
    ipAddress?: string;
    userAgent?: string;
    errorMessage?: string;
  }): Promise<string> {
    return this.log({
      category: 'authentication',
      action: input.success ? 'login_success' : 'login_failure',
      severity: input.success ? 'info' : 'warning',
      actorId: input.actorId,
      actorType: 'user',
      actorEmail: input.actorEmail,
      merchantId: input.merchantId,
      success: input.success,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      errorMessage: input.errorMessage,
      metadata: { method: input.method },
    });
  }

  async logDataAccess(input: {
    actorId: string;
    actorType: 'user' | 'merchant' | 'system' | 'api_key';
    merchantId?: string;
    resourceType: string;
    resourceId: string;
    action: 'read' | 'export' | 'search';
    ipAddress?: string;
    metadata?: Record<string, any>;
  }): Promise<string> {
    return this.log({
      category: 'data_access',
      action: `data_${input.action}`,
      severity: 'info',
      actorId: input.actorId,
      actorType: input.actorType,
      merchantId: input.merchantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      success: true,
      ipAddress: input.ipAddress,
      metadata: input.metadata,
    });
  }

  async logDataModification(input: {
    actorId: string;
    actorType: 'user' | 'merchant' | 'system' | 'api_key';
    merchantId?: string;
    resourceType: string;
    resourceId: string;
    action: 'create' | 'update' | 'delete';
    before?: Record<string, any>;
    after?: Record<string, any>;
    ipAddress?: string;
  }): Promise<string> {
    return this.log({
      category: 'data_modification',
      action: `data_${input.action}`,
      severity: 'info',
      actorId: input.actorId,
      actorType: input.actorType,
      merchantId: input.merchantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      success: true,
      ipAddress: input.ipAddress,
      changes: { before: input.before, after: input.after },
    });
  }

  async logTransaction(input: {
    merchantId: string;
    transactionId: string;
    action: string;
    amount: number;
    currency: string;
    success: boolean;
    errorMessage?: string;
    metadata?: Record<string, any>;
  }): Promise<string> {
    return this.log({
      category: 'transaction',
      action: input.action,
      severity: input.success ? 'info' : 'error',
      actorType: 'system',
      merchantId: input.merchantId,
      resourceType: 'transaction',
      resourceId: input.transactionId,
      success: input.success,
      errorMessage: input.errorMessage,
      metadata: {
        amount: input.amount,
        currency: input.currency,
        ...input.metadata,
      },
    });
  }

  async logSecurityEvent(input: {
    action: string;
    severity: AuditSeverity;
    actorId?: string;
    merchantId?: string;
    success: boolean;
    ipAddress?: string;
    errorMessage?: string;
    metadata?: Record<string, any>;
  }): Promise<string> {
    return this.log({
      category: 'security',
      action: input.action,
      severity: input.severity,
      actorId: input.actorId,
      actorType: input.actorId ? 'user' : 'system',
      merchantId: input.merchantId,
      success: input.success,
      ipAddress: input.ipAddress,
      errorMessage: input.errorMessage,
      metadata: input.metadata,
    });
  }

  async logConfigurationChange(input: {
    actorId: string;
    merchantId?: string;
    setting: string;
    before: any;
    after: any;
    ipAddress?: string;
  }): Promise<string> {
    return this.log({
      category: 'configuration',
      action: 'setting_changed',
      severity: 'warning',
      actorId: input.actorId,
      actorType: 'user',
      merchantId: input.merchantId,
      resourceType: 'configuration',
      resourceId: input.setting,
      success: true,
      ipAddress: input.ipAddress,
      changes: { before: input.before, after: input.after },
    });
  }

  // Query audit logs
  async query(filters: {
    merchantId?: string;
    actorId?: string;
    category?: AuditCategory;
    action?: string;
    severity?: AuditSeverity;
    startDate?: Date;
    endDate?: Date;
    resourceType?: string;
    resourceId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ events: AuditEvent[]; total: number }> {
    let queryText = `SELECT * FROM audit_logs WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) as total FROM audit_logs WHERE 1=1`;
    const params: any[] = [];
    let paramCount = 1;

    if (filters.merchantId) {
      queryText += ` AND merchant_id = $${paramCount}`;
      countQuery += ` AND merchant_id = $${paramCount}`;
      params.push(filters.merchantId);
      paramCount++;
    }

    if (filters.actorId) {
      queryText += ` AND actor_id = $${paramCount}`;
      countQuery += ` AND actor_id = $${paramCount}`;
      params.push(filters.actorId);
      paramCount++;
    }

    if (filters.category) {
      queryText += ` AND category = $${paramCount}`;
      countQuery += ` AND category = $${paramCount}`;
      params.push(filters.category);
      paramCount++;
    }

    if (filters.action) {
      queryText += ` AND action = $${paramCount}`;
      countQuery += ` AND action = $${paramCount}`;
      params.push(filters.action);
      paramCount++;
    }

    if (filters.severity) {
      queryText += ` AND severity = $${paramCount}`;
      countQuery += ` AND severity = $${paramCount}`;
      params.push(filters.severity);
      paramCount++;
    }

    if (filters.startDate) {
      queryText += ` AND timestamp >= $${paramCount}`;
      countQuery += ` AND timestamp >= $${paramCount}`;
      params.push(filters.startDate);
      paramCount++;
    }

    if (filters.endDate) {
      queryText += ` AND timestamp <= $${paramCount}`;
      countQuery += ` AND timestamp <= $${paramCount}`;
      params.push(filters.endDate);
      paramCount++;
    }

    if (filters.resourceType) {
      queryText += ` AND resource_type = $${paramCount}`;
      countQuery += ` AND resource_type = $${paramCount}`;
      params.push(filters.resourceType);
      paramCount++;
    }

    if (filters.resourceId) {
      queryText += ` AND resource_id = $${paramCount}`;
      countQuery += ` AND resource_id = $${paramCount}`;
      params.push(filters.resourceId);
      paramCount++;
    }

    queryText += ` ORDER BY timestamp DESC`;

    const limit = filters.limit || 100;
    const offset = filters.offset || 0;
    queryText += ` LIMIT $${paramCount++} OFFSET $${paramCount}`;
    params.push(limit, offset);

    const [eventsResult, countResult] = await Promise.all([
      query<any>(queryText, params),
      query<any>(countQuery, params.slice(0, -2)),
    ]);

    return {
      events: eventsResult.rows.map(row => this.mapAuditEvent(row)),
      total: parseInt(countResult.rows[0].total),
    };
  }

  // Export audit logs
  async export(filters: {
    merchantId?: string;
    startDate: Date;
    endDate: Date;
    format: 'json' | 'csv';
  }): Promise<string> {
    const { events } = await this.query({
      ...filters,
      limit: 10000,
    });

    if (filters.format === 'csv') {
      return this.toCSV(events);
    }

    return JSON.stringify(events, null, 2);
  }

  // Flush buffer to database
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const eventsToFlush = [...this.buffer];
    this.buffer = [];

    try {
      for (const event of eventsToFlush) {
        await query(
          `INSERT INTO audit_logs (
            id, timestamp, category, action, severity, actor_id, actor_type,
            actor_email, merchant_id, resource_type, resource_id, ip_address,
            user_agent, request_id, success, error_message, metadata, changes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            event.id,
            event.timestamp,
            event.category,
            event.action,
            event.severity,
            event.actorId,
            event.actorType,
            event.actorEmail,
            event.merchantId,
            event.resourceType,
            event.resourceId,
            event.ipAddress,
            event.userAgent,
            event.requestId,
            event.success,
            event.errorMessage,
            event.metadata ? JSON.stringify(event.metadata) : null,
            event.changes ? JSON.stringify(event.changes) : null,
          ]
        );
      }
    } catch (error) {
      // Re-add events to buffer on failure
      this.buffer = [...eventsToFlush, ...this.buffer];
      logger.error('Failed to flush audit logs', { error });
    }
  }

  // Start periodic flush
  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch(err => {
        logger.error('Audit flush error', { error: err });
      });
    }, this.flushIntervalMs);
  }

  // Stop flush interval
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Final flush
    this.flush();
  }

  // Sanitize sensitive data
  private sanitizeData(data?: Record<string, any>): Record<string, any> | undefined {
    if (!data) return undefined;

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();

      if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeData(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  // Convert events to CSV
  private toCSV(events: AuditEvent[]): string {
    const headers = [
      'id', 'timestamp', 'category', 'action', 'severity',
      'actor_id', 'actor_type', 'merchant_id', 'resource_type',
      'resource_id', 'success', 'ip_address',
    ];

    const rows = events.map(event => [
      event.id,
      event.timestamp.toISOString(),
      event.category,
      event.action,
      event.severity,
      event.actorId || '',
      event.actorType,
      event.merchantId || '',
      event.resourceType || '',
      event.resourceId || '',
      event.success,
      event.ipAddress || '',
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  private mapAuditEvent(row: any): AuditEvent {
    return {
      id: row.id,
      timestamp: row.timestamp,
      category: row.category,
      action: row.action,
      severity: row.severity,
      actorId: row.actor_id,
      actorType: row.actor_type,
      actorEmail: row.actor_email,
      merchantId: row.merchant_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      requestId: row.request_id,
      success: row.success,
      errorMessage: row.error_message,
      metadata: row.metadata,
      changes: row.changes,
    };
  }
}

export const auditService = new AuditService();
