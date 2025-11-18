import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { redisClient } from '../config/redis';
import { auditService } from './audit.service';
import { eventBus } from '../core';

// DDoS protection modes
export type ProtectionMode =
  | 'normal'           // Standard rate limiting
  | 'elevated'         // Stricter limits, more logging
  | 'whitelist_only'   // Only allow whitelisted IPs
  | 'historical_limit' // Limit to historical max
  | 'emergency';       // Block all except critical

// Traffic metrics
interface TrafficMetrics {
  requestsPerSecond: number;
  requestsPerMinute: number;
  uniqueIPs: number;
  avgResponseTime: number;
  errorRate: number;
  timestamp: Date;
}

// Historical baseline
interface TrafficBaseline {
  merchantId?: string;
  maxRequestsPerSecond: number;
  maxRequestsPerMinute: number;
  avgRequestsPerMinute: number;
  p95RequestsPerMinute: number;
  maxUniqueIPsPerMinute: number;
  calculatedAt: Date;
  samplePeriodDays: number;
}

// DDoS event
interface DDoSEvent {
  id: string;
  detectedAt: Date;
  type: 'volumetric' | 'slowloris' | 'application' | 'protocol';
  severity: 'low' | 'medium' | 'high' | 'critical';
  metrics: TrafficMetrics;
  baseline: TrafficBaseline;
  mitigationApplied: string[];
  resolvedAt?: Date;
}

// Configuration
interface DDoSConfig {
  mode: ProtectionMode;
  thresholds: {
    requestsPerSecond: number;
    requestsPerMinute: number;
    uniqueIPsPerMinute: number;
    errorRatePercent: number;
  };
  historicalMultiplier: number; // e.g., 1.5 = 150% of historical max
  whitelistedIPs: Set<string>;
  whitelistedMerchants: Set<string>;
  geoBlockedCountries: Set<string>;
  challengeEnabled: boolean;
  autoEscalate: boolean;
}

class DDoSProtectionService {
  private config: DDoSConfig = {
    mode: 'normal',
    thresholds: {
      requestsPerSecond: 1000,
      requestsPerMinute: 10000,
      uniqueIPsPerMinute: 5000,
      errorRatePercent: 10,
    },
    historicalMultiplier: 1.0, // 100% of historical max
    whitelistedIPs: new Set(),
    whitelistedMerchants: new Set(),
    geoBlockedCountries: new Set(),
    challengeEnabled: true,
    autoEscalate: true,
  };

  private baselines: Map<string, TrafficBaseline> = new Map();
  private currentMetrics: TrafficMetrics | null = null;
  private activeEvent: DDoSEvent | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;

  // Initialize service
  async initialize(): Promise<void> {
    // Load baselines from database
    await this.loadBaselines();

    // Start metrics collection
    this.startMetricsCollection();

    logger.info('DDoS protection service initialized', {
      mode: this.config.mode,
    });
  }

  // ============================================
  // MODE MANAGEMENT
  // ============================================

  // Switch to whitelist-only mode
  async enableWhitelistMode(reason: string): Promise<void> {
    const previousMode = this.config.mode;
    this.config.mode = 'whitelist_only';

    await auditService.logSecurityEvent({
      action: 'ddos_whitelist_mode_enabled',
      severity: 'critical',
      success: true,
      metadata: { reason, previousMode },
    });

    await eventBus.emit('security.ddos.mode_changed', {
      data: { mode: 'whitelist_only', reason },
    });

    logger.warn('DDoS protection: Whitelist mode enabled', { reason });
  }

  // Enable historical limit mode
  async enableHistoricalLimitMode(
    multiplier: number = 1.0,
    reason: string
  ): Promise<void> {
    const previousMode = this.config.mode;
    this.config.mode = 'historical_limit';
    this.config.historicalMultiplier = multiplier;

    await auditService.logSecurityEvent({
      action: 'ddos_historical_limit_enabled',
      severity: 'warning',
      success: true,
      metadata: { reason, previousMode, multiplier },
    });

    await eventBus.emit('security.ddos.mode_changed', {
      data: { mode: 'historical_limit', multiplier, reason },
    });

    logger.warn('DDoS protection: Historical limit mode enabled', {
      reason,
      multiplier: `${multiplier * 100}%`,
    });
  }

