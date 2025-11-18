import { logger } from '../../utils/logger';
import {
  PaymentGatewayProvider,
  CryptoPaymentProvider,
  TaxProvider,
  FraudProvider,
  NotificationProvider,
  StorageProvider,
  PayoutProvider,
} from '../providers';

// Provider types
export type ProviderType =
  | 'payment_gateway'
  | 'crypto'
  | 'tax'
  | 'fraud'
  | 'notification'
  | 'storage'
  | 'payout';

// Union type for all providers
export type Provider =
  | PaymentGatewayProvider
  | CryptoPaymentProvider
  | TaxProvider
  | FraudProvider
  | NotificationProvider
  | StorageProvider
  | PayoutProvider;

// Registration metadata
interface RegisteredProvider<T extends Provider = Provider> {
  type: ProviderType;
  name: string;
  provider: T;
  priority: number; // Lower = higher priority
  isDefault: boolean;
  enabled: boolean;
  config?: Record<string, any>;
  healthCheck?: () => Promise<boolean>;
}

// Health status
interface ProviderHealth {
  name: string;
  type: ProviderType;
  healthy: boolean;
  lastCheck: Date;
  error?: string;
}

class ModuleRegistry {
  private providers: Map<ProviderType, Map<string, RegisteredProvider>> = new Map();
  private healthStatus: Map<string, ProviderHealth> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;

  constructor() {
    // Initialize provider type maps
    const types: ProviderType[] = [
      'payment_gateway',
      'crypto',
      'tax',
      'fraud',
      'notification',
      'storage',
      'payout',
    ];
    types.forEach(type => this.providers.set(type, new Map()));
  }

  // Register a provider
  register<T extends Provider>(
    type: ProviderType,
    provider: T,
    options: {
      priority?: number;
      isDefault?: boolean;
      config?: Record<string, any>;
      healthCheck?: () => Promise<boolean>;
    } = {}
  ): void {
    const typeMap = this.providers.get(type);
    if (!typeMap) {
      throw new Error(`Unknown provider type: ${type}`);
    }

    const name = provider.name;
    const registered: RegisteredProvider<T> = {
      type,
      name,
      provider,
      priority: options.priority ?? 100,
      isDefault: options.isDefault ?? false,
      enabled: true,
      config: options.config,
      healthCheck: options.healthCheck,
    };

    // If this is default, unset other defaults
    if (registered.isDefault) {
      for (const [, existing] of typeMap) {
        existing.isDefault = false;
      }
    }

    // If this is the first provider of this type, make it default
    if (typeMap.size === 0) {
      registered.isDefault = true;
    }

    typeMap.set(name, registered);

    logger.info('Provider registered', {
      type,
      name,
      isDefault: registered.isDefault,
      priority: registered.priority,
    });
  }

  // Unregister a provider
  unregister(type: ProviderType, name: string): boolean {
    const typeMap = this.providers.get(type);
    if (!typeMap) return false;

    const deleted = typeMap.delete(name);
    if (deleted) {
      logger.info('Provider unregistered', { type, name });
    }
    return deleted;
  }

  // Get a specific provider by name
  get<T extends Provider>(type: ProviderType, name: string): T | null {
    const typeMap = this.providers.get(type);
    if (!typeMap) return null;

    const registered = typeMap.get(name);
    if (!registered || !registered.enabled) return null;

    return registered.provider as T;
  }

  // Get the default provider for a type
  getDefault<T extends Provider>(type: ProviderType): T | null {
    const typeMap = this.providers.get(type);
    if (!typeMap) return null;

    // Find default provider
    for (const [, registered] of typeMap) {
      if (registered.isDefault && registered.enabled) {
        return registered.provider as T;
      }
    }

    // Fall back to highest priority enabled provider
    const sorted = Array.from(typeMap.values())
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority);

