import { logger } from '../../utils/logger';
import { redisClient } from '../../config/redis';

// Feature flag types
export interface FeatureFlag {
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  rolloutPercentage?: number; // 0-100
  targetMerchants?: string[]; // Specific merchants
  targetEnvironments?: ('development' | 'staging' | 'production')[];
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeatureFlagEvaluation {
  key: string;
  enabled: boolean;
  reason: 'default' | 'merchant_targeted' | 'environment' | 'rollout' | 'disabled';
}

// Feature flag definitions
export const FEATURE_FLAGS = {
  // Payment features
  CRYPTO_PAYMENTS: 'crypto_payments',
  INSTANT_PAYOUTS: 'instant_payouts',
  MULTI_CURRENCY: 'multi_currency',
  DYNAMIC_PRICING: 'dynamic_pricing',

  // Fraud features
  AI_FRAUD_DETECTION: 'ai_fraud_detection',
  VELOCITY_CHECKS: 'velocity_checks',
  DEVICE_FINGERPRINTING: 'device_fingerprinting',

  // Subscription features
  SUBSCRIPTION_PAUSE: 'subscription_pause',
  PRORATED_BILLING: 'prorated_billing',
  CUSTOM_BILLING_CYCLES: 'custom_billing_cycles',

  // Integration features
  WEBHOOK_V2: 'webhook_v2',
  GRAPHQL_API: 'graphql_api',
  REALTIME_EVENTS: 'realtime_events',

  // Reporting features
  ADVANCED_ANALYTICS: 'advanced_analytics',
  CUSTOM_REPORTS: 'custom_reports',
  EXPORT_SCHEDULING: 'export_scheduling',

  // Platform features
  MARKETPLACE_MODE: 'marketplace_mode',
  WHITE_LABEL: 'white_label',
  CUSTOM_DOMAINS: 'custom_domains',
} as const;

export type FeatureFlagKey = typeof FEATURE_FLAGS[keyof typeof FEATURE_FLAGS];

class FeatureFlagSystem {
  private flags: Map<string, FeatureFlag> = new Map();
  private cachePrefix = 'feature_flag:';
  private cacheTTL = 300; // 5 minutes
  private environment: string;

  constructor() {
    this.environment = process.env.NODE_ENV || 'development';
  }

