import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { auditService } from './audit.service';
import { redisClient } from '../config/redis';

// Security rules
interface SecurityRule {
  name: string;
  check: (req: Request) => boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  action: 'log' | 'block' | 'challenge';
}

// Rate limit config
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

// WAF configuration
const WAF_CONFIG = {
  enabled: true,
  rules: {
    sqlInjection: true,
    xss: true,
    pathTraversal: true,
    commandInjection: true,
    requestSize: true,
    suspiciousHeaders: true,
  },
  maxRequestSize: 10 * 1024 * 1024, // 10MB
  blockedIPs: new Set<string>(),
  allowedIPs: new Set<string>(),
};

// SQL injection patterns
const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|TRUNCATE)\b)/i,
  /(--|\/\*|\*\/|;)/,
  /(\bOR\b|\bAND\b)\s*\d+\s*=\s*\d+/i,
  /'\s*(OR|AND)\s*'?\d+'\s*=\s*'\d+/i,
  /SLEEP\s*\(\s*\d+\s*\)/i,
  /BENCHMARK\s*\(/i,
];

// XSS patterns
const XSS_PATTERNS = [
  /<script[^>]*>[\s\S]*?<\/script>/gi,
  /javascript:/gi,
  /on\w+\s*=/gi,
  /<iframe/gi,
  /<embed/gi,
  /<object/gi,
  /eval\s*\(/gi,
];

// Path traversal patterns
const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//,
  /\.\.\\|/,
  /%2e%2e%2f/i,
  /%2e%2e\//i,
  /\.\.%2f/i,
];

