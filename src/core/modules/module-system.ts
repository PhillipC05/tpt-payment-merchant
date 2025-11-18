import { logger } from '../../utils/logger';
import { query } from '../../database/connection';
import { redisClient } from '../../config/redis';

// All available platform modules
export const PLATFORM_MODULES = {
  // Core (always enabled)
  CORE_PAYMENTS: 'core_payments',
  CORE_MERCHANTS: 'core_merchants',
  CORE_WEBHOOKS: 'core_webhooks',

  // Payment Extensions
  CRYPTO_PAYMENTS: 'crypto_payments',
  SUBSCRIPTIONS: 'subscriptions',
  INVOICING: 'invoicing',
  PAYMENT_LINKS: 'payment_links',

  // Lending & Financing
  MERCHANT_CASH_ADVANCE: 'merchant_cash_advance',
  REVENUE_FINANCING: 'revenue_financing',
  BNPL: 'buy_now_pay_later',
  INVOICE_FACTORING: 'invoice_factoring',

  // Banking-as-a-Service
  VIRTUAL_ACCOUNTS: 'virtual_accounts',
  MULTI_CURRENCY: 'multi_currency',
  YIELD_ACCOUNTS: 'yield_accounts',
  MERCHANT_CARDS: 'merchant_cards',

  // Card Issuing
  VIRTUAL_CARDS: 'virtual_cards',
  EXPENSE_CARDS: 'expense_cards',
  GIFT_CARDS: 'gift_cards',

  // Insurance & Protection
  CHARGEBACK_PROTECTION: 'chargeback_protection',
  FRAUD_GUARANTEE: 'fraud_guarantee',
  SHIPPING_INSURANCE: 'shipping_insurance',

  // Treasury & FX
  FX_HEDGING: 'fx_hedging',
  CROSS_BORDER: 'cross_border',
  CASH_POOLING: 'cash_pooling',

  // Disbursements
  MASS_PAYOUTS: 'mass_payouts',
  CONTRACTOR_PAYMENTS: 'contractor_payments',
  GLOBAL_PAYOUTS: 'global_payouts',

  // Escrow & Trust
  MARKETPLACE_ESCROW: 'marketplace_escrow',
  MILESTONE_PAYMENTS: 'milestone_payments',

  // Identity & Compliance
  KYC_VERIFICATION: 'kyc_verification',
  KYB_VERIFICATION: 'kyb_verification',
  AML_SCREENING: 'aml_screening',
  ONGOING_MONITORING: 'ongoing_monitoring',

  // Advanced Features
  FRAUD_DETECTION: 'fraud_detection',
  ADVANCED_ANALYTICS: 'advanced_analytics',
  MARKETPLACE_MODE: 'marketplace_mode',
  WHITE_LABEL: 'white_label',
} as const;

export type ModuleKey = typeof PLATFORM_MODULES[keyof typeof PLATFORM_MODULES];

// Module metadata
export interface ModuleDefinition {
  key: ModuleKey;
  name: string;
  description: string;
  category: ModuleCategory;
  dependencies?: ModuleKey[];
  pricing?: {
    type: 'free' | 'flat' | 'percentage' | 'tiered';
    amount?: number;
    percentage?: number;
  };
  requiredVerification?: ('kyc' | 'kyb' | 'bank_account')[];
  beta?: boolean;
}

export type ModuleCategory =
  | 'core'
  | 'payments'
  | 'lending'
  | 'banking'
  | 'cards'
  | 'insurance'
  | 'treasury'
  | 'disbursements'
  | 'escrow'
  | 'compliance'
  | 'advanced';

// Merchant module activation status
export interface MerchantModule {
  merchantId: string;
  moduleKey: ModuleKey;
  enabled: boolean;
  activatedAt?: Date;
  deactivatedAt?: Date;
  config?: Record<string, any>;
  usageThisMonth?: number;
  usageLimit?: number;
}

