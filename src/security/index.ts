// Security module exports
export * from './encryption.service';
export * from './three-d-secure.service';
export * from './privacy.service';
export * from './audit.service';
export * from './waf.middleware';
export * from './financial-compliance.service';

// Re-export commonly used items
import { encryptionService, dataMasking } from './encryption.service';
import { threeDSecureService } from './three-d-secure.service';
import { privacyService } from './privacy.service';
import { auditService } from './audit.service';
import { financialComplianceService } from './financial-compliance.service';
import {
  wafMiddleware,
  apiRateLimit,
  authRateLimit,
  securityHeadersMiddleware,
  requestIdMiddleware,
} from './waf.middleware';

// Initialize security services
export async function initializeSecurity(): Promise<void> {
  await encryptionService.initialize();

  // Start periodic key rotation check
  setInterval(async () => {
    await encryptionService.checkKeyRotation();
  }, 24 * 60 * 60 * 1000); // Daily

  // Start periodic retention policy application
  setInterval(async () => {
    await privacyService.applyRetentionPolicies();
  }, 24 * 60 * 60 * 1000); // Daily

  const { logger } = await import('../utils/logger');
  logger.info('Security services initialized');
}

// Shutdown security services
export async function shutdownSecurity(): Promise<void> {
  await auditService.flush();
  auditService.stop();

  const { logger } = await import('../utils/logger');
  logger.info('Security services shut down');
}

export {
  encryptionService,
  dataMasking,
  threeDSecureService,
  privacyService,
  auditService,
  financialComplianceService,
  wafMiddleware,
  apiRateLimit,
  authRateLimit,
  securityHeadersMiddleware,
  requestIdMiddleware,
};