  // Enable emergency mode (block everything except critical)
  async enableEmergencyMode(reason: string): Promise<void> {
    const previousMode = this.config.mode;
    this.config.mode = 'emergency';

    await auditService.logSecurityEvent({
      action: 'ddos_emergency_mode_enabled',
      severity: 'critical',
      success: true,
      metadata: { reason, previousMode },
    });

    await eventBus.emit('security.ddos.mode_changed', {
      data: { mode: 'emergency', reason },
    });

    logger.error('DDoS protection: EMERGENCY MODE ENABLED', { reason });
  }

  // Return to normal mode
  async enableNormalMode(reason: string): Promise<void> {
    const previousMode = this.config.mode;
    this.config.mode = 'normal';

    await auditService.logSecurityEvent({
      action: 'ddos_normal_mode_restored',
      severity: 'info',
      success: true,
      metadata: { reason, previousMode },
    });

    if (this.activeEvent) {
      this.activeEvent.resolvedAt = new Date();
      await this.saveEvent(this.activeEvent);
      this.activeEvent = null;
    }

    logger.info('DDoS protection: Normal mode restored', { reason });
  }

  // Get current mode
  getMode(): ProtectionMode {
    return this.config.mode;
  }

  // ============================================
  // WHITELIST MANAGEMENT
  // ============================================

  // Add IP to whitelist
  addToWhitelist(ip: string): void {
    this.config.whitelistedIPs.add(ip);
    logger.info('IP added to DDoS whitelist', { ip });
  }

  // Remove IP from whitelist
  removeFromWhitelist(ip: string): void {
    this.config.whitelistedIPs.delete(ip);
    logger.info('IP removed from DDoS whitelist', { ip });
  }

  // Add merchant to whitelist
  addMerchantToWhitelist(merchantId: string): void {
    this.config.whitelistedMerchants.add(merchantId);
    logger.info('Merchant added to DDoS whitelist', { merchantId });
  }

  // Import whitelist from historical good IPs
  async importHistoricalWhitelist(days: number = 30): Promise<number> {
    // Get IPs that have made successful transactions
    const result = await redisClient.smembers('known_good_ips');

    // Also query database for IPs with successful auth in last N days
    // This would be implemented based on your session/auth logs

    let count = 0;
    for (const ip of result) {
      this.config.whitelistedIPs.add(ip);
      count++;
    }

    logger.info('Imported historical whitelist', { count, days });
    return count;
  }

  // Get whitelist
  getWhitelist(): string[] {
    return Array.from(this.config.whitelistedIPs);
  }

  // ============================================
  // HISTORICAL BASELINE
  // ============================================

  // Calculate baseline from historical data
  async calculateBaseline(
    merchantId?: string,
    days: number = 30
  ): Promise<TrafficBaseline> {
    const key = merchantId || 'global';

    // Get historical metrics from database
    // In production, this would query your metrics/analytics tables
    const metrics = await this.getHistoricalMetrics(merchantId, days);

    const baseline: TrafficBaseline = {
      merchantId,
      maxRequestsPerSecond: metrics.maxRPS,
      maxRequestsPerMinute: metrics.maxRPM,
      avgRequestsPerMinute: metrics.avgRPM,
      p95RequestsPerMinute: metrics.p95RPM,
      maxUniqueIPsPerMinute: metrics.maxUniqueIPs,
      calculatedAt: new Date(),
      samplePeriodDays: days,
    };

    this.baselines.set(key, baseline);

    // Store in Redis for persistence
    await redisClient.set(
      `ddos_baseline:${key}`,
      JSON.stringify(baseline),
      'EX',
      86400 * 7 // 7 days
    );

    logger.info('Traffic baseline calculated', {
      key,
      maxRPM: baseline.maxRequestsPerMinute,
      avgRPM: baseline.avgRequestsPerMinute,
    });

    return baseline;
  }

  // Get baseline
  getBaseline(merchantId?: string): TrafficBaseline | null {
    return this.baselines.get(merchantId || 'global') || null;
  }

  // ============================================
  // TRAFFIC ANALYSIS
  // ============================================