// Module definitions with metadata
const MODULE_DEFINITIONS: ModuleDefinition[] = [
  // Core modules (always enabled)
  {
    key: PLATFORM_MODULES.CORE_PAYMENTS,
    name: 'Core Payments',
    description: 'Basic payment processing',
    category: 'core',
    pricing: { type: 'percentage', percentage: 2.9 },
  },
  {
    key: PLATFORM_MODULES.CORE_MERCHANTS,
    name: 'Merchant Management',
    description: 'Merchant onboarding and management',
    category: 'core',
    pricing: { type: 'free' },
  },
  {
    key: PLATFORM_MODULES.CORE_WEBHOOKS,
    name: 'Webhooks',
    description: 'Event notifications',
    category: 'core',
    pricing: { type: 'free' },
  },

  // Payment extensions
  {
    key: PLATFORM_MODULES.CRYPTO_PAYMENTS,
    name: 'Cryptocurrency Payments',
    description: 'Accept Bitcoin, Ethereum, and stablecoins',
    category: 'payments',
    pricing: { type: 'percentage', percentage: 1.0 },
    beta: true,
  },
  {
    key: PLATFORM_MODULES.SUBSCRIPTIONS,
    name: 'Subscriptions & Recurring',
    description: 'Recurring billing and subscription management',
    category: 'payments',
    pricing: { type: 'percentage', percentage: 0.5 },
  },
  {
    key: PLATFORM_MODULES.INVOICING,
    name: 'Invoicing',
    description: 'Create and send invoices',
    category: 'payments',
    pricing: { type: 'free' },
  },
  {
    key: PLATFORM_MODULES.PAYMENT_LINKS,
    name: 'Payment Links',
    description: 'Shareable payment pages',
    category: 'payments',
    pricing: { type: 'free' },
  },

  // Lending & Financing
  {
    key: PLATFORM_MODULES.MERCHANT_CASH_ADVANCE,
    name: 'Merchant Cash Advance',
    description: 'Working capital based on transaction history',
    category: 'lending',
    dependencies: [PLATFORM_MODULES.CORE_PAYMENTS],
    requiredVerification: ['kyb', 'bank_account'],
    pricing: { type: 'percentage', percentage: 0 }, // Revenue share model
  },
  {
    key: PLATFORM_MODULES.REVENUE_FINANCING,
    name: 'Revenue-Based Financing',
    description: 'Loans repaid as percentage of daily sales',
    category: 'lending',
    dependencies: [PLATFORM_MODULES.CORE_PAYMENTS],
    requiredVerification: ['kyb', 'bank_account'],
    pricing: { type: 'percentage', percentage: 0 },
  },
  {
    key: PLATFORM_MODULES.BNPL,
    name: 'Buy Now Pay Later',
    description: 'Installment payments for customers',
    category: 'lending',
    pricing: { type: 'percentage', percentage: 3.0 },
  },
  {
    key: PLATFORM_MODULES.INVOICE_FACTORING,
    name: 'Invoice Factoring',
    description: 'Advance payments on outstanding invoices',
    category: 'lending',
    dependencies: [PLATFORM_MODULES.INVOICING],
    requiredVerification: ['kyb'],
    pricing: { type: 'percentage', percentage: 2.0 },
  },

  // Banking-as-a-Service
  {
    key: PLATFORM_MODULES.VIRTUAL_ACCOUNTS,
    name: 'Virtual Accounts',
    description: 'Virtual IBANs and account numbers',
    category: 'banking',
    requiredVerification: ['kyb'],
    pricing: { type: 'flat', amount: 500 }, // $5/month per account
  },
  {
    key: PLATFORM_MODULES.MULTI_CURRENCY,
    name: 'Multi-Currency Accounts',
    description: 'Hold and manage foreign currencies',
    category: 'banking',
    pricing: { type: 'percentage', percentage: 0.5 },
  },
  {
    key: PLATFORM_MODULES.YIELD_ACCOUNTS,
    name: 'Yield Accounts',
    description: 'Earn interest on idle balances',
    category: 'banking',
    requiredVerification: ['kyb'],
    pricing: { type: 'free' }, // Platform takes spread
  },
  {
    key: PLATFORM_MODULES.MERCHANT_CARDS,
    name: 'Merchant Debit Cards',
    description: 'Spend directly from balance',
    category: 'banking',
    requiredVerification: ['kyb', 'kyc'],
    pricing: { type: 'flat', amount: 1000 }, // $10/card/month
  },

  // Card Issuing
  {
    key: PLATFORM_MODULES.VIRTUAL_CARDS,
    name: 'Virtual Cards',
    description: 'Issue virtual cards for online payments',
    category: 'cards',
    requiredVerification: ['kyb'],
    pricing: { type: 'flat', amount: 50 }, // $0.50 per card
  },
  {
    key: PLATFORM_MODULES.EXPENSE_CARDS,
    name: 'Expense Cards',
    description: 'Employee expense cards with controls',
    category: 'cards',
    requiredVerification: ['kyb'],
    pricing: { type: 'flat', amount: 300 }, // $3/card/month
  },
  {
    key: PLATFORM_MODULES.GIFT_CARDS,
    name: 'Gift Cards',
    description: 'Branded gift card programs',
    category: 'cards',
    pricing: { type: 'percentage', percentage: 2.0 },
  },

  // Insurance & Protection
  {
    key: PLATFORM_MODULES.CHARGEBACK_PROTECTION,
    name: 'Chargeback Protection',
    description: 'Insurance against chargebacks',
    category: 'insurance',
    pricing: { type: 'percentage', percentage: 0.4 },
  },
  {
    key: PLATFORM_MODULES.FRAUD_GUARANTEE,
    name: 'Fraud Guarantee',
    description: 'Coverage for approved fraudulent transactions',
    category: 'insurance',
    dependencies: [PLATFORM_MODULES.FRAUD_DETECTION],
    pricing: { type: 'percentage', percentage: 0.3 },
  },
  {
    key: PLATFORM_MODULES.SHIPPING_INSURANCE,
    name: 'Shipping Insurance',
    description: 'Package loss and damage protection',
    category: 'insurance',
    pricing: { type: 'percentage', percentage: 1.5 },
  },

  // Treasury & FX
  {
    key: PLATFORM_MODULES.FX_HEDGING,
    name: 'FX Hedging',
    description: 'Lock in exchange rates',
    category: 'treasury',
    dependencies: [PLATFORM_MODULES.MULTI_CURRENCY],
    pricing: { type: 'percentage', percentage: 0.2 },
  },
  {
    key: PLATFORM_MODULES.CROSS_BORDER,
    name: 'Cross-Border Optimization',
    description: 'Optimal payment routing',
    category: 'treasury',
    pricing: { type: 'percentage', percentage: 0.5 },
  },
  {
    key: PLATFORM_MODULES.CASH_POOLING,
    name: 'Cash Pooling',
    description: 'Consolidate balances across entities',
    category: 'treasury',
    requiredVerification: ['kyb'],
    pricing: { type: 'flat', amount: 10000 }, // $100/month
  },

  // Disbursements
  {
    key: PLATFORM_MODULES.MASS_PAYOUTS,
    name: 'Mass Payouts',
    description: 'Batch payments to multiple recipients',
    category: 'disbursements',
    pricing: { type: 'flat', amount: 25 }, // $0.25 per payout
  },
  {
    key: PLATFORM_MODULES.CONTRACTOR_PAYMENTS,
    name: 'Contractor Payments',
    description: '1099 payments with tax forms',
    category: 'disbursements',
    requiredVerification: ['kyb'],
    pricing: { type: 'flat', amount: 100 }, // $1 per payment
  },
  {
    key: PLATFORM_MODULES.GLOBAL_PAYOUTS,
    name: 'Global Payouts',
    description: 'Send to 100+ countries',
    category: 'disbursements',
    pricing: { type: 'flat', amount: 300 }, // $3 per payout
  },

  // Escrow & Trust
  {
    key: PLATFORM_MODULES.MARKETPLACE_ESCROW,
    name: 'Marketplace Escrow',
    description: 'Hold funds until delivery confirmed',
    category: 'escrow',
    pricing: { type: 'percentage', percentage: 1.0 },
  },
  {
    key: PLATFORM_MODULES.MILESTONE_PAYMENTS,
    name: 'Milestone Payments',
    description: 'Release funds on project completion',
    category: 'escrow',
    pricing: { type: 'percentage', percentage: 0.5 },
  },

  // Identity & Compliance
  {
    key: PLATFORM_MODULES.KYC_VERIFICATION,
    name: 'KYC Verification',
    description: 'Customer identity verification',
    category: 'compliance',
    pricing: { type: 'flat', amount: 150 }, // $1.50 per check
  },
  {
    key: PLATFORM_MODULES.KYB_VERIFICATION,
    name: 'KYB Verification',
    description: 'Business verification',
    category: 'compliance',
    pricing: { type: 'flat', amount: 500 }, // $5 per check
  },
  {
    key: PLATFORM_MODULES.AML_SCREENING,
    name: 'AML Screening',
    description: 'Sanctions and watchlist monitoring',
    category: 'compliance',
    pricing: { type: 'flat', amount: 50 }, // $0.50 per check
  },
  {
    key: PLATFORM_MODULES.ONGOING_MONITORING,
    name: 'Ongoing Monitoring',
    description: 'Continuous compliance monitoring',
    category: 'compliance',
    dependencies: [PLATFORM_MODULES.KYC_VERIFICATION],
    pricing: { type: 'flat', amount: 100 }, // $1/user/month
  },

  // Advanced Features
  {
    key: PLATFORM_MODULES.FRAUD_DETECTION,
    name: 'Fraud Detection',
    description: 'AI-powered fraud prevention',
    category: 'advanced',
    pricing: { type: 'percentage', percentage: 0.1 },
  },
  {
    key: PLATFORM_MODULES.ADVANCED_ANALYTICS,
    name: 'Advanced Analytics',
    description: 'Business intelligence and insights',
    category: 'advanced',
    pricing: { type: 'flat', amount: 5000 }, // $50/month
  },
  {
    key: PLATFORM_MODULES.MARKETPLACE_MODE,
    name: 'Marketplace Mode',
    description: 'Multi-vendor platform features',
    category: 'advanced',
    pricing: { type: 'percentage', percentage: 0.25 },
  },
  {
    key: PLATFORM_MODULES.WHITE_LABEL,
    name: 'White Label',
    description: 'Custom branding and domains',
    category: 'advanced',
    pricing: { type: 'flat', amount: 50000 }, // $500/month
  },
];

