import CryptoJS from 'crypto-js';
import { config } from '../config';
import crypto from 'crypto';

const ENCRYPTION_KEY = config.encryptionKey;

export function encrypt(text: string): string {
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

export function decrypt(ciphertext: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function hashApiKey(apiKey: string): string {
  return CryptoJS.SHA256(apiKey).toString();
}

export function generateApiKey(): string {
  const prefix = 'sk_live_';
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `${prefix}${randomBytes}`;
}

export function generateSecretKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateWebhookSignature(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = CryptoJS.HmacSHA256(signedPayload, secret).toString();
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  tolerance: number = 300
): boolean {
  const parts = signature.split(',');
  const timestamp = parseInt(parts[0]?.split('=')[1] || '0');
  const expectedSig = parts[1]?.split('=')[1];

  if (!timestamp || !expectedSig) {
    return false;
  }

  // Check timestamp tolerance (default 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    return false;
  }

  const signedPayload = `${timestamp}.${payload}`;
  const computedSig = CryptoJS.HmacSHA256(signedPayload, secret).toString();

  return computedSig === expectedSig;
}

export function maskSensitiveData(data: string, visibleChars: number = 4): string {
  if (data.length <= visibleChars) {
    return '*'.repeat(data.length);
  }
  return '*'.repeat(data.length - visibleChars) + data.slice(-visibleChars);
}