  // Analyze current traffic for anomalies
  async analyzeTraffic(): Promise<{
    isAnomaly: boolean;
    severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
    reasons: string[];
  }> {
    if (!this.currentMetrics) {
      return { isAnomaly: false, severity: 'none', reasons: [] };
    }

    const baseline = this.baselines.get('global');
    if (!baseline) {
      return { isAnomaly: false, severity: 'none', reasons: [] };
    }

    const reasons: string[] = [];
    let severityScore = 0;

    // Check requests per minute vs baseline
    const rpmRatio = this.currentMetrics.requestsPerMinute / baseline.maxRequestsPerMinute;
    if (rpmRatio > 2) {
      reasons.push(`RPM ${rpmRatio.toFixed(1)}x above max baseline`);
      severityScore += rpmRatio > 5 ? 3 : rpmRatio > 3 ? 2 : 1;
    }

    // Check unique IPs
    const ipRatio = this.currentMetrics.uniqueIPs / baseline.maxUniqueIPsPerMinute;
    if (ipRatio > 2) {
      reasons.push(`Unique IPs ${ipRatio.toFixed(1)}x above baseline`);
      severityScore += ipRatio > 5 ? 2 : 1;
    }

    // Check error rate
    if (this.currentMetrics.errorRate > this.config.thresholds.errorRatePercent) {
      reasons.push(`Error rate ${this.currentMetrics.errorRate.toFixed(1)}%`);
      severityScore += 2;
    }

    // Check response time degradation
    if (this.currentMetrics.avgResponseTime > 5000) {
      reasons.push(`Avg response time ${this.currentMetrics.avgResponseTime}ms`);
      severityScore += 2;
    }

    let severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
    if (severityScore === 0) severity = 'none';
    else if (severityScore <= 2) severity = 'low';
    else if (severityScore <= 4) severity = 'medium';
    else if (severityScore <= 6) severity = 'high';
    else severity = 'critical';

    return {
      isAnomaly: severityScore > 0,
      severity,
      reasons,
    };
  }

  // ============================================
  // MIDDLEWARE
  // ============================================

  // Main DDoS protection middleware
  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const clientIP = this.getClientIP(req);
      const merchantId = (req as any).merchantId;

      // Track request for metrics
      await this.trackRequest(clientIP);

      // Check protection mode
      switch (this.config.mode) {
        case 'emergency':
          // Only allow health checks and critical internal endpoints
          if (!this.isEmergencyAllowed(req)) {
            return res.status(503).json({
              error: 'Service temporarily unavailable',
              message: 'Emergency maintenance in progress',
            });
          }
          break;

        case 'whitelist_only':
          // Only allow whitelisted IPs or merchants
          if (!this.isWhitelisted(clientIP, merchantId)) {
            await auditService.logSecurityEvent({
              action: 'ddos_whitelist_blocked',
              severity: 'info',
              success: false,
              ipAddress: clientIP,
              merchantId,
            });

            return res.status(503).json({
              error: 'Service restricted',
              message: 'Access temporarily limited to verified clients',
            });
          }
          break;

        case 'historical_limit':
          // Check against historical baseline
          const allowed = await this.checkHistoricalLimit(clientIP, merchantId);
          if (!allowed) {
            return res.status(429).json({
              error: 'Rate limit exceeded',
              message: 'Traffic exceeds normal patterns. Please try again later.',
            });
          }
          break;

        case 'elevated':
          // Apply stricter rate limits
          const elevatedAllowed = await this.checkElevatedLimits(clientIP);
          if (!elevatedAllowed) {
            return res.status(429).json({
              error: 'Rate limit exceeded',
              message: 'Elevated security measures in effect',
            });
          }
          break;
      }

