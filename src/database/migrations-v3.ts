// Migrations for Financial Services v3
// Includes: Module System, Lending, Banking, Cards, Insurance, Disbursements, Escrow, Compliance

export const migrationsV3 = `
-- Module System
CREATE TABLE IF NOT EXISTS merchant_modules (
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  module_key VARCHAR(100) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}',
  activated_at TIMESTAMP,
  deactivated_at TIMESTAMP,
  usage_this_month INTEGER DEFAULT 0,
  usage_limit INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (merchant_id, module_key)
);

CREATE INDEX idx_merchant_modules_enabled ON merchant_modules(merchant_id, enabled);

-- Lending: Loan Applications (MCA, Revenue Financing)
CREATE TABLE IF NOT EXISTS loan_applications (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  customer_id UUID,
  type VARCHAR(50) NOT NULL, -- mca, revenue_financing, bnpl
  requested_amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  approved_amount BIGINT,
  interest_rate DECIMAL(5,2),
  factor_rate DECIMAL(5,3),
  term_days INTEGER,
  repayment_percentage DECIMAL(5,2),
  total_repayment BIGINT,
  amount_repaid BIGINT DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  applied_at TIMESTAMP DEFAULT NOW(),
  approved_at TIMESTAMP,
  funded_at TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX idx_loan_applications_merchant ON loan_applications(merchant_id, type, status);

-- Lending: BNPL Purchases
CREATE TABLE IF NOT EXISTS bnpl_purchases (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  customer_id UUID NOT NULL,
  transaction_id UUID,
  plan VARCHAR(50) NOT NULL,
  total_amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  installment_amount BIGINT NOT NULL,
  installments_paid INTEGER DEFAULT 0,
  total_installments INTEGER NOT NULL,
  next_payment_date DATE,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bnpl_customer ON bnpl_purchases(customer_id, status);

-- Lending: Invoice Factoring
CREATE TABLE IF NOT EXISTS invoice_factoring (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  invoice_id UUID NOT NULL,
  invoice_amount BIGINT NOT NULL,
  advance_amount BIGINT NOT NULL,
  advance_percentage DECIMAL(5,2) NOT NULL,
  fee_percentage DECIMAL(5,2) NOT NULL,
  fee_amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  funded_at TIMESTAMP,
  collected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Banking: Virtual Accounts
CREATE TABLE IF NOT EXISTS virtual_accounts (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  account_number VARCHAR(50) NOT NULL UNIQUE,
  routing_number VARCHAR(20),
  iban VARCHAR(50),
  swift_bic VARCHAR(20),
  account_type VARCHAR(50) DEFAULT 'virtual',
  currency VARCHAR(3) NOT NULL,
  balance BIGINT DEFAULT 0,
  available_balance BIGINT DEFAULT 0,
  status VARCHAR(50) DEFAULT 'active',
  nickname VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_virtual_accounts_merchant ON virtual_accounts(merchant_id, status);

-- Banking: Account Transactions
CREATE TABLE IF NOT EXISTS account_transactions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES virtual_accounts(id),
  type VARCHAR(50) NOT NULL,
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  reference VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Banking: Multi-Currency Balances
CREATE TABLE IF NOT EXISTS multi_currency_balances (
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  currency VARCHAR(3) NOT NULL,
  balance BIGINT DEFAULT 0,
  available_balance BIGINT DEFAULT 0,
  last_updated TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (merchant_id, currency)
);

-- Banking: FX Conversions
CREATE TABLE IF NOT EXISTS fx_conversions (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  from_currency VARCHAR(3) NOT NULL,
  to_currency VARCHAR(3) NOT NULL,
  from_amount BIGINT NOT NULL,
  to_amount BIGINT NOT NULL,
  rate DECIMAL(12,6) NOT NULL,
  spread DECIMAL(6,4) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Banking: Yield Accounts
CREATE TABLE IF NOT EXISTS yield_accounts (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  currency VARCHAR(3) NOT NULL,
  principal BIGINT NOT NULL,
  accrued_interest BIGINT DEFAULT 0,
  annual_rate DECIMAL(5,2) NOT NULL,
  compounding_frequency VARCHAR(20) DEFAULT 'daily',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  last_accrual_date TIMESTAMP DEFAULT NOW()
);

-- Banking: Merchant Cards
CREATE TABLE IF NOT EXISTS merchant_cards (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  card_type VARCHAR(50) NOT NULL,
  card_number_encrypted VARCHAR(255) NOT NULL,
  last4 VARCHAR(4) NOT NULL,
  expiry_month INTEGER NOT NULL,
  expiry_year INTEGER NOT NULL,
  cardholder_name VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  spending_limit BIGINT,
  spent_this_month BIGINT DEFAULT 0,
  currency VARCHAR(3) NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Card Issuing: Issued Cards
CREATE TABLE IF NOT EXISTS issued_cards (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  card_type VARCHAR(50) NOT NULL, -- virtual, expense, gift
  card_number_encrypted VARCHAR(255) NOT NULL,
  last4 VARCHAR(4) NOT NULL,
  expiry_month INTEGER NOT NULL,
  expiry_year INTEGER NOT NULL,
  cardholder_name VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  balance BIGINT, -- For gift cards
  spending_limit BIGINT,
  spent_total BIGINT DEFAULT 0,
  currency VARCHAR(3) NOT NULL,
  allowed_categories JSONB,
  blocked_categories JSONB,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_issued_cards_merchant ON issued_cards(merchant_id, card_type, status);

-- Card Issuing: Card Transactions
CREATE TABLE IF NOT EXISTS card_transactions (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES issued_cards(id),
  merchant_id UUID NOT NULL,
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  merchant_name VARCHAR(255),
  merchant_category VARCHAR(50),
  status VARCHAR(50) DEFAULT 'pending',
  decline_reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Card Issuing: Gift Card Programs
CREATE TABLE IF NOT EXISTS gift_card_programs (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  min_amount BIGINT NOT NULL,
  max_amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  expiry_days INTEGER,
  custom_design TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insurance: Policies
CREATE TABLE IF NOT EXISTS insurance_policies (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  type VARCHAR(50) NOT NULL, -- chargeback, fraud, shipping
  coverage_amount BIGINT NOT NULL,
  premium BIGINT NOT NULL,
  deductible BIGINT DEFAULT 0,
  currency VARCHAR(3) NOT NULL,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insurance: Claims
CREATE TABLE IF NOT EXISTS insurance_claims (
  id UUID PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES insurance_policies(id),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  type VARCHAR(50) NOT NULL,
  transaction_id UUID,
  claim_amount BIGINT NOT NULL,
  approved_amount BIGINT,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  reason TEXT,
  evidence JSONB DEFAULT '{}',
  review_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

CREATE INDEX idx_insurance_claims_status ON insurance_claims(merchant_id, status);

-- Disbursements: Payout Batches
CREATE TABLE IF NOT EXISTS payout_batches (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  name VARCHAR(255) NOT NULL,
  total_amount BIGINT NOT NULL,
  total_fees BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  payout_count INTEGER NOT NULL,
  completed_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);

-- Disbursements: Payouts
CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  batch_id UUID REFERENCES payout_batches(id),
  recipient_id VARCHAR(255) NOT NULL,
  recipient_name VARCHAR(255) NOT NULL,
  recipient_email VARCHAR(255),
  amount BIGINT NOT NULL,
  fee BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  method VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  bank_details JSONB DEFAULT '{}',
  reference VARCHAR(255),
  memo TEXT,
  metadata JSONB DEFAULT '{}',
  scheduled_at TIMESTAMP,
  processed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_payouts_merchant ON payouts(merchant_id, status);
CREATE INDEX idx_payouts_batch ON payouts(batch_id);

-- Disbursements: Contractors
CREATE TABLE IF NOT EXISTS contractors (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  tax_id VARCHAR(50),
  address JSONB DEFAULT '{}',
  bank_details JSONB DEFAULT '{}',
  total_paid BIGINT DEFAULT 0,
  currency VARCHAR(3) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_contractors_merchant ON contractors(merchant_id, is_active);

-- Escrow: Accounts
CREATE TABLE IF NOT EXISTS escrow_accounts (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  buyer_id UUID NOT NULL,
  seller_id UUID NOT NULL,
  transaction_id UUID,
  amount BIGINT NOT NULL,
  fee BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  description TEXT,
  release_conditions JSONB,
  milestones JSONB,
  metadata JSONB DEFAULT '{}',
  funded_at TIMESTAMP,
  released_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_escrow_accounts_merchant ON escrow_accounts(merchant_id, status);

-- Escrow: Disputes
CREATE TABLE IF NOT EXISTS escrow_disputes (
  id UUID PRIMARY KEY,
  escrow_id UUID NOT NULL REFERENCES escrow_accounts(id),
  initiated_by VARCHAR(50) NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'open',
  resolution TEXT,
  resolved_in_favor_of VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

-- Compliance: KYC Verifications
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  customer_id UUID NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  risk_level VARCHAR(50),
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  date_of_birth DATE NOT NULL,
  address JSONB NOT NULL,
  document_type VARCHAR(50),
  document_number VARCHAR(100),
  verification_results JSONB,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  verified_at TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE INDEX idx_kyc_customer ON kyc_verifications(merchant_id, customer_id);

-- Compliance: KYB Verifications
CREATE TABLE IF NOT EXISTS kyb_verifications (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  business_id UUID NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  risk_level VARCHAR(50),
  business_name VARCHAR(255) NOT NULL,
  business_type VARCHAR(100) NOT NULL,
  registration_number VARCHAR(100) NOT NULL,
  tax_id VARCHAR(100) NOT NULL,
  incorporation_country VARCHAR(3) NOT NULL,
  incorporation_date DATE,
  address JSONB NOT NULL,
  beneficial_owners JSONB,
  verification_results JSONB,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  verified_at TIMESTAMP
);

CREATE INDEX idx_kyb_business ON kyb_verifications(merchant_id, business_id);

-- Compliance: AML Screenings
CREATE TABLE IF NOT EXISTS aml_screenings (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'clear',
  screening_results JSONB,
  matches JSONB,
  reviewed_by VARCHAR(255),
  review_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP
);

CREATE INDEX idx_aml_entity ON aml_screenings(merchant_id, entity_id);

-- Compliance: Monitored Entities
CREATE TABLE IF NOT EXISTS monitored_entities (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_name VARCHAR(255) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(merchant_id, entity_id)
);

-- Compliance: Monitoring Alerts
CREATE TABLE IF NOT EXISTS monitoring_alerts (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  alert_type VARCHAR(100) NOT NULL,
  severity VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'open',
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP
);

CREATE INDEX idx_monitoring_alerts_status ON monitoring_alerts(merchant_id, status);

-- Add verification columns to merchants table
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS kyc_verified BOOLEAN DEFAULT false;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS kyb_verified BOOLEAN DEFAULT false;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS bank_account_verified BOOLEAN DEFAULT false;
`;