class ModuleSystem {
  private merchantModules: Map<string, Map<ModuleKey, MerchantModule>> = new Map();
  private cachePrefix = 'merchant_modules:';
  private cacheTTL = 300;

  // Get module definition
  getDefinition(key: ModuleKey): ModuleDefinition | undefined {
    return MODULE_DEFINITIONS.find(m => m.key === key);
  }

  // Get all module definitions
  getAllDefinitions(): ModuleDefinition[] {
    return MODULE_DEFINITIONS;
  }

  // Get definitions by category
  getByCategory(category: ModuleCategory): ModuleDefinition[] {
    return MODULE_DEFINITIONS.filter(m => m.category === category);
  }

  // Check if a module is enabled for a merchant
  async isEnabled(merchantId: string, moduleKey: ModuleKey): Promise<boolean> {
    // Core modules are always enabled
    const definition = this.getDefinition(moduleKey);
    if (definition?.category === 'core') {
      return true;
    }

    // Check cache first
    const cached = this.merchantModules.get(merchantId)?.get(moduleKey);
    if (cached !== undefined) {
      return cached.enabled;
    }

    // Check database
    try {
      const result = await query<any>(
        `SELECT * FROM merchant_modules WHERE merchant_id = $1 AND module_key = $2`,
        [merchantId, moduleKey]
      );

      if (result.rows.length > 0) {
        const module = this.mapMerchantModule(result.rows[0]);
        this.cacheModule(merchantId, module);
        return module.enabled;
      }
    } catch (error) {
      logger.warn('Failed to check module status', { merchantId, moduleKey, error });
    }

    return false;
  }

