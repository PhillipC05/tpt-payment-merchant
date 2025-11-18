// Provider Adapter Interfaces
// These define contracts that all providers must implement

import {
  Transaction, CryptoPayment, TaxCalculation, TaxCalculationInput,
  CryptoCurrency, CryptoNetwork
} from '../../types';

// ==================== PAYMENT GATEWAY PROVIDERS ====================

export interface PaymentGatewayProvider {
  name: string;
  supportedMethods: string[];

  initialize(config: Record<string, any>): Promise<void>;

  charge(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    metadata?: Record<string, any>;
    idempotencyKey?: string;
  }): Promise<GatewayChargeResult>;

  refund(params: {
    chargeId: string;
    amount?: number;
    reason?: string;
  }): Promise<GatewayRefundResult>;

  createPaymentMethod(customerId: string, token: string): Promise<GatewayPaymentMethod>;

  getBalance?(): Promise<GatewayBalance>;
}

export interface GatewayChargeResult {
  id: string;
  status: 'succeeded' | 'pending' | 'failed';
  amount: number;
  currency: string;
  failureCode?: string;
  failureMessage?: string;
  rawResponse: any;
}

export interface GatewayRefundResult {
  id: string;
  status: 'succeeded' | 'pending' | 'failed';
  amount: number;
  chargeId: string;
  rawResponse: any;
}

export interface GatewayPaymentMethod {
  id: string;
  type: string;
  details: Record<string, any>;
}

export interface GatewayBalance {
  available: { amount: number; currency: string }[];
  pending: { amount: number; currency: string }[];
}

// ==================== CRYPTO PROVIDERS ====================

export interface CryptoProvider {
  name: string;
  supportedNetworks: CryptoNetwork[];
  supportedCurrencies: CryptoCurrency[];

  initialize(config: Record<string, any>): Promise<void>;

  getExchangeRate(crypto: CryptoCurrency, fiat: string): Promise<number>;

  generateAddress(network: CryptoNetwork, currency: CryptoCurrency): Promise<string>;

  getTransaction(txHash: string, network: CryptoNetwork): Promise<{
    confirmations: number;
    amount: string;
    status: 'pending' | 'confirmed' | 'failed';
  }>;

  validateAddress(address: string, network: CryptoNetwork): boolean;
}

// ==================== TAX PROVIDERS ====================

export interface TaxProvider {
  name: string;
  supportedCountries: string[];

  initialize(config: Record<string, any>): Promise<void>;

  calculateTax(input: TaxCalculationInput): Promise<TaxCalculation>;

  validateTaxId(country: string, taxId: string): Promise<boolean>;

  getJurisdictionRates(country: string, state?: string): Promise<{
    jurisdiction: string;
    rate: number;
    type: string;
  }[]>;
}

// ==================== FRAUD PROVIDERS ====================

export interface FraudProvider {
  name: string;

  initialize(config: Record<string, any>): Promise<void>;

  analyzeTransaction(data: {
    amount: number;
    currency: string;
    customerEmail?: string;
    customerIp?: string;
    cardFingerprint?: string;
    billingAddress?: Record<string, any>;
    metadata?: Record<string, any>;
  }): Promise<{
    riskScore: number;
    signals: { type: string; message: string; score: number }[];
    recommendation: 'allow' | 'review' | 'block';
  }>;
}

// ==================== NOTIFICATION PROVIDERS ====================

export interface NotificationProvider {
  name: string;
  channels: ('email' | 'sms' | 'push' | 'slack')[];

  initialize(config: Record<string, any>): Promise<void>;

  send(params: {
    channel: string;
    recipient: string;
    template: string;
    data: Record<string, any>;
  }): Promise<{ id: string; status: string }>;
}

// ==================== STORAGE PROVIDERS ====================

export interface StorageProvider {
  name: string;

  initialize(config: Record<string, any>): Promise<void>;

  upload(params: {
    key: string;
    data: Buffer | string;
    contentType: string;
    metadata?: Record<string, any>;
  }): Promise<{ url: string; key: string }>;

  download(key: string): Promise<Buffer>;

  delete(key: string): Promise<void>;

  getSignedUrl(key: string, expiresIn: number): Promise<string>;
}

// ==================== PAYOUT PROVIDERS ====================

export interface PayoutProvider {
  name: string;
  supportedMethods: ('bank_transfer' | 'check' | 'crypto')[];

  initialize(config: Record<string, any>): Promise<void>;

  createPayout(params: {
    amount: number;
    currency: string;
    destination: Record<string, any>;
    metadata?: Record<string, any>;
  }): Promise<{
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    estimatedArrival?: Date;
  }>;

  getPayoutStatus(payoutId: string): Promise<{
    status: string;
    failureReason?: string;
  }>;
}
