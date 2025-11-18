// Migrations for Core Banking and Family Office
// Includes: Bank accounts, transfers, ledger, family offices, trusts, estate planning, tax lots

export const migrationsBankingFamily = `
-- ============================================
-- CORE BANKING TABLES
-- ============================================

-- Bank Accounts
CREATE TABLE IF NOT EXISTS bank_accounts (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  account_number VARCHAR(20) UNIQUE NOT NULL,
  routing_number VARCHAR(9) NOT NULL,
  account_type VARCHAR(50) NOT NULL, -- checking, savings, money_market, cd, trust, custodial
  account_name VARCHAR(255) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  balance BIGINT DEFAULT 0,
  available_balance BIGINT DEFAULT 0,
  pending_balance BIGINT DEFAULT 0,
  interest_rate DECIMAL(5,4) DEFAULT 0,
  interest_accrued BIGINT DEFAULT 0,
  last_interest_calc TIMESTAMP,
  minimum_balance BIGINT DEFAULT 0,
  overdraft_limit BIGINT DEFAULT 0,
  status VARCHAR(50) DEFAULT 'active', -- active, frozen, closed
  opened_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bank_accounts_merchant ON bank_accounts(merchant_id, status);
CREATE INDEX idx_bank_accounts_number ON bank_accounts(account_number);
CREATE INDEX idx_bank_accounts_type ON bank_accounts(account_type);

-- Bank Transfers (ACH/Wire)
CREATE TABLE IF NOT EXISTS bank_transfers (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  from_account_id UUID REFERENCES bank_accounts(id),
  to_account_id UUID REFERENCES bank_accounts(id),
  transfer_type VARCHAR(50) NOT NULL, -- internal, ach, wire_domestic, wire_international
  direction VARCHAR(10) NOT NULL, -- inbound, outbound
  amount BIGINT NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  fee BIGINT DEFAULT 0,

  -- External account details (for ACH/wire)
  external_account_name VARCHAR(255),
  external_account_number VARCHAR(34),
  external_routing_number VARCHAR(11),
  external_bank_name VARCHAR(255),
  external_bank_address TEXT,
  swift_code VARCHAR(11),
  iban VARCHAR(34),

  -- ACH specific
  ach_company_id VARCHAR(10),
  ach_batch_id VARCHAR(20),
  sec_code VARCHAR(3), -- PPD, CCD, WEB, etc.

  -- Wire specific
  wire_reference VARCHAR(100),
  intermediary_bank VARCHAR(255),
  intermediary_swift VARCHAR(11),
  purpose_of_payment TEXT,

  -- Status tracking
  status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed, cancelled, returned
  failure_reason TEXT,
  return_code VARCHAR(10),

  -- Timestamps
  initiated_at TIMESTAMP DEFAULT NOW(),
  expected_settlement TIMESTAMP,
  settled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  metadata JSONB
);

CREATE INDEX idx_bank_transfers_merchant ON bank_transfers(merchant_id, created_at DESC);
CREATE INDEX idx_bank_transfers_status ON bank_transfers(status);
CREATE INDEX idx_bank_transfers_type ON bank_transfers(transfer_type);
CREATE INDEX idx_bank_transfers_from ON bank_transfers(from_account_id);
CREATE INDEX idx_bank_transfers_to ON bank_transfers(to_account_id);

-- Bank Ledger (Double-Entry Accounting)
CREATE TABLE IF NOT EXISTS bank_ledger (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES bank_accounts(id),
  transfer_id UUID REFERENCES bank_transfers(id),
  entry_type VARCHAR(10) NOT NULL, -- debit, credit
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  description TEXT NOT NULL,
  reference VARCHAR(100),
  posted_at TIMESTAMP DEFAULT NOW(),
  effective_date DATE DEFAULT CURRENT_DATE,
  metadata JSONB
);

CREATE INDEX idx_bank_ledger_account ON bank_ledger(account_id, posted_at DESC);
CREATE INDEX idx_bank_ledger_transfer ON bank_ledger(transfer_id);
CREATE INDEX idx_bank_ledger_date ON bank_ledger(effective_date);

-- Account Statements
CREATE TABLE IF NOT EXISTS bank_statements (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES bank_accounts(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  opening_balance BIGINT NOT NULL,
  closing_balance BIGINT NOT NULL,
  total_credits BIGINT NOT NULL,
  total_debits BIGINT NOT NULL,
  transaction_count INTEGER NOT NULL,
  interest_earned BIGINT DEFAULT 0,
  fees_charged BIGINT DEFAULT 0,
  generated_at TIMESTAMP DEFAULT NOW(),
  pdf_url TEXT,
  UNIQUE(account_id, period_start, period_end)
);

CREATE INDEX idx_bank_statements_account ON bank_statements(account_id, period_end DESC);

-- ============================================
-- FAMILY OFFICE TABLES
-- ============================================

-- Family Offices
CREATE TABLE IF NOT EXISTS family_offices (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  name VARCHAR(255) NOT NULL,
  legal_structure VARCHAR(100), -- single_family, multi_family, embedded
  founding_date DATE,
  mission_statement TEXT,
  investment_philosophy TEXT,
  risk_tolerance VARCHAR(50), -- conservative, moderate, aggressive
  primary_currency VARCHAR(3) DEFAULT 'USD',
  total_aum BIGINT DEFAULT 0, -- Assets under management
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_family_offices_merchant ON family_offices(merchant_id);

-- Family Members
CREATE TABLE IF NOT EXISTS family_members (
  id UUID PRIMARY KEY,
  family_office_id UUID NOT NULL REFERENCES family_offices(id),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  date_of_birth DATE,
  relationship VARCHAR(100) NOT NULL, -- patriarch, matriarch, spouse, child, grandchild, sibling
  generation INTEGER DEFAULT 1,
  role VARCHAR(100), -- principal, beneficiary, trustee, advisor
  email VARCHAR(255),
  phone VARCHAR(20),
  address TEXT,
  access_level VARCHAR(50) DEFAULT 'view_only', -- full, limited, view_only
  voting_rights BOOLEAN DEFAULT false,
  ownership_percentage DECIMAL(5,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'active',
  added_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_family_members_office ON family_members(family_office_id);
CREATE INDEX idx_family_members_role ON family_members(role);

-- Family Assets
CREATE TABLE IF NOT EXISTS family_assets (
  id UUID PRIMARY KEY,
  family_office_id UUID NOT NULL REFERENCES family_offices(id),
  member_id UUID REFERENCES family_members(id), -- NULL if family-wide
  asset_class VARCHAR(100) NOT NULL, -- equities, fixed_income, real_estate, private_equity, alternatives, cash, crypto, collectibles
  asset_type VARCHAR(100) NOT NULL, -- stock, bond, property, fund, etc.
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Valuation
  current_value BIGINT NOT NULL,
  cost_basis BIGINT NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',

  -- Holdings info
  quantity DECIMAL(20,8),
  ticker_symbol VARCHAR(20),
  cusip VARCHAR(9),
  isin VARCHAR(12),

  -- Real estate specific
  property_address TEXT,
  property_type VARCHAR(50),

  -- Performance
  acquisition_date DATE,
  unrealized_gain BIGINT DEFAULT 0,
  income_ytd BIGINT DEFAULT 0,

  -- Custodian
  custodian_name VARCHAR(255),
  account_at_custodian VARCHAR(100),

  last_valuation_date DATE,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_family_assets_office ON family_assets(family_office_id);
CREATE INDEX idx_family_assets_member ON family_assets(member_id);
CREATE INDEX idx_family_assets_class ON family_assets(asset_class);
CREATE INDEX idx_family_assets_ticker ON family_assets(ticker_symbol);

-- Family Trusts
CREATE TABLE IF NOT EXISTS family_trusts (
  id UUID PRIMARY KEY,
  family_office_id UUID NOT NULL REFERENCES family_offices(id),
  trust_name VARCHAR(255) NOT NULL,
  trust_type VARCHAR(100) NOT NULL, -- revocable, irrevocable, charitable_remainder, charitable_lead, grantor, dynasty, spendthrift, special_needs, GRAT, QPRT
  ein VARCHAR(20),

  -- Key parties
  grantor_id UUID REFERENCES family_members(id),
  trustee_ids JSONB, -- Array of member IDs
  beneficiary_ids JSONB, -- Array of member IDs

  -- Trust details
  funding_amount BIGINT DEFAULT 0,
  current_value BIGINT DEFAULT 0,
  distribution_rules TEXT,
  spendthrift_provision BOOLEAN DEFAULT false,
  irrevocable_date DATE,
  termination_date DATE,

  -- Jurisdiction
  governing_law VARCHAR(50),
  situs VARCHAR(100),

  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_family_trusts_office ON family_trusts(family_office_id);
CREATE INDEX idx_family_trusts_type ON family_trusts(trust_type);

-- Trust Distributions
CREATE TABLE IF NOT EXISTS trust_distributions (
  id UUID PRIMARY KEY,
  trust_id UUID NOT NULL REFERENCES family_trusts(id),
  beneficiary_id UUID NOT NULL REFERENCES family_members(id),
  distribution_type VARCHAR(50) NOT NULL, -- income, principal, discretionary, mandatory
  amount BIGINT NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  reason TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected, completed
  requested_at TIMESTAMP DEFAULT NOW(),
  approved_by UUID REFERENCES family_members(id),
  approved_at TIMESTAMP,
  distributed_at TIMESTAMP,
  tax_withheld BIGINT DEFAULT 0,
  metadata JSONB
);

CREATE INDEX idx_trust_distributions_trust ON trust_distributions(trust_id);
CREATE INDEX idx_trust_distributions_beneficiary ON trust_distributions(beneficiary_id);
CREATE INDEX idx_trust_distributions_status ON trust_distributions(status);

-- Estate Planning Documents
CREATE TABLE IF NOT EXISTS estate_documents (
  id UUID PRIMARY KEY,
  family_office_id UUID NOT NULL REFERENCES family_offices(id),
  member_id UUID NOT NULL REFERENCES family_members(id),
  document_type VARCHAR(100) NOT NULL, -- will, living_will, poa_financial, poa_healthcare, trust_agreement, prenup, beneficiary_designation, letter_of_intent
  title VARCHAR(255) NOT NULL,
  description TEXT,

  -- Document details
  executed_date DATE,
  effective_date DATE,
  expiration_date DATE,

  -- Storage
  file_url TEXT,
  file_hash VARCHAR(64),

  -- Contacts
  attorney_name VARCHAR(255),
  attorney_contact TEXT,

  -- Status
  status VARCHAR(50) DEFAULT 'draft', -- draft, executed, superseded, revoked
  reviewed_at TIMESTAMP,
  next_review_date DATE,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_estate_documents_office ON estate_documents(family_office_id);
CREATE INDEX idx_estate_documents_member ON estate_documents(member_id);
CREATE INDEX idx_estate_documents_type ON estate_documents(document_type);

-- Tax Lots (for gain/loss tracking)
CREATE TABLE IF NOT EXISTS tax_lots (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL REFERENCES family_assets(id),
  acquisition_date DATE NOT NULL,
  quantity DECIMAL(20,8) NOT NULL,
  cost_basis_per_unit BIGINT NOT NULL,
  total_cost_basis BIGINT NOT NULL,
  acquisition_type VARCHAR(50) NOT NULL, -- purchase, gift, inheritance, transfer

  -- If gifted/inherited
  donor_cost_basis BIGINT,
  fair_market_value_at_acquisition BIGINT,

  -- Holding period
  holding_period VARCHAR(20), -- short_term, long_term

  -- Disposal
  disposed_quantity DECIMAL(20,8) DEFAULT 0,
  remaining_quantity DECIMAL(20,8),
  disposed_at DATE,
  disposal_proceeds BIGINT,
  realized_gain_loss BIGINT,

  -- Wash sale
  is_wash_sale BOOLEAN DEFAULT false,
  disallowed_loss BIGINT DEFAULT 0,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_tax_lots_asset ON tax_lots(asset_id);
CREATE INDEX idx_tax_lots_date ON tax_lots(acquisition_date);
CREATE INDEX idx_tax_lots_holding ON tax_lots(holding_period);

-- Charitable Gifts
CREATE TABLE IF NOT EXISTS charitable_gifts (
  id UUID PRIMARY KEY,
  family_office_id UUID NOT NULL REFERENCES family_offices(id),
  donor_id UUID NOT NULL REFERENCES family_members(id),

  -- Recipient
  recipient_name VARCHAR(255) NOT NULL,
  recipient_ein VARCHAR(20),
  recipient_type VARCHAR(50) NOT NULL, -- public_charity, private_foundation, daf, religious, educational

  -- Gift details
  gift_type VARCHAR(50) NOT NULL, -- cash, securities, property, in_kind
  asset_id UUID REFERENCES family_assets(id),
  amount BIGINT NOT NULL,
  fair_market_value BIGINT NOT NULL,
  cost_basis BIGINT,
  currency VARCHAR(3) DEFAULT 'USD',

  -- Tax info
  deduction_amount BIGINT NOT NULL,
  carryforward_amount BIGINT DEFAULT 0,
  tax_year INTEGER NOT NULL,

  -- Tracking
  gift_date DATE NOT NULL,
  acknowledgment_received BOOLEAN DEFAULT false,
  acknowledgment_date DATE,

  -- DAF specific
  daf_account_id VARCHAR(100),
  grant_recommendation BOOLEAN DEFAULT false,

  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_charitable_gifts_office ON charitable_gifts(family_office_id);
CREATE INDEX idx_charitable_gifts_donor ON charitable_gifts(donor_id);
CREATE INDEX idx_charitable_gifts_year ON charitable_gifts(tax_year);
CREATE INDEX idx_charitable_gifts_recipient ON charitable_gifts(recipient_name);

-- Family Meetings (Governance)
CREATE TABLE IF NOT EXISTS family_meetings (
  id UUID PRIMARY KEY,
  family_office_id UUID NOT NULL REFERENCES family_offices(id),
  meeting_type VARCHAR(100) NOT NULL, -- annual, quarterly, special, emergency, education
  title VARCHAR(255) NOT NULL,
  description TEXT,

  -- Scheduling
  scheduled_date TIMESTAMP NOT NULL,
  duration_minutes INTEGER DEFAULT 60,
  location TEXT,
  virtual_link TEXT,

  -- Attendance
  required_attendees JSONB, -- Array of member IDs
  optional_attendees JSONB,
  actual_attendees JSONB,

  -- Meeting content
  agenda JSONB,
  minutes TEXT,
  decisions JSONB,
  action_items JSONB,

  -- Voting
  votes_taken JSONB, -- Array of {topic, votes_for, votes_against, abstained}

  -- Status
  status VARCHAR(50) DEFAULT 'scheduled', -- scheduled, in_progress, completed, cancelled

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_family_meetings_office ON family_meetings(family_office_id);
CREATE INDEX idx_family_meetings_date ON family_meetings(scheduled_date);
CREATE INDEX idx_family_meetings_status ON family_meetings(status);

-- ============================================
-- ADDITIONAL INDEXES AND CONSTRAINTS
-- ============================================

-- Add remaining_quantity trigger for tax lots
CREATE OR REPLACE FUNCTION update_tax_lot_remaining()
RETURNS TRIGGER AS $$
BEGIN
  NEW.remaining_quantity := NEW.quantity - COALESCE(NEW.disposed_quantity, 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tax_lot_remaining_trigger
  BEFORE INSERT OR UPDATE ON tax_lots
  FOR EACH ROW
  EXECUTE FUNCTION update_tax_lot_remaining();

-- Add holding period calculation trigger
CREATE OR REPLACE FUNCTION calculate_holding_period()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.acquisition_date IS NOT NULL THEN
    IF (CURRENT_DATE - NEW.acquisition_date) > 365 THEN
      NEW.holding_period := 'long_term';
    ELSE
      NEW.holding_period := 'short_term';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tax_lot_holding_period_trigger
  BEFORE INSERT OR UPDATE ON tax_lots
  FOR EACH ROW
  EXECUTE FUNCTION calculate_holding_period();
`;