  // Activate a module for a merchant
  async activate(
    merchantId: string,
    moduleKey: ModuleKey,
    config?: Record<string, any>
  ): Promise<{ success: boolean; error?: string }> {
    const definition = this.getDefinition(moduleKey);
    if (!definition) {
      return { success: false, error: 'Module not found' };
    }

    // Check dependencies
    if (definition.dependencies) {
      for (const dep of definition.dependencies) {
        const depEnabled = await this.isEnabled(merchantId, dep);
        if (!depEnabled) {
          const depDef = this.getDefinition(dep);
          return {
            success: false,
            error: `Required module "${depDef?.name || dep}" must be activated first`,
          };
        }
      }
    }

    // Check verification requirements
    if (definition.requiredVerification) {
      const verificationStatus = await this.getMerchantVerification(merchantId);
      for (const req of definition.requiredVerification) {
        if (!verificationStatus[req]) {
          return {
            success: false,
            error: `${req.toUpperCase()} verification required to activate this module`,
          };
        }
      }
    }

    // Activate the module
    try {
      await query(
        `INSERT INTO merchant_modules (merchant_id, module_key, enabled, config, activated_at)
         VALUES ($1, $2, true, $3, NOW())
         ON CONFLICT (merchant_id, module_key)
         DO UPDATE SET enabled = true, config = $3, activated_at = NOW(), deactivated_at = NULL`,
        [merchantId, moduleKey, JSON.stringify(config || {})]
      );

      const module: MerchantModule = {
        merchantId,
        moduleKey,
        enabled: true,
        activatedAt: new Date(),
        config,
      };

      this.cacheModule(merchantId, module);

      logger.info('Module activated', { merchantId, moduleKey });
      return { success: true };
    } catch (error) {
      logger.error('Failed to activate module', { merchantId, moduleKey, error });
      return { success: false, error: 'Failed to activate module' };
    }
  }

