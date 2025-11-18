import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { checkRateLimit } from '../database/redis';
import { config } from '../config';
import { RateLimitError } from '../utils/errors';

// Basic rate limiter using express-rate-limit
export const basicRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later',
    },
  },
});

// Redis-based rate limiter for distributed systems
export function redisRateLimiter(options: {
  windowMs?: number;
  max?: number;
  keyGenerator?: (req: Request) => string;
}) {
  const {
    windowMs = config.rateLimitWindowMs,
    max = config.rateLimitMaxRequests,
    keyGenerator = (req) => req.merchantId || req.ip,
  } = options;

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const key = `ratelimit:${keyGenerator(req)}`;
      const result = await checkRateLimit(key, max, windowMs);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

      if (!result.allowed) {
        throw new RateLimitError();
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

// Stricter rate limit for sensitive endpoints
export const strictRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many attempts, please try again later',
    },
  },
});