      // Check geo-blocking
      if (this.config.geoBlockedCountries.size > 0) {
        const country = await this.getCountryFromIP(clientIP);
        if (country && this.config.geoBlockedCountries.has(country)) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'Service not available in your region',
          });
        }
      }

      // Challenge suspicious requests
      if (this.config.challengeEnabled && await this.shouldChallenge(clientIP)) {
        return res.status(429).json({
          error: 'Challenge required',
          challengeUrl: `/challenge?token=${await this.generateChallengeToken(clientIP)}`,
        });
      }

      next();
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  private isWhitelisted(ip: string, merchantId?: string): boolean {
    if (this.config.whitelistedIPs.has(ip)) return true;
    if (merchantId && this.config.whitelistedMerchants.has(merchantId)) return true;
    return false;
  }

  private isEmergencyAllowed(req: Request): boolean {
    // Allow health checks
    if (req.path === '/health' || req.path === '/ready') return true;
    // Allow from localhost
    const ip = this.getClientIP(req);
    if (ip === '127.0.0.1' || ip === '::1') return true;
    return false;
  }

  private async checkHistoricalLimit(
    ip: string,
    merchantId?: string
  ): Promise<boolean> {
    const baseline = this.baselines.get(merchantId || 'global');
    if (!baseline) return true; // No baseline, allow

    // Check current rate against historical max * multiplier
    const key = `ddos_rate:${ip}`;
    const current = await redisClient.incr(key);

    if (current === 1) {
      await redisClient.expire(key, 60); // 1 minute window
    }

    const limit = Math.ceil(
      baseline.maxRequestsPerMinute * this.config.historicalMultiplier / 100
    ); // Per IP limit (assume 100 IPs)

    return current <= limit;
  }

  private async checkElevatedLimits(ip: string): Promise<boolean> {
    const key = `ddos_elevated:${ip}`;
    const current = await redisClient.incr(key);

    if (current === 1) {
      await redisClient.expire(key, 60);
    }

    // 50% of normal limits in elevated mode
    return current <= this.config.thresholds.requestsPerMinute / 200;
  }

  private async shouldChallenge(ip: string): Promise<boolean> {
    // Check if IP has suspicious patterns
    const key = `ddos_suspicious:${ip}`;
    const suspicious = await redisClient.get(key);
    return suspicious !== null;
  }

  private async generateChallengeToken(ip: string): Promise<string> {
    const token = `challenge_${Date.now()}_${Math.random().toString(36).substr(2)}`;
    await redisClient.setex(`challenge:${token}`, 300, ip);
    return token;
  }

  private async trackRequest(ip: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Track for metrics
    await redisClient.hincrby('ddos_metrics', `requests:${now}`, 1);
    await redisClient.pfadd(`ddos_unique_ips:${now}`, ip);

    // Expire old data
    await redisClient.expire('ddos_metrics', 3600);
    await redisClient.expire(`ddos_unique_ips:${now}`, 120);

    // Track known good IPs (for whitelist import)
    const successKey = `ip_success:${ip}`;
    const successCount = await redisClient.get(successKey);
    if (successCount && parseInt(successCount) > 10) {
      await redisClient.sadd('known_good_ips', ip);
    }
  }

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(async () => {
      await this.collectMetrics();

      // Auto-escalate if needed
      if (this.config.autoEscalate) {
        const analysis = await this.analyzeTraffic();

        if (analysis.severity === 'critical' && this.config.mode === 'normal') {
          await this.enableHistoricalLimitMode(1.0, 'Auto-escalation: Critical traffic anomaly');
        } else if (analysis.severity === 'high' && this.config.mode === 'normal') {
          this.config.mode = 'elevated';
          logger.warn('DDoS protection: Elevated mode (auto)', { reasons: analysis.reasons });
        }
      }
    }, 10000); // Every 10 seconds
  }

  private async collectMetrics(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Get requests in last minute
    let requestsPerMinute = 0;
    for (let i = 0; i < 60; i++) {
      const count = await redisClient.hget('ddos_metrics', `requests:${now - i}`);
      requestsPerMinute += parseInt(count || '0');
    }

    // Get unique IPs
    const uniqueIPs = await redisClient.pfcount(`ddos_unique_ips:${now}`);

    this.currentMetrics = {
      requestsPerSecond: Math.round(requestsPerMinute / 60),
      requestsPerMinute,
      uniqueIPs,
      avgResponseTime: 0, // Would come from APM
      errorRate: 0, // Would come from error tracking
      timestamp: new Date(),
    };
  }

  private async getHistoricalMetrics(
    merchantId: string | undefined,
    days: number
  ): Promise<{
    maxRPS: number;
    maxRPM: number;
    avgRPM: number;
    p95RPM: number;
    maxUniqueIPs: number;
  }> {
    // In production, query your analytics/metrics database
    // This is simulated data
    return {
      maxRPS: 100,
      maxRPM: 5000,
      avgRPM: 1000,
      p95RPM: 3000,
      maxUniqueIPs: 500,
    };
  }

  private async loadBaselines(): Promise<void> {
    // Load from Redis
    const keys = await redisClient.keys('ddos_baseline:*');
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) {
        const baseline = JSON.parse(data);
        const id = key.replace('ddos_baseline:', '');
        this.baselines.set(id, baseline);
      }
    }
  }

  private async saveEvent(event: DDoSEvent): Promise<void> {
    // Save to database for analysis
    logger.info('DDoS event recorded', {
      id: event.id,
      type: event.type,
      severity: event.severity,
      duration: event.resolvedAt
        ? (event.resolvedAt.getTime() - event.detectedAt.getTime()) / 1000
        : null,
    });
  }

  private getClientIP(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return (forwarded as string).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  private async getCountryFromIP(ip: string): Promise<string | null> {
    // In production, use MaxMind GeoIP or similar
    return null;
  }

  // Shutdown
  shutdown(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }
}

export const ddosProtection = new DDoSProtectionService();

// Express middleware export
export const ddosMiddleware = () => ddosProtection.middleware();