  // Deactivate a module for a merchant
  async deactivate(
    merchantId: string,
    moduleKey: ModuleKey
  ): Promise<{ success: boolean; error?: string }> {
    const definition = this.getDefinition(moduleKey);
    if (!definition) {
      return { success: false, error: 'Module not found' };
    }

    // Core modules cannot be deactivated
    if (definition.category === 'core') {
      return { success: false, error: 'Core modules cannot be deactivated' };
    }

    // Check if other modules depend on this one
    const dependentModules = MODULE_DEFINITIONS.filter(
      m => m.dependencies?.includes(moduleKey)
    );

    for (const dep of dependentModules) {
      const isEnabled = await this.isEnabled(merchantId, dep.key);
      if (isEnabled) {
        return {
          success: false,
          error: `Cannot deactivate: "${dep.name}" depends on this module`,
        };
      }
    }

    try {
      await query(
        `UPDATE merchant_modules
         SET enabled = false, deactivated_at = NOW()
         WHERE merchant_id = $1 AND module_key = $2`,
        [merchantId, moduleKey]
      );

      // Update cache
      const cached = this.merchantModules.get(merchantId)?.get(moduleKey);
      if (cached) {
        cached.enabled = false;
        cached.deactivatedAt = new Date();
      }

      logger.info('Module deactivated', { merchantId, moduleKey });
      return { success: true };
    } catch (error) {
      logger.error('Failed to deactivate module', { merchantId, moduleKey, error });
      return { success: false, error: 'Failed to deactivate module' };
    }
  }

  // Get all active modules for a merchant
  async getActiveModules(merchantId: string): Promise<MerchantModule[]> {
    try {
      const result = await query<any>(
        `SELECT * FROM merchant_modules WHERE merchant_id = $1 AND enabled = true`,
        [merchantId]
      );

      const modules = result.rows.map(row => this.mapMerchantModule(row));

      // Add core modules
      const coreModules = MODULE_DEFINITIONS.filter(m => m.category === 'core').map(m => ({
        merchantId,
        moduleKey: m.key,
        enabled: true,
      }));

      return [...coreModules, ...modules];
    } catch (error) {
      logger.error('Failed to get active modules', { merchantId, error });
      return [];
    }
  }

  // Get module configuration
  async getConfig(merchantId: string, moduleKey: ModuleKey): Promise<Record<string, any> | null> {
    try {
      const result = await query<any>(
        `SELECT config FROM merchant_modules WHERE merchant_id = $1 AND module_key = $2`,
        [merchantId, moduleKey]
      );

      if (result.rows.length > 0) {
        return result.rows[0].config || {};
      }
    } catch (error) {
      logger.warn('Failed to get module config', { merchantId, moduleKey, error });
    }

    return null;
  }

  // Update module configuration
  async updateConfig(
    merchantId: string,
    moduleKey: ModuleKey,
    config: Record<string, any>
  ): Promise<boolean> {
    try {
      await query(
        `UPDATE merchant_modules SET config = $3 WHERE merchant_id = $1 AND module_key = $2`,
        [merchantId, moduleKey, JSON.stringify(config)]
      );

      // Update cache
      const cached = this.merchantModules.get(merchantId)?.get(moduleKey);
      if (cached) {
        cached.config = config;
      }

      return true;
    } catch (error) {
      logger.error('Failed to update module config', { merchantId, moduleKey, error });
      return false;
    }
  }