    return sorted.length > 0 ? (sorted[0].provider as T) : null;
  }

  // Get all providers of a type
  getAll<T extends Provider>(type: ProviderType): T[] {
    const typeMap = this.providers.get(type);
    if (!typeMap) return [];

    return Array.from(typeMap.values())
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority)
      .map(p => p.provider as T);
  }

  // Set default provider
  setDefault(type: ProviderType, name: string): boolean {
    const typeMap = this.providers.get(type);
    if (!typeMap) return false;

    const target = typeMap.get(name);
    if (!target) return false;

    // Unset all defaults
    for (const [, registered] of typeMap) {
      registered.isDefault = false;
    }

    // Set new default
    target.isDefault = true;

    logger.info('Default provider set', { type, name });
    return true;
  }

  // Enable/disable a provider
  setEnabled(type: ProviderType, name: string, enabled: boolean): boolean {
    const typeMap = this.providers.get(type);
    if (!typeMap) return false;

    const registered = typeMap.get(name);
    if (!registered) return false;

    registered.enabled = enabled;
    logger.info('Provider enabled status changed', { type, name, enabled });
    return true;
  }

  // List all registered providers
  list(type?: ProviderType): RegisteredProvider[] {
    if (type) {
      const typeMap = this.providers.get(type);
      return typeMap ? Array.from(typeMap.values()) : [];
    }

    const all: RegisteredProvider[] = [];
    for (const typeMap of this.providers.values()) {
      all.push(...typeMap.values());
    }
    return all;
  }

  // Initialize all providers
  async initializeAll(): Promise<void> {
    const results: { name: string; success: boolean; error?: string }[] = [];

    for (const [type, typeMap] of this.providers) {
      for (const [name, registered] of typeMap) {
        try {
          if ('initialize' in registered.provider && typeof registered.provider.initialize === 'function') {
            await registered.provider.initialize(registered.config || {});
            results.push({ name, success: true });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          results.push({ name, success: false, error: errorMessage });
          logger.error('Failed to initialize provider', { type, name, error: errorMessage });
        }
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    logger.info('Provider initialization complete', { successful, failed });
  }

  // Health check for all providers
  async checkHealth(): Promise<ProviderHealth[]> {
    const results: ProviderHealth[] = [];

    for (const [type, typeMap] of this.providers) {
      for (const [name, registered] of typeMap) {
        let healthy = true;
        let error: string | undefined;

        if (registered.healthCheck) {
          try {
            healthy = await registered.healthCheck();
          } catch (err) {
            healthy = false;
            error = err instanceof Error ? err.message : 'Health check failed';
          }
        }

        const health: ProviderHealth = {
          name,
          type,
          healthy,
          lastCheck: new Date(),
          error,
        };

        this.healthStatus.set(`${type}:${name}`, health);
        results.push(health);
      }
    }

    return results;
  }

  // Get health status
  getHealth(type?: ProviderType): ProviderHealth[] {
    const results: ProviderHealth[] = [];

    for (const [key, health] of this.healthStatus) {
      if (!type || health.type === type) {
        results.push(health);
      }
    }

    return results;
  }

  // Start periodic health checks
  startHealthChecks(intervalMs: number = 60000): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.checkHealth();
    }, intervalMs);

    // Run initial check
    this.checkHealth();

    logger.info('Health checks started', { intervalMs });
  }

  // Stop health checks
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
      logger.info('Health checks stopped');
    }
  }

  // Get provider with fallback
  async getWithFallback<T extends Provider>(
    type: ProviderType,
    preferredName?: string
  ): Promise<T | null> {
    const typeMap = this.providers.get(type);
    if (!typeMap) return null;

    // Try preferred provider first
    if (preferredName) {
      const preferred = typeMap.get(preferredName);
      if (preferred && preferred.enabled) {
        const health = this.healthStatus.get(`${type}:${preferredName}`);
        if (!health || health.healthy) {
          return preferred.provider as T;
        }
      }
    }

    // Fall back to healthy providers by priority
    const sorted = Array.from(typeMap.values())
      .filter(p => p.enabled)
      .sort((a, b) => {
        // Prefer default
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        // Then by priority
        return a.priority - b.priority;
      });

    for (const registered of sorted) {
      const health = this.healthStatus.get(`${type}:${registered.name}`);
      if (!health || health.healthy) {
        return registered.provider as T;
      }
    }

    // Last resort: return first available even if unhealthy
    return sorted.length > 0 ? (sorted[0].provider as T) : null;
  }

  // Clear all providers (for testing)
  clear(): void {
    for (const typeMap of this.providers.values()) {
      typeMap.clear();
    }
    this.healthStatus.clear();
    this.stopHealthChecks();
  }
}

// Singleton instance
export const registry = new ModuleRegistry();

// Helper to get typed providers
export const providers = {
  paymentGateway: (name?: string) =>
    name
      ? registry.get<PaymentGatewayProvider>('payment_gateway', name)
      : registry.getDefault<PaymentGatewayProvider>('payment_gateway'),

  crypto: (name?: string) =>
    name
      ? registry.get<CryptoPaymentProvider>('crypto', name)
      : registry.getDefault<CryptoPaymentProvider>('crypto'),

  tax: (name?: string) =>
    name
      ? registry.get<TaxProvider>('tax', name)
      : registry.getDefault<TaxProvider>('tax'),

  fraud: (name?: string) =>
    name
      ? registry.get<FraudProvider>('fraud', name)
      : registry.getDefault<FraudProvider>('fraud'),

  notification: (name?: string) =>
    name
      ? registry.get<NotificationProvider>('notification', name)
      : registry.getDefault<NotificationProvider>('notification'),

  storage: (name?: string) =>
    name
      ? registry.get<StorageProvider>('storage', name)
      : registry.getDefault<StorageProvider>('storage'),

  payout: (name?: string) =>
    name
      ? registry.get<PayoutProvider>('payout', name)
      : registry.getDefault<PayoutProvider>('payout'),
};
