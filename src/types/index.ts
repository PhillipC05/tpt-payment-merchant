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

// ==================== SUBSCRIPTION TYPES ====================

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'unpaid' | 'trialing' | 'paused';
export type BillingInterval = 'day' | 'week' | 'month' | 'year';

export interface Plan {
  id: string;
  merchantId: string;
  name: string;
  description?: string;
  amount: number;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  trialPeriodDays?: number;
  features: string[];
  metadata: Record<string, any>;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Subscription {
  id: string;
  merchantId: string;
  customerId: string;
  planId: string;
  status: SubscriptionStatus;
  quantity: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  trialStart?: Date;
  trialEnd?: Date;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubscriptionInput {
  customerId: string;
  planId: string;
  quantity?: number;
  trialDays?: number;
  metadata?: Record<string, any>;
  couponId?: string;
}

export interface Coupon {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  currency?: string;
  maxRedemptions?: number;
  timesRedeemed: number;
  expiresAt?: Date;
  active: boolean;
  createdAt: Date;
}

export interface UsageRecord {
  id: string;
  subscriptionId: string;
  quantity: number;
  timestamp: Date;
  action: 'increment' | 'set';
  metadata: Record<string, any>;
}

// ==================== CRYPTO PAYMENT TYPES ====================

export type CryptoNetwork = 'bitcoin' | 'ethereum' | 'polygon' | 'solana' | 'tron' | 'bsc';
export type CryptoCurrency = 'BTC' | 'ETH' | 'USDT' | 'USDC' | 'DAI' | 'BUSD';
export type CryptoPaymentStatus = 'pending' | 'confirming' | 'completed' | 'expired' | 'underpaid' | 'overpaid' | 'failed';

export interface CryptoPayment {
  id: string;
  merchantId: string;
  customerId?: string;
  transactionId: string;
  status: CryptoPaymentStatus;
  cryptocurrency: CryptoCurrency;
  network: CryptoNetwork;
  amount: number;
  cryptoAmount: string;
  exchangeRate: number;
  walletAddress: string;
  txHash?: string;
  confirmations: number;
  requiredConfirmations: number;
  expiresAt: Date;
  paidAt?: Date;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCryptoPaymentInput {
  amount: number;
  currency: string;
  cryptocurrency: CryptoCurrency;
  network?: CryptoNetwork;
  customerId?: string;
  description?: string;
  metadata?: Record<string, any>;
  expirationMinutes?: number;
}

export interface CryptoWallet {
  id: string;
  merchantId: string;
  network: CryptoNetwork;
  currency: CryptoCurrency;
  address: string;
  label?: string;
  isActive: boolean;
  createdAt: Date;
}

export interface CryptoExchangeRate {
  cryptocurrency: CryptoCurrency;
  fiatCurrency: string;
  rate: number;
  timestamp: Date;
}

// ==================== FRAUD PREVENTION TYPES ====================

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FraudAction = 'allow' | 'review' | 'block';

export interface FraudCheck {
  id: string;
  transactionId: string;
  merchantId: string;
  riskScore: number;
  riskLevel: RiskLevel;
  action: FraudAction;
  signals: FraudSignal[];
  metadata: Record<string, any>;
  createdAt: Date;
}

export interface FraudSignal {
  type: string;
  severity: RiskLevel;
  message: string;
  score: number;
}

export interface FraudRule {
  id: string;
  merchantId: string;
  name: string;
  description?: string;
  conditions: FraudCondition[];
  action: FraudAction;
  priority: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FraudCondition {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains' | 'regex';
  value: any;
}

export interface Blocklist {
  id: string;
  merchantId: string;
  type: 'email' | 'ip' | 'card_fingerprint' | 'country';
  value: string;
  reason?: string;
  expiresAt?: Date;
  createdAt: Date;
}

export interface VelocityCheck {
  key: string;
  count: number;
  windowMs: number;
  limit: number;
}

// ==================== INVOICE TYPES ====================

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface Invoice {
  id: string;
  merchantId: string;
  customerId: string;
  subscriptionId?: string;
  number: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  amountDue: number;
  lineItems: InvoiceLineItem[];
  dueDate?: Date;
  paidAt?: Date;
  voidedAt?: Date;
  notes?: string;
  footer?: string;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  taxRate?: number;
  metadata: Record<string, any>;
}

export interface CreateInvoiceInput {
  customerId: string;
  lineItems: Omit<InvoiceLineItem, 'id'>[];
  dueDate?: Date;
  notes?: string;
  footer?: string;
  metadata?: Record<string, any>;
  autoSend?: boolean;
}

// ==================== REPORTING TYPES ====================

export interface DashboardMetrics {
  totalRevenue: number;
  totalTransactions: number;
  successRate: number;
  averageTransactionValue: number;
  refundRate: number;
  chargebackRate: number;
  revenueByDay: { date: string; amount: number }[];
  transactionsByStatus: { status: string; count: number }[];
  topCustomers: { customerId: string; totalSpent: number }[];
  paymentMethodBreakdown: { method: string; count: number; volume: number }[];
}

export interface RevenueReport {
  period: string;
  grossRevenue: number;
  refunds: number;
  fees: number;
  netRevenue: number;
  transactionCount: number;
}

export interface CohortAnalysis {
  cohort: string;
  customers: number;
  retention: number[];
  ltv: number;
}

// ==================== ADDITIONAL PAYMENT METHODS ====================

export type ACHAccountType = 'checking' | 'savings';
export type ACHStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'returned';

export interface ACHPayment {
  id: string;
  merchantId: string;
  customerId: string;
  transactionId: string;
  status: ACHStatus;
  amount: number;
  currency: string;
  bankName: string;
  accountType: ACHAccountType;
  last4: string;
  routingNumber: string;
  returnCode?: string;
  returnReason?: string;
  settledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SEPAPayment {
  id: string;
  merchantId: string;
  customerId: string;
  transactionId: string;
  status: string;
  amount: number;
  currency: string;
  iban: string;
  bic?: string;
  mandateReference: string;
  mandateDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DigitalWalletPayment {
  walletType: 'apple_pay' | 'google_pay' | 'paypal';
  tokenId: string;
  email?: string;
}

// ==================== PAYMENT LINKS ====================

export interface PaymentLink {
  id: string;
  merchantId: string;
  url: string;
  amount?: number;
  currency: string;
  description?: string;
  active: boolean;
  expiresAt?: Date;
  maxRedemptions?: number;
  timesRedeemed: number;
  metadata: Record<string, any>;
  createdAt: Date;
}

export interface CreatePaymentLinkInput {
  amount?: number;
  currency: string;
  description?: string;
  expiresAt?: Date;
  maxRedemptions?: number;
  metadata?: Record<string, any>;
}

// ==================== MARKETPLACE / SPLIT PAYMENTS ====================

export interface ConnectedAccount {
  id: string;
  merchantId: string;
  email: string;
  businessName: string;
  status: 'pending' | 'active' | 'rejected';
  payoutSchedule: string;
  commissionRate: number;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentSplit {
  id: string;
  transactionId: string;
  splits: SplitDestination[];
  createdAt: Date;
}

export interface SplitDestination {
  accountId: string;
  amount: number;
  feeAmount: number;
  type: 'percentage' | 'fixed';
}

// ==================== EXTENDED WEBHOOK TYPES ====================

export type ExtendedWebhookEventType =
  | WebhookEventType
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'subscription.renewed'
  | 'invoice.created'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'crypto.payment.pending'
  | 'crypto.payment.completed'
  | 'crypto.payment.expired'
  | 'dispute.created'
  | 'dispute.updated'
  | 'dispute.won'
  | 'dispute.lost'
  | 'fraud.alert';

// ==================== AUDIT LOG TYPES ====================

export interface AuditLog {
  id: string;
  merchantId?: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  oldValues?: Record<string, any>;
  newValues?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

// ==================== KYC/KYB TYPES ====================

export type KYCStatus = 'pending' | 'in_review' | 'approved' | 'rejected' | 'requires_info';

export interface KYCVerification {
  id: string;
  merchantId: string;
  status: KYCStatus;
  type: 'individual' | 'business';
  documents: KYCDocument[];
  verificationData: Record<string, any>;
  rejectionReason?: string;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface KYCDocument {
  id: string;
  type: 'id_front' | 'id_back' | 'passport' | 'business_license' | 'proof_of_address' | 'bank_statement';
  status: 'pending' | 'verified' | 'rejected';
  fileUrl: string;
  rejectionReason?: string;
  uploadedAt: Date;
}