  // Track module usage
  async trackUsage(merchantId: string, moduleKey: ModuleKey, amount: number = 1): Promise<void> {
    try {
      await query(
        `UPDATE merchant_modules
         SET usage_this_month = COALESCE(usage_this_month, 0) + $3
         WHERE merchant_id = $1 AND module_key = $2`,
        [merchantId, moduleKey, amount]
      );
    } catch (error) {
      logger.warn('Failed to track module usage', { merchantId, moduleKey, error });
    }
  }

  // Calculate module fees for a merchant
  async calculateFees(
    merchantId: string,
    moduleKey: ModuleKey,
    amount: number
  ): Promise<number> {
    const definition = this.getDefinition(moduleKey);
    if (!definition?.pricing) return 0;

    switch (definition.pricing.type) {
      case 'free':
        return 0;
      case 'flat':
        return definition.pricing.amount || 0;
      case 'percentage':
        return Math.round(amount * (definition.pricing.percentage || 0) / 100);
      default:
        return 0;
    }
  }

  // Get merchant verification status (placeholder - would check actual verification records)
  private async getMerchantVerification(
    merchantId: string
  ): Promise<Record<string, boolean>> {
    try {
      const result = await query<any>(
        `SELECT kyc_verified, kyb_verified, bank_account_verified
         FROM merchants WHERE id = $1`,
        [merchantId]
      );

      if (result.rows.length > 0) {
        return {
          kyc: result.rows[0].kyc_verified || false,
          kyb: result.rows[0].kyb_verified || false,
          bank_account: result.rows[0].bank_account_verified || false,
        };
      }
    } catch (error) {
      logger.warn('Failed to get merchant verification', { merchantId, error });
    }

    return { kyc: false, kyb: false, bank_account: false };
  }

  // Cache helpers
  private cacheModule(merchantId: string, module: MerchantModule): void {
    if (!this.merchantModules.has(merchantId)) {
      this.merchantModules.set(merchantId, new Map());
    }
    this.merchantModules.get(merchantId)!.set(module.moduleKey, module);
  }

  private mapMerchantModule(row: any): MerchantModule {
    return {
      merchantId: row.merchant_id,
      moduleKey: row.module_key,
      enabled: row.enabled,
      activatedAt: row.activated_at,
      deactivatedAt: row.deactivated_at,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      usageThisMonth: row.usage_this_month,
      usageLimit: row.usage_limit,
    };
  }

  // Clear cache for a merchant
  clearCache(merchantId: string): void {
    this.merchantModules.delete(merchantId);
  }
}

// Singleton instance
export const moduleSystem = new ModuleSystem();

// Middleware to check module access
export function requireModule(moduleKey: ModuleKey) {
  return async (req: any, res: any, next: any) => {
    const merchantId = req.merchantId;
    if (!merchantId) {
      return res.status(401).json({ error: 'Merchant ID required' });
    }

    const isEnabled = await moduleSystem.isEnabled(merchantId, moduleKey);
    if (!isEnabled) {
      const definition = moduleSystem.getDefinition(moduleKey);
      return res.status(403).json({
        error: 'Module not enabled',
        message: `The "${definition?.name || moduleKey}" module is not activated for your account`,
        module: moduleKey,
      });
    }

    // Track usage
    await moduleSystem.trackUsage(merchantId, moduleKey);

    next();
  };
}

// Decorator for module-gated methods
export function RequireModule(moduleKey: ModuleKey) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      let merchantId: string | undefined;
      if (args[0] && typeof args[0] === 'object' && 'merchantId' in args[0]) {
        merchantId = args[0].merchantId;
      } else if (typeof args[0] === 'string') {
        merchantId = args[0];
      }

      if (!merchantId) {
        throw new Error('Merchant ID required');
      }

      const isEnabled = await moduleSystem.isEnabled(merchantId, moduleKey);
      if (!isEnabled) {
        const definition = moduleSystem.getDefinition(moduleKey);
        throw new Error(`Module "${definition?.name || moduleKey}" is not enabled`);
      }

      await moduleSystem.trackUsage(merchantId, moduleKey);
      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}
