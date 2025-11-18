import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    redis.on('connect', () => {
      logger.info('Redis connected');
    });

    redis.on('error', (error) => {
      logger.error('Redis error', { error: error.message });
    });

    redis.on('close', () => {
      logger.warn('Redis connection closed');
    });
  }

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    logger.info('Redis connection closed');
  }
}

export async function redisHealthCheck(): Promise<boolean> {
  try {
    const client = getRedis();
    const result = await client.ping();
    return result === 'PONG';
  } catch (error) {
    logger.error('Redis health check failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

// Cache helpers
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis();
  const value = await client.get(key);
  return value ? JSON.parse(value) : null;
}

export async function cacheSet(
  key: string,
  value: any,
  ttlSeconds?: number
): Promise<void> {
  const client = getRedis();
  const serialized = JSON.stringify(value);

  if (ttlSeconds) {
    await client.setex(key, ttlSeconds, serialized);
  } else {
    await client.set(key, serialized);
  }
}

export async function cacheDelete(key: string): Promise<void> {
  const client = getRedis();
  await client.del(key);
}

export async function cacheDeletePattern(pattern: string): Promise<void> {
  const client = getRedis();
  const keys = await client.keys(pattern);
  if (keys.length > 0) {
    await client.del(...keys);
  }
}

// Rate limiting helpers
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const client = getRedis();
  const now = Date.now();
  const windowStart = now - windowMs;

  // Remove old entries
  await client.zremrangebyscore(key, 0, windowStart);

  // Get current count
  const count = await client.zcard(key);

  if (count >= limit) {
    const oldestEntry = await client.zrange(key, 0, 0, 'WITHSCORES');
    const resetAt = oldestEntry.length > 1
      ? parseInt(oldestEntry[1]) + windowMs
      : now + windowMs;

    return {
      allowed: false,
      remaining: 0,
      resetAt,
    };
  }

  // Add new entry
  await client.zadd(key, now, `${now}-${Math.random()}`);
  await client.pexpire(key, windowMs);

  return {
    allowed: true,
    remaining: limit - count - 1,
    resetAt: now + windowMs,
  };
}

// Idempotency key storage
export async function setIdempotencyKey(
  key: string,
  response: any,
  ttlSeconds: number = 86400
): Promise<void> {
  const client = getRedis();
  await client.setex(`idempotency:${key}`, ttlSeconds, JSON.stringify(response));
}

export async function getIdempotencyKey(key: string): Promise<any | null> {
  const client = getRedis();
  const value = await client.get(`idempotency:${key}`);
  return value ? JSON.parse(value) : null;
}

// Distributed locking
export async function acquireLock(
  key: string,
  ttlMs: number = 30000
): Promise<string | null> {
  const client = getRedis();
  const lockId = `${Date.now()}-${Math.random()}`;
  const acquired = await client.set(
    `lock:${key}`,
    lockId,
    'PX',
    ttlMs,
    'NX'
  );
  return acquired ? lockId : null;
}

export async function releaseLock(key: string, lockId: string): Promise<boolean> {
  const client = getRedis();
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  const result = await client.eval(script, 1, `lock:${key}`, lockId);
  return result === 1;
}