// Command injection patterns
const COMMAND_INJECTION_PATTERNS = [
  /[;&|`$]/,
  /\$\(/,
  /`.*`/,
];

// Security rules
const securityRules: SecurityRule[] = [
  {
    name: 'sql_injection',
    check: (req) => {
      const payload = JSON.stringify({ ...req.query, ...req.body, ...req.params });
      return SQL_INJECTION_PATTERNS.some(pattern => pattern.test(payload));
    },
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'xss_attack',
    check: (req) => {
      const payload = JSON.stringify({ ...req.query, ...req.body, ...req.params });
      return XSS_PATTERNS.some(pattern => pattern.test(payload));
    },
    severity: 'high',
    action: 'block',
  },
  {
    name: 'path_traversal',
    check: (req) => {
      const path = req.path + JSON.stringify(req.query);
      return PATH_TRAVERSAL_PATTERNS.some(pattern => pattern.test(path));
    },
    severity: 'high',
    action: 'block',
  },
  {
    name: 'command_injection',
    check: (req) => {
      const payload = JSON.stringify(req.body);
      return COMMAND_INJECTION_PATTERNS.some(pattern => pattern.test(payload));
    },
    severity: 'critical',
    action: 'block',
  },
  {
    name: 'oversized_request',
    check: (req) => {
      const contentLength = parseInt(req.headers['content-length'] || '0');
      return contentLength > WAF_CONFIG.maxRequestSize;
    },
    severity: 'medium',
    action: 'block',
  },
  {
    name: 'suspicious_user_agent',
    check: (req) => {
      const ua = req.headers['user-agent'] || '';
      const suspicious = ['sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab'];
      return suspicious.some(s => ua.toLowerCase().includes(s));
    },
    severity: 'high',
    action: 'block',
  },
];

// WAF middleware
export function wafMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!WAF_CONFIG.enabled) {
      return next();
    }

    const clientIP = getClientIP(req);

    // Check IP allowlist
    if (WAF_CONFIG.allowedIPs.has(clientIP)) {
      return next();
    }

    // Check IP blocklist
    if (WAF_CONFIG.blockedIPs.has(clientIP)) {
      await auditService.logSecurityEvent({
        action: 'blocked_ip_access',
        severity: 'warning',
        success: false,
        ipAddress: clientIP,
        metadata: { reason: 'IP in blocklist' },
      });

      return res.status(403).json({
        error: 'Access denied',
        message: 'Your IP address has been blocked',
      });
    }

    // Run security rules
    for (const rule of securityRules) {
      try {
        if (rule.check(req)) {
          await auditService.logSecurityEvent({
            action: `waf_${rule.name}`,
            severity: rule.severity === 'critical' ? 'critical' : 'warning',
            success: false,
            ipAddress: clientIP,
            metadata: {
              rule: rule.name,
              path: req.path,
              method: req.method,
            },
          });

          logger.warn('WAF rule triggered', {
            rule: rule.name,
            severity: rule.severity,
            ip: clientIP,
            path: req.path,
          });

          if (rule.action === 'block') {
            return res.status(403).json({
              error: 'Request blocked',
              message: 'Your request was blocked by security rules',
            });
          }
        }
      } catch (error) {
        logger.error('WAF rule error', { rule: rule.name, error });
      }
    }

    next();
  };
}

// Rate limiting middleware
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const clientIP = getClientIP(req);
    const key = `${config.keyPrefix}:${clientIP}`;

    try {
      const current = await redisClient.incr(key);

      if (current === 1) {
        await redisClient.pexpire(key, config.windowMs);
      }

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', config.maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, config.maxRequests - current));

      if (current > config.maxRequests) {
        await auditService.logSecurityEvent({
          action: 'rate_limit_exceeded',
          severity: 'warning',
          success: false,
          ipAddress: clientIP,
          metadata: {
            key: config.keyPrefix,
            current,
            limit: config.maxRequests,
          },
        });

        const ttl = await redisClient.pttl(key);
        res.setHeader('Retry-After', Math.ceil(ttl / 1000));

        return res.status(429).json({
          error: 'Too many requests',
          message: 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(ttl / 1000),
        });
      }

      next();
    } catch (error) {
      logger.error('Rate limit error', { error });
      next(); // Fail open
    }
  };
}

// API rate limits
export const apiRateLimit = rateLimitMiddleware({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,
  keyPrefix: 'rl:api',
});

// Auth rate limits (stricter)
export const authRateLimit = rateLimitMiddleware({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5,
  keyPrefix: 'rl:auth',
});

// Webhook rate limits
export const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60 * 1000,
  maxRequests: 1000,
  keyPrefix: 'rl:webhook',
});

// IP blocking middleware
export function ipBlockingMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const clientIP = getClientIP(req);

    // Check for too many failed attempts
    const failedKey = `failed_attempts:${clientIP}`;
    const failed = await redisClient.get(failedKey);

    if (failed && parseInt(failed) > 10) {
      // Auto-block IP
      WAF_CONFIG.blockedIPs.add(clientIP);

      await auditService.logSecurityEvent({
        action: 'ip_auto_blocked',
        severity: 'warning',
        success: true,
        ipAddress: clientIP,
        metadata: { failedAttempts: failed },
      });

      return res.status(403).json({
        error: 'Access denied',
        message: 'Too many failed attempts',
      });
    }

    next();
  };
}

// Track failed attempts
export async function trackFailedAttempt(ip: string): Promise<void> {
  const key = `failed_attempts:${ip}`;
  const current = await redisClient.incr(key);

  if (current === 1) {
    await redisClient.expire(key, 3600); // 1 hour
  }
}

// Clear failed attempts
export async function clearFailedAttempts(ip: string): Promise<void> {
  await redisClient.del(`failed_attempts:${ip}`);
}

// Request ID middleware
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers['x-request-id'] as string || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
  };
}

// Security headers middleware
export function securityHeadersMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Enable XSS filter
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Content Security Policy
    res.setHeader('Content-Security-Policy', "default-src 'self'");

    // HSTS
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    next();
  };
}

// Get client IP
function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = (forwarded as string).split(',');
    return ips[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Block IP
export function blockIP(ip: string): void {
  WAF_CONFIG.blockedIPs.add(ip);
  logger.info('IP blocked', { ip });
}

// Unblock IP
export function unblockIP(ip: string): void {
  WAF_CONFIG.blockedIPs.delete(ip);
  logger.info('IP unblocked', { ip });
}

// Allow IP
export function allowIP(ip: string): void {
  WAF_CONFIG.allowedIPs.add(ip);
}

// Get blocked IPs
export function getBlockedIPs(): string[] {
  return Array.from(WAF_CONFIG.blockedIPs);
}
