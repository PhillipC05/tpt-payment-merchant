import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  // Server
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),

  // Database
  databaseUrl: z.string(),
  databasePoolMin: z.coerce.number().default(2),
  databasePoolMax: z.coerce.number().default(10),

  // Redis
  redisUrl: z.string().default('redis://localhost:6379'),

  // JWT
  jwtSecret: z.string().min(32),
  jwtExpiresIn: z.string().default('24h'),
  jwtRefreshSecret: z.string().min(32),
  jwtRefreshExpiresIn: z.string().default('7d'),

  // Encryption
  encryptionKey: z.string().min(32),

  // Stripe
  stripeSecretKey: z.string().optional(),
  stripePublishableKey: z.string().optional(),
  stripeWebhookSecret: z.string().optional(),

  // PayPal
  paypalClientId: z.string().optional(),
  paypalClientSecret: z.string().optional(),
  paypalMode: z.enum(['sandbox', 'live']).default('sandbox'),

  // Tax
  taxServiceProvider: z.enum(['internal', 'taxjar', 'avalara']).default('internal'),
  taxApiKey: z.string().optional(),

  // Webhooks
  webhookSigningSecret: z.string().optional(),
  webhookTimeoutMs: z.coerce.number().default(30000),

  // Rate Limiting
  rateLimitWindowMs: z.coerce.number().default(900000),
  rateLimitMaxRequests: z.coerce.number().default(100),

  // Logging
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  logFormat: z.enum(['json', 'simple']).default('json'),

  // CORS
  corsOrigins: z.string().default('*'),

  // Platform detection
  isRailway: z.boolean().default(false),
  isDigitalOcean: z.boolean().default(false),
});

function loadConfig() {
  const rawConfig = {
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    host: process.env.HOST,
    databaseUrl: process.env.DATABASE_URL,
    databasePoolMin: process.env.DATABASE_POOL_MIN,
    databasePoolMax: process.env.DATABASE_POOL_MAX,
    redisUrl: process.env.REDIS_URL,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN,
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
    jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN,
    encryptionKey: process.env.ENCRYPTION_KEY,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET,
    paypalMode: process.env.PAYPAL_MODE,
    taxServiceProvider: process.env.TAX_SERVICE_PROVIDER,
    taxApiKey: process.env.TAX_API_KEY,
    webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET,
    webhookTimeoutMs: process.env.WEBHOOK_TIMEOUT_MS,
    rateLimitWindowMs: process.env.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: process.env.RATE_LIMIT_MAX_REQUESTS,
    logLevel: process.env.LOG_LEVEL,
    logFormat: process.env.LOG_FORMAT,
    corsOrigins: process.env.CORS_ORIGINS,
    isRailway: !!process.env.RAILWAY_ENVIRONMENT,
    isDigitalOcean: !!process.env.DO_APP_PLATFORM,
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    console.error('Configuration validation failed:');
    console.error(result.error.format());
    throw new Error('Invalid configuration');
  }

  return result.data;
}

export const config = loadConfig();

export type Config = z.infer<typeof configSchema>;

// Helper to detect platform
export function getPlatform(): 'railway' | 'digitalocean' | 'docker' | 'local' {
  if (config.isRailway) return 'railway';
  if (config.isDigitalOcean) return 'digitalocean';
  if (process.env.DOCKER_CONTAINER) return 'docker';
  return 'local';
}

// Parse CORS origins
export function getCorsOrigins(): string[] | string {
  if (config.corsOrigins === '*') return '*';
  return config.corsOrigins.split(',').map(origin => origin.trim());
}
