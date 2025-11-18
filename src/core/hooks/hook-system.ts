import { logger } from '../../utils/logger';

// Hook points in the payment lifecycle
export type HookPoint =
  // Transaction hooks
  | 'pre:transaction.create'
  | 'post:transaction.create'
  | 'pre:transaction.capture'
  | 'post:transaction.capture'
  | 'pre:transaction.refund'
  | 'post:transaction.refund'
  // Subscription hooks
  | 'pre:subscription.create'
  | 'post:subscription.create'
  | 'pre:subscription.renew'
  | 'post:subscription.renew'
  | 'pre:subscription.cancel'
  | 'post:subscription.cancel'
  // Customer hooks
  | 'pre:customer.create'
  | 'post:customer.create'
  | 'pre:payment_method.add'
  | 'post:payment_method.add'
  // Payout hooks
  | 'pre:payout.create'
  | 'post:payout.create'
  // Fraud hooks
  | 'pre:fraud.check'
  | 'post:fraud.check'
  // Invoice hooks
  | 'pre:invoice.create'
  | 'post:invoice.create'
  | 'pre:invoice.send'
  | 'post:invoice.send';

export interface HookContext {
  merchantId: string;
  hookPoint: HookPoint;
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface HookResult {
  modified?: boolean;
  data?: Record<string, any>;
  abort?: boolean;
  abortReason?: string;
}

export type HookHandler = (context: HookContext) => Promise<HookResult | void>;

interface RegisteredHook {
  id: string;
  merchantId: string | '*'; // '*' for global hooks
  handler: HookHandler;
  priority: number;
  enabled: boolean;
  name?: string;
  description?: string;
}

class HookSystem {
  private hooks: Map<HookPoint, RegisteredHook[]> = new Map();

  // Register a hook handler
  register(
    hookPoint: HookPoint,
    handler: HookHandler,
    options: {
      merchantId?: string;
      priority?: number;
      name?: string;
      description?: string;
    } = {}
  ): string {
    const hookId = `hook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const registeredHook: RegisteredHook = {
      id: hookId,
      merchantId: options.merchantId || '*',
      handler,
      priority: options.priority || 100,
      enabled: true,
      name: options.name,
      description: options.description,
    };

    if (!this.hooks.has(hookPoint)) {
      this.hooks.set(hookPoint, []);
    }

    const hooks = this.hooks.get(hookPoint)!;
    hooks.push(registeredHook);

    // Sort by priority (lower number = higher priority)
    hooks.sort((a, b) => a.priority - b.priority);

    logger.debug('Hook registered', { hookId, hookPoint, name: options.name });

    return hookId;
  }

  // Unregister a hook
  unregister(hookId: string): boolean {
    for (const [hookPoint, hooks] of this.hooks.entries()) {
      const index = hooks.findIndex(h => h.id === hookId);
      if (index !== -1) {
        hooks.splice(index, 1);
        logger.debug('Hook unregistered', { hookId, hookPoint });
        return true;
      }
    }
    return false;
  }

  // Enable/disable a hook
  setEnabled(hookId: string, enabled: boolean): boolean {
    for (const hooks of this.hooks.values()) {
      const hook = hooks.find(h => h.id === hookId);
      if (hook) {
        hook.enabled = enabled;
        return true;
      }
    }
    return false;
  }

  // Execute hooks for a hook point
  async execute(
    hookPoint: HookPoint,
    context: Omit<HookContext, 'hookPoint'>
  ): Promise<{ data: Record<string, any>; aborted: boolean; abortReason?: string }> {
    const hooks = this.hooks.get(hookPoint) || [];
    let currentData = { ...context.data };
    let aborted = false;
    let abortReason: string | undefined;

    const fullContext: HookContext = {
      ...context,
      hookPoint,
    };

    // Filter applicable hooks (global + merchant-specific)
    const applicableHooks = hooks.filter(
      h => h.enabled && (h.merchantId === '*' || h.merchantId === context.merchantId)
    );

    for (const hook of applicableHooks) {
      try {
        const result = await hook.handler({
          ...fullContext,
          data: currentData,
        });

        if (result) {
          // Update data if modified
          if (result.modified && result.data) {
            currentData = { ...currentData, ...result.data };
          }

          // Check for abort
          if (result.abort) {
            aborted = true;
            abortReason = result.abortReason || `Aborted by hook: ${hook.name || hook.id}`;
            logger.warn('Hook aborted execution', {
              hookPoint,
              hookId: hook.id,
              reason: abortReason,
            });
            break;
          }
        }
      } catch (error) {
        logger.error('Hook execution error', {
          hookPoint,
          hookId: hook.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Continue with other hooks despite error
      }
    }

    return { data: currentData, aborted, abortReason };
  }

  // List registered hooks
  list(hookPoint?: HookPoint): RegisteredHook[] {
    if (hookPoint) {
      return this.hooks.get(hookPoint) || [];
    }

    const allHooks: RegisteredHook[] = [];
    for (const hooks of this.hooks.values()) {
      allHooks.push(...hooks);
    }
    return allHooks;
  }

  // Clear all hooks (for testing)
  clear(): void {
    this.hooks.clear();
  }
}

// Singleton instance
export const hookSystem = new HookSystem();

// Decorator for easy hook registration
export function Hook(hookPoint: HookPoint, options?: { priority?: number; name?: string }) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    hookSystem.register(hookPoint, originalMethod.bind(target), {
      ...options,
      name: options?.name || `${target.constructor.name}.${propertyKey}`,
    });

    return descriptor;
  };
}
