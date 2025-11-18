// Core Types for Payment Platform

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Merchant Types
export type MerchantStatus = 'pending' | 'active' | 'suspended' | 'terminated';

export interface Merchant {
  id: string;
  name: string;
  email: string;
  businessName: string;
  businessType: string;
  taxId?: string;
  status: MerchantStatus;
  apiKeyHash: string;
  webhookUrl?: string;
  webhookSecret?: string;
  settings: MerchantSettings;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface MerchantSettings {
  defaultCurrency: string;
  supportedCurrencies: string[];
  payoutSchedule: 'daily' | 'weekly' | 'monthly';
  minimumPayoutAmount: number;
  feePercentage: number;
  flatFee: number;
  chargebackFee: number;
  refundPolicy: 'full' | 'partial' | 'none';
  autoCapture: boolean;
  statementDescriptor?: string;
}

export interface CreateMerchantInput {
  name: string;
  email: string;
  password: string;
  businessName: string;
  businessType: string;
  taxId?: string;
  settings?: Partial<MerchantSettings>;
}

// Customer Types
export interface Customer {
  id: string;
  merchantId: string;
  email: string;
  name?: string;
  phone?: string;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

// Payment Method Types
export type PaymentMethodType = 'card' | 'bank_transfer' | 'wallet' | 'crypto';

export interface PaymentMethod {
  id: string;
  customerId: string;
  type: PaymentMethodType;
  isDefault: boolean;
  details: CardDetails | BankDetails | WalletDetails;
  createdAt: Date;
  updatedAt: Date;
}

export interface CardDetails {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  fingerprint: string;
  tokenId: string;
}

export interface BankDetails {
  bankName: string;
  accountType: string;
  last4: string;
  routingNumber?: string;
}

export interface WalletDetails {
  walletType: string;
  email?: string;
}

// Transaction Types
export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'disputed';
export type TransactionType = 'charge' | 'refund' | 'payout' | 'fee' | 'adjustment';

export interface Transaction {
  id: string;
  merchantId: string;
  customerId?: string;
  paymentMethodId?: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: number;
  currency: string;
  fee: number;
  netAmount: number;
  description?: string;
  statementDescriptor?: string;
  metadata: Record<string, any>;
  gatewayReference?: string;
  gatewayResponse?: Record<string, any>;
  errorCode?: string;
  errorMessage?: string;
  refundedAmount: number;
  capturedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateChargeInput {
  amount: number;
  currency: string;
  customerId?: string;
  paymentMethodId?: string;
  description?: string;
  statementDescriptor?: string;
  metadata?: Record<string, any>;
  capture?: boolean;
  idempotencyKey?: string;
}

export interface RefundInput {
  transactionId: string;
  amount?: number;
  reason?: string;
  metadata?: Record<string, any>;
}

// Payout Types
export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Payout {
  id: string;
  merchantId: string;
  status: PayoutStatus;
  amount: number;
  currency: string;
  fee: number;
  netAmount: number;
  bankAccountId?: string;
  transactionIds: string[];
  periodStart: Date;
  periodEnd: Date;
  arrivedAt?: Date;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Webhook Types
export type WebhookEventType =
  | 'transaction.created'
  | 'transaction.completed'
  | 'transaction.failed'
  | 'transaction.refunded'
  | 'transaction.disputed'
  | 'payout.created'
  | 'payout.completed'
  | 'payout.failed'
  | 'merchant.updated'
  | 'customer.created';

export type WebhookStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookEvent {
  id: string;
  merchantId: string;
  type: WebhookEventType;
  status: WebhookStatus;
  payload: Record<string, any>;
  attempts: number;
  lastAttemptAt?: Date;
  deliveredAt?: Date;
  nextRetryAt?: Date;
  response?: string;
  createdAt: Date;
}

// Tax Types
export interface TaxCalculation {
  subtotal: number;
  taxAmount: number;
  total: number;
  breakdown: TaxBreakdown[];
}

export interface TaxBreakdown {
  jurisdiction: string;
  taxType: string;
  rate: number;
  amount: number;
}

export interface TaxCalculationInput {
  amount: number;
  currency: string;
  customerAddress: Address;
  merchantAddress?: Address;
  productType?: string;
}

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country: string;
}

// API Key Types
export interface ApiKey {
  id: string;
  merchantId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  permissions: string[];
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
}

// Dispute Types
export type DisputeStatus = 'open' | 'under_review' | 'won' | 'lost';
export type DisputeReason = 'duplicate' | 'fraudulent' | 'subscription_canceled' | 'product_not_received' | 'product_unacceptable' | 'unrecognized' | 'credit_not_processed' | 'general';

export interface Dispute {
  id: string;
  transactionId: string;
  merchantId: string;
  status: DisputeStatus;
  reason: DisputeReason;
  amount: number;
  currency: string;
  evidence?: DisputeEvidence;
  dueBy: Date;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DisputeEvidence {
  customerName?: string;
  customerEmail?: string;
  productDescription?: string;
  shippingDocumentation?: string;
  uncategorizedText?: string;
}

// Balance Types
export interface Balance {
  merchantId: string;
  available: BalanceAmount[];
  pending: BalanceAmount[];
}

export interface BalanceAmount {
  currency: string;
  amount: number;
}

// Report Types
export interface ReportParams {
  merchantId: string;
  startDate: Date;
  endDate: Date;
  groupBy?: 'day' | 'week' | 'month';
  currency?: string;
}

export interface TransactionReport {
  period: string;
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  totalVolume: number;
  totalFees: number;
  netVolume: number;
  averageTransactionSize: number;
  refundRate: number;
}

// Auth Types
export interface AuthTokenPayload {
  merchantId: string;
  email: string;
  type: 'access' | 'refresh';
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Request Context
export interface RequestContext {
  merchantId?: string;
  apiKeyId?: string;
  requestId: string;
  ip: string;
  userAgent?: string;
}