  // Initialize with default flags
  async initialize(): Promise<void> {
    const defaultFlags: Partial<FeatureFlag>[] = [
      {
        key: FEATURE_FLAGS.CRYPTO_PAYMENTS,
        name: 'Cryptocurrency Payments',
        description: 'Enable Bitcoin and stablecoin payments',
        enabled: true,
        targetEnvironments: ['production', 'staging'],
      },
      {
        key: FEATURE_FLAGS.INSTANT_PAYOUTS,
        name: 'Instant Payouts',
        description: 'Enable instant payout processing',
        enabled: false,
        rolloutPercentage: 10,
      },
      {
        key: FEATURE_FLAGS.AI_FRAUD_DETECTION,
        name: 'AI Fraud Detection',
        description: 'Use AI/ML for fraud detection',
        enabled: true,
        rolloutPercentage: 50,
      },
      {
        key: FEATURE_FLAGS.VELOCITY_CHECKS,
        name: 'Velocity Checks',
        description: 'Rate limiting and velocity fraud checks',
        enabled: true,
      },
      {
        key: FEATURE_FLAGS.SUBSCRIPTION_PAUSE,
        name: 'Subscription Pause',
        description: 'Allow customers to pause subscriptions',
        enabled: false,
      },
      {
        key: FEATURE_FLAGS.WEBHOOK_V2,
        name: 'Webhook V2',
        description: 'New webhook format with enhanced data',
        enabled: false,
        rolloutPercentage: 25,
      },
      {
        key: FEATURE_FLAGS.ADVANCED_ANALYTICS,
        name: 'Advanced Analytics',
        description: 'Enhanced analytics and insights',
        enabled: true,
      },
      {
        key: FEATURE_FLAGS.MARKETPLACE_MODE,
        name: 'Marketplace Mode',
        description: 'Enable marketplace/platform features',
        enabled: false,
      },
    ];

    for (const flag of defaultFlags) {
      if (!this.flags.has(flag.key!)) {
        await this.create({
          ...flag,
          key: flag.key!,
          name: flag.name!,
          enabled: flag.enabled ?? false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    logger.info('Feature flag system initialized', { flagCount: this.flags.size });
  }

  // Create or update a feature flag
  async create(flag: FeatureFlag): Promise<FeatureFlag> {
    this.flags.set(flag.key, flag);

    // Cache in Redis
    try {
      await redisClient.setex(
        `${this.cachePrefix}${flag.key}`,
        this.cacheTTL,
        JSON.stringify(flag)
      );
    } catch (error) {
      logger.warn('Failed to cache feature flag', { key: flag.key, error });
    }

    logger.debug('Feature flag created/updated', { key: flag.key, enabled: flag.enabled });
    return flag;
  }

  // Get a feature flag
  async get(key: string): Promise<FeatureFlag | null> {
    // Check memory cache first
    if (this.flags.has(key)) {
      return this.flags.get(key)!;
    }

    // Check Redis cache
    try {
      const cached = await redisClient.get(`${this.cachePrefix}${key}`);
      if (cached) {
        const flag = JSON.parse(cached);
        this.flags.set(key, flag);
        return flag;
      }
    } catch (error) {
      logger.warn('Failed to get feature flag from cache', { key, error });
    }

    return null;
  }

  // Evaluate if a feature is enabled for a specific context
  async isEnabled(
    key: string,
    context: {
      merchantId?: string;
      userId?: string;
      environment?: string;
    } = {}
  ): Promise<boolean> {
    const evaluation = await this.evaluate(key, context);
    return evaluation.enabled;
  }

  // Full evaluation with reason
  async evaluate(
    key: string,
    context: {
      merchantId?: string;
      userId?: string;
      environment?: string;
    } = {}
  ): Promise<FeatureFlagEvaluation> {
    const flag = await this.get(key);

    if (!flag) {
      return { key, enabled: false, reason: 'default' };
    }

    // Check if globally disabled
    if (!flag.enabled) {
      return { key, enabled: false, reason: 'disabled' };
    }

    // Check environment targeting
    if (flag.targetEnvironments && flag.targetEnvironments.length > 0) {
      const currentEnv = (context.environment || this.environment) as any;
      if (!flag.targetEnvironments.includes(currentEnv)) {
        return { key, enabled: false, reason: 'environment' };
      }
    }

    // Check merchant targeting
    if (flag.targetMerchants && flag.targetMerchants.length > 0) {
      if (context.merchantId && flag.targetMerchants.includes(context.merchantId)) {
        return { key, enabled: true, reason: 'merchant_targeted' };
      }
      // If merchant targeting is specified but merchant not in list, check rollout
      if (context.merchantId && !flag.targetMerchants.includes(context.merchantId)) {
        // Fall through to rollout check
      }
    }

    // Check rollout percentage
    if (flag.rolloutPercentage !== undefined && flag.rolloutPercentage < 100) {
      const hash = this.hashString(`${key}:${context.merchantId || context.userId || 'default'}`);
      const bucket = hash % 100;

      if (bucket >= flag.rolloutPercentage) {
        return { key, enabled: false, reason: 'rollout' };
      }
      return { key, enabled: true, reason: 'rollout' };
    }

    return { key, enabled: true, reason: 'default' };
  }

  // Toggle a feature flag
  async toggle(key: string): Promise<FeatureFlag | null> {
    const flag = await this.get(key);
    if (!flag) return null;

    flag.enabled = !flag.enabled;
    flag.updatedAt = new Date();

    return this.create(flag);
  }

  // Update rollout percentage
  async setRollout(key: string, percentage: number): Promise<FeatureFlag | null> {
    if (percentage < 0 || percentage > 100) {
      throw new Error('Rollout percentage must be between 0 and 100');
    }

    const flag = await this.get(key);
    if (!flag) return null;

    flag.rolloutPercentage = percentage;
    flag.updatedAt = new Date();

    return this.create(flag);
  }

  // Add merchant to target list
  async addTargetMerchant(key: string, merchantId: string): Promise<FeatureFlag | null> {
    const flag = await this.get(key);
    if (!flag) return null;

    if (!flag.targetMerchants) {
      flag.targetMerchants = [];
    }

    if (!flag.targetMerchants.includes(merchantId)) {
      flag.targetMerchants.push(merchantId);
      flag.updatedAt = new Date();
      return this.create(flag);
    }

    return flag;
  }

  // Remove merchant from target list
  async removeTargetMerchant(key: string, merchantId: string): Promise<FeatureFlag | null> {
    const flag = await this.get(key);
    if (!flag || !flag.targetMerchants) return flag;

    flag.targetMerchants = flag.targetMerchants.filter(id => id !== merchantId);
    flag.updatedAt = new Date();

    return this.create(flag);
  }

  // List all flags
  list(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }

  // Delete a flag
  async delete(key: string): Promise<boolean> {
    const deleted = this.flags.delete(key);

    try {
      await redisClient.del(`${this.cachePrefix}${key}`);
    } catch (error) {
      logger.warn('Failed to delete feature flag from cache', { key, error });
    }

    return deleted;
  }

  // Clear all flags (for testing)
  clear(): void {
    this.flags.clear();
  }

  // Simple hash function for consistent rollout bucketing
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

// Singleton instance
export const featureFlags = new FeatureFlagSystem();

// Helper decorator for feature-gated methods
export function FeatureGated(featureKey: string, fallback?: any) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Extract merchantId from first argument if it's an object with merchantId
      let merchantId: string | undefined;
      if (args[0] && typeof args[0] === 'object' && 'merchantId' in args[0]) {
        merchantId = args[0].merchantId;
      }

      const isEnabled = await featureFlags.isEnabled(featureKey, { merchantId });

      if (!isEnabled) {
        if (fallback !== undefined) {
          return fallback;
        }
        throw new Error(`Feature '${featureKey}' is not enabled`);
      }

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}

// Middleware for Express routes
export function featureFlagMiddleware(featureKey: string) {
  return async (req: any, res: any, next: any) => {
    const merchantId = req.merchantId;
    const isEnabled = await featureFlags.isEnabled(featureKey, { merchantId });

    if (!isEnabled) {
      return res.status(403).json({
        error: 'Feature not available',
        message: `The feature '${featureKey}' is not enabled for your account`,
      });
    }

    next();
  };
}
