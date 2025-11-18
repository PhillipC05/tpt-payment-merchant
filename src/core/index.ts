// Core system exports
export * from './providers';
export * from './events/event-bus';
export * from './hooks/hook-system';
export * from './features/feature-flags';
export * from './registry/module-registry';
export * from './modules/module-system';

// Re-export commonly used items
import { eventBus } from './events/event-bus';
import { hookSystem } from './hooks/hook-system';
import { featureFlags } from './features/feature-flags';
import { registry, providers } from './registry/module-registry';
import { moduleSystem } from './modules/module-system';

// Initialize core systems
export async function initializeCore(): Promise<void> {
  // Initialize feature flags
  await featureFlags.initialize();

  // Initialize all registered providers
  await registry.initializeAll();

  // Start health checks
  registry.startHealthChecks(60000);

  // Log initialization
  const { logger } = await import('../utils/logger');
  logger.info('Core systems initialized', {
    providers: registry.list().length,
    featureFlags: featureFlags.list().length,
  });
}

// Shutdown core systems
export async function shutdownCore(): Promise<void> {
  registry.stopHealthChecks();
  await eventBus.removeAllListeners();

  const { logger } = await import('../utils/logger');
  logger.info('Core systems shut down');
}

export { eventBus, hookSystem, featureFlags, registry, providers, moduleSystem };
