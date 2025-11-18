import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redisClient } from '../../config/redis';

// Encryption algorithms
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

// Key types for different data classifications
export type KeyType =
  | 'card_data'      // PAN, CVV (highest security)
  | 'pii'            // Personal identifiable information
  | 'sensitive'      // Bank accounts, tax IDs
  | 'general';       // General encryption

// Key metadata
interface EncryptionKey {
  id: string;
  type: KeyType;
  key: Buffer;
  version: number;
  createdAt: Date;
  expiresAt: Date;
  rotatedAt?: Date;
  isActive: boolean;
}

// Encrypted data envelope
export interface EncryptedEnvelope {
  version: number;
  keyId: string;
  algorithm: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
}

class KeyManagementService {
  private keys: Map<string, EncryptionKey> = new Map();
  private activeKeys: Map<KeyType, string> = new Map();
  private masterKey: Buffer | null = null;

  async initialize(): Promise<void> {
    // In production, master key should come from HSM or KMS (AWS KMS, HashiCorp Vault)
    const masterKeyEnv = process.env.MASTER_ENCRYPTION_KEY;

    if (!masterKeyEnv) {
      // Generate a random master key for development
      this.masterKey = crypto.randomBytes(KEY_LENGTH);
      logger.warn('Using randomly generated master key - NOT FOR PRODUCTION');
    } else {
      this.masterKey = Buffer.from(masterKeyEnv, 'hex');
    }

    // Generate initial keys for each type
    const keyTypes: KeyType[] = ['card_data', 'pii', 'sensitive', 'general'];
    for (const type of keyTypes) {
      await this.generateKey(type);
    }

    logger.info('Key management service initialized', {
      keyCount: this.keys.size,
    });
  }

  // Generate a new encryption key
  async generateKey(type: KeyType, expiryDays: number = 90): Promise<string> {
    const keyId = `key_${type}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const key = crypto.randomBytes(KEY_LENGTH);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    // Encrypt the key with master key before storing
    const encryptedKey = this.encryptWithMasterKey(key);

    const encryptionKey: EncryptionKey = {
      id: keyId,
      type,
      key, // In memory only - never persisted in plain
      version: 1,
      createdAt: new Date(),
      expiresAt,
      isActive: true,
    };

    this.keys.set(keyId, encryptionKey);

    // Set as active key for this type
    const previousKeyId = this.activeKeys.get(type);
    this.activeKeys.set(type, keyId);

    // Store encrypted key reference in Redis for distributed systems
    await this.storeKeyMetadata(keyId, type, encryptedKey, expiresAt);

    logger.info('Encryption key generated', { keyId, type, expiresAt });

    return keyId;
  }

  // Rotate a key type
  async rotateKey(type: KeyType): Promise<string> {
    const oldKeyId = this.activeKeys.get(type);

    // Generate new key
    const newKeyId = await this.generateKey(type);

    // Mark old key as rotated (but keep for decryption)
    if (oldKeyId) {
      const oldKey = this.keys.get(oldKeyId);
      if (oldKey) {
        oldKey.rotatedAt = new Date();
        oldKey.isActive = false;
      }
    }

    logger.info('Key rotated', { type, oldKeyId, newKeyId });

    return newKeyId;
  }

  // Get active key for a type
  getActiveKey(type: KeyType): EncryptionKey | null {
    const keyId = this.activeKeys.get(type);
    if (!keyId) return null;
    return this.keys.get(keyId) || null;
  }

  // Get key by ID (for decryption)
  getKey(keyId: string): EncryptionKey | null {
    return this.keys.get(keyId) || null;
  }

  // Check if keys need rotation
  async checkKeyRotation(): Promise<void> {
    const rotationThresholdDays = 7;
    const now = new Date();

    for (const [keyId, key] of this.keys) {
      if (!key.isActive) continue;

      const daysUntilExpiry = Math.floor(
        (key.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysUntilExpiry <= rotationThresholdDays) {
        logger.warn('Key approaching expiration', { keyId, daysUntilExpiry });
        await this.rotateKey(key.type);
      }
    }
  }

  // Encrypt data with master key (for storing encryption keys)
  private encryptWithMasterKey(data: Buffer): string {
    if (!this.masterKey) throw new Error('Master key not initialized');

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(data),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  // Decrypt data with master key
  private decryptWithMasterKey(encryptedData: string): Buffer {
    if (!this.masterKey) throw new Error('Master key not initialized');

    const data = Buffer.from(encryptedData, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  }

  // Store key metadata in Redis
  private async storeKeyMetadata(
    keyId: string,
    type: KeyType,
    encryptedKey: string,
    expiresAt: Date
  ): Promise<void> {
    const metadata = {
      id: keyId,
      type,
      encryptedKey,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
    };

    await redisClient.set(
      `encryption_key:${keyId}`,
      JSON.stringify(metadata),
      'EX',
      Math.floor((expiresAt.getTime() - Date.now()) / 1000) + 86400 * 30 // Keep 30 days after expiry
    );
  }
}

// Encryption service
class EncryptionService {
  private keyManager: KeyManagementService;

  constructor() {
    this.keyManager = new KeyManagementService();
  }

  async initialize(): Promise<void> {
    await this.keyManager.initialize();
  }

  // Encrypt sensitive data
  async encrypt(plaintext: string, keyType: KeyType = 'general'): Promise<EncryptedEnvelope> {
    const key = this.keyManager.getActiveKey(keyType);
    if (!key) {
      throw new Error(`No active encryption key for type: ${keyType}`);
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      version: 1,
      keyId: key.id,
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      createdAt: new Date().toISOString(),
    };
  }

  // Decrypt data
  async decrypt(envelope: EncryptedEnvelope): Promise<string> {
    const key = this.keyManager.getKey(envelope.keyId);
    if (!key) {
      throw new Error(`Encryption key not found: ${envelope.keyId}`);
    }

    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key.key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  // Encrypt card data (PCI DSS compliant)
  async encryptCardData(cardNumber: string): Promise<EncryptedEnvelope> {
    // Validate card number format
    if (!/^\d{13,19}$/.test(cardNumber.replace(/\s/g, ''))) {
      throw new Error('Invalid card number format');
    }

    return this.encrypt(cardNumber, 'card_data');
  }

  // Encrypt PII
  async encryptPII(data: string): Promise<EncryptedEnvelope> {
    return this.encrypt(data, 'pii');
  }

  // Encrypt sensitive data (bank accounts, tax IDs)
  async encryptSensitive(data: string): Promise<EncryptedEnvelope> {
    return this.encrypt(data, 'sensitive');
  }

  // Hash sensitive data for lookups (one-way)
  hashForLookup(data: string, salt?: string): string {
    const actualSalt = salt || process.env.HASH_SALT || 'default-salt';
    return crypto
      .createHmac('sha256', actualSalt)
      .update(data.toLowerCase().trim())
      .digest('hex');
  }

  // Generate secure token
  generateToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  // Generate API key
  generateApiKey(): { key: string; hash: string } {
    const key = `pk_${this.generateToken(24)}`;
    const hash = this.hashForLookup(key);
    return { key, hash };
  }

  // Rotate keys
  async rotateKeys(keyType?: KeyType): Promise<void> {
    if (keyType) {
      await this.keyManager.rotateKey(keyType);
    } else {
      // Rotate all key types
      const types: KeyType[] = ['card_data', 'pii', 'sensitive', 'general'];
      for (const type of types) {
        await this.keyManager.rotateKey(type);
      }
    }
  }

  // Check and rotate expiring keys
  async checkKeyRotation(): Promise<void> {
    await this.keyManager.checkKeyRotation();
  }
}

// Data masking utilities
export const dataMasking = {
  // Mask card number (show last 4)
  maskCardNumber(cardNumber: string): string {
    const cleaned = cardNumber.replace(/\s/g, '');
    if (cleaned.length < 4) return '****';
    return '*'.repeat(cleaned.length - 4) + cleaned.slice(-4);
  },

  // Mask email
  maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***@***';
    const maskedLocal = local.length > 2
      ? local[0] + '*'.repeat(local.length - 2) + local.slice(-1)
      : '*'.repeat(local.length);
    return `${maskedLocal}@${domain}`;
  },

  // Mask phone number
  maskPhone(phone: string): string {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length < 4) return '****';
    return '*'.repeat(cleaned.length - 4) + cleaned.slice(-4);
  },

  // Mask SSN/Tax ID
  maskTaxId(taxId: string): string {
    const cleaned = taxId.replace(/\D/g, '');
    if (cleaned.length < 4) return '****';
    return '*'.repeat(cleaned.length - 4) + cleaned.slice(-4);
  },

  // Mask bank account
  maskBankAccount(accountNumber: string): string {
    if (accountNumber.length < 4) return '****';
    return '*'.repeat(accountNumber.length - 4) + accountNumber.slice(-4);
  },

  // Redact object fields
  redactObject<T extends Record<string, any>>(
    obj: T,
    fieldsToRedact: string[]
  ): T {
    const result = { ...obj };
    for (const field of fieldsToRedact) {
      if (field in result) {
        result[field] = '[REDACTED]';
      }
    }
    return result;
  },
};

// Singleton instance
export const encryptionService = new EncryptionService();
export const keyManagement = new KeyManagementService();
