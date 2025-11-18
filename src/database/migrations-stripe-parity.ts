// Migrations for Stripe/Paddle Parity Features
// Checkout, Digital Wallets, Dunning, Usage Billing, Customer Portal, Promotions, Revenue Recognition, Terminal

export const migrationsStripeParity = `
-- ============================================
-- CHECKOUT & UI COMPONENTS
-- ============================================

-- Checkout Sessions
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  mode VARCHAR(20) NOT NULL, -- payment, subscription, setup
  url TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'open', -- open, complete, expired
  payment_status VARCHAR(20) DEFAULT 'unpaid', -- unpaid, paid, no_payment_required
  customer_email VARCHAR(255),
  customer_id UUID REFERENCES customers(id),
  amount_total BIGINT NOT NULL,
  amount_subtotal BIGINT NOT NULL,
  currency VARCHAR(3) DEFAULT 'usd',
  line_items JSONB NOT NULL,
  success_url TEXT NOT NULL,
  cancel_url TEXT NOT NULL,
  payment_intent_id VARCHAR(100),
  subscription_id VARCHAR(100),
  expires_at TIMESTAMP NOT NULL,
  payment_method_types JSONB,
  allow_promotion_codes BOOLEAN DEFAULT false,
  shipping_address_collection JSONB,
  shipping_options JSONB,
  custom_fields JSONB,
  locale VARCHAR(10) DEFAULT 'auto',
  automatic_tax BOOLEAN DEFAULT false,
  tax_id_collection BOOLEAN DEFAULT false,
  consent_collection JSONB,
  phone_number_collection BOOLEAN DEFAULT false,
  subscription_data JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_checkout_sessions_merchant ON checkout_sessions(merchant_id, created_at DESC);
CREATE INDEX idx_checkout_sessions_status ON checkout_sessions(status);
CREATE INDEX idx_checkout_sessions_customer ON checkout_sessions(customer_id);

-- Pricing Tables
CREATE TABLE IF NOT EXISTS pricing_tables (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  config JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- DIGITAL WALLETS
-- ============================================

-- Apple Pay Merchants
CREATE TABLE IF NOT EXISTS apple_pay_merchants (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id),
  merchant_identifier VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  domain_names JSONB NOT NULL,
  merchant_capabilities JSONB NOT NULL,
  supported_networks JSONB NOT NULL,
  country_code VARCHAR(2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending, active, suspended
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

-- Apple Pay Domain Verification
CREATE TABLE IF NOT EXISTS apple_pay_domain_verification (
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  domain_name VARCHAR(255) NOT NULL,
  verification_content TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending, verified, failed
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP,
  PRIMARY KEY (merchant_id, domain_name)
);

-- Google Pay Merchants
CREATE TABLE IF NOT EXISTS google_pay_merchants (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id),
  merchant_name VARCHAR(255) NOT NULL,
  environment VARCHAR(20) DEFAULT 'TEST', -- TEST, PRODUCTION
  allowed_card_networks JSONB NOT NULL,
  allowed_card_auth_methods JSONB NOT NULL,
  gateway_merchant_id VARCHAR(100) NOT NULL,
  merchant_origin VARCHAR(255),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

-- Wallet Payments
CREATE TABLE IF NOT EXISTS wallet_payments (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  wallet_type VARCHAR(20) NOT NULL, -- apple_pay, google_pay
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  card_network VARCHAR(20),
  card_last_four VARCHAR(4),
  token_transaction_id VARCHAR(255),
  email VARCHAR(255),
  billing_address JSONB,
  shipping_address JSONB,
  status VARCHAR(20) DEFAULT 'succeeded',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_wallet_payments_merchant ON wallet_payments(merchant_id, created_at DESC);
CREATE INDEX idx_wallet_payments_type ON wallet_payments(wallet_type);

-- ============================================
-- DUNNING MANAGEMENT
-- ============================================

-- Dunning Configuration
CREATE TABLE IF NOT EXISTS dunning_configs (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id),
  enabled BOOLEAN DEFAULT true,
  retry_schedule JSONB NOT NULL,
  smart_retries JSONB NOT NULL,
  emails JSONB NOT NULL,
  grace_period_days INTEGER DEFAULT 7,
  final_action VARCHAR(20) DEFAULT 'cancel', -- cancel, pause, unpaid
  cancel_at_period_end BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

-- Dunning Campaigns
CREATE TABLE IF NOT EXISTS dunning_campaigns (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  subscription_id VARCHAR(100) NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  invoice_id VARCHAR(100) NOT NULL,
  original_payment_id VARCHAR(100) NOT NULL,
  amount_due BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- active, recovered, failed, cancelled
  attempts JSONB NOT NULL,
  next_retry_at TIMESTAMP,
  grace_ends_at TIMESTAMP NOT NULL,
  final_action_at TIMESTAMP,
  recovered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_dunning_campaigns_merchant ON dunning_campaigns(merchant_id, created_at DESC);
CREATE INDEX idx_dunning_campaigns_status ON dunning_campaigns(status);
CREATE INDEX idx_dunning_campaigns_subscription ON dunning_campaigns(subscription_id);
CREATE INDEX idx_dunning_campaigns_next_retry ON dunning_campaigns(next_retry_at) WHERE status = 'active';

-- Dunning Emails
CREATE TABLE IF NOT EXISTS dunning_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  email_type VARCHAR(50) NOT NULL,
  data JSONB,
  sent_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- USAGE-BASED BILLING
-- ============================================

-- Usage Meters
CREATE TABLE IF NOT EXISTS usage_meters (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  display_name VARCHAR(255) NOT NULL,
  event_name VARCHAR(100) NOT NULL,
  aggregation_type VARCHAR(20) NOT NULL, -- sum, count, max, last, unique
  value_key VARCHAR(100),
  deduplication_key VARCHAR(100),
  default_unit VARCHAR(50) DEFAULT 'units',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_usage_meters_merchant ON usage_meters(merchant_id);
CREATE INDEX idx_usage_meters_event ON usage_meters(event_name);

-- Usage Records
CREATE TABLE IF NOT EXISTS usage_records (
  id VARCHAR(100) PRIMARY KEY,
  meter_id VARCHAR(100) NOT NULL REFERENCES usage_meters(id),
  subscription_id VARCHAR(100) NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  timestamp TIMESTAMP NOT NULL,
  quantity DECIMAL(20,8) NOT NULL,
  action VARCHAR(20) DEFAULT 'increment', -- set, increment
  properties JSONB,
  idempotency_key VARCHAR(255) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_usage_records_meter ON usage_records(meter_id, timestamp DESC);
CREATE INDEX idx_usage_records_subscription ON usage_records(subscription_id, timestamp DESC);
CREATE INDEX idx_usage_records_idempotency ON usage_records(idempotency_key);

-- Metered Prices
CREATE TABLE IF NOT EXISTS metered_prices (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  product_id VARCHAR(100) NOT NULL,
  meter_id VARCHAR(100) NOT NULL REFERENCES usage_meters(id),
  currency VARCHAR(3) NOT NULL,
  billing_scheme VARCHAR(20) NOT NULL, -- per_unit, tiered
  unit_amount BIGINT,
  tiers JSONB,
  tiers_mode VARCHAR(20) DEFAULT 'graduated', -- graduated, volume
  transform_quantity JSONB,
  aggregate_usage VARCHAR(50) DEFAULT 'sum',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_metered_prices_merchant ON metered_prices(merchant_id);
CREATE INDEX idx_metered_prices_meter ON metered_prices(meter_id);

-- Usage Alerts
CREATE TABLE IF NOT EXISTS usage_alerts (
  subscription_id VARCHAR(100) NOT NULL,
  meter_id VARCHAR(100) NOT NULL REFERENCES usage_meters(id),
  threshold DECIMAL(20,8) NOT NULL,
  notify_email VARCHAR(255),
  last_notified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (subscription_id, meter_id)
);

-- ============================================
-- CUSTOMER PORTAL
-- ============================================

-- Portal Configurations
CREATE TABLE IF NOT EXISTS portal_configurations (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id),
  business_profile JSONB NOT NULL,
  features JSONB NOT NULL,
  default_return_url TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

-- Portal Sessions
CREATE TABLE IF NOT EXISTS portal_sessions (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  session_token VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  return_url TEXT NOT NULL,
  flow JSONB,
  locale VARCHAR(10) DEFAULT 'auto',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_portal_sessions_merchant ON portal_sessions(merchant_id);
CREATE INDEX idx_portal_sessions_customer ON portal_sessions(customer_id);

-- Subscription Cancellations (for analytics)
CREATE TABLE IF NOT EXISTS subscription_cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id VARCHAR(100) NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  reason VARCHAR(50),
  feedback TEXT,
  cancel_at_period_end BOOLEAN,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_subscription_cancellations_reason ON subscription_cancellations(reason);

-- ============================================
-- PROMOTIONS (TRIALS, COUPONS, DISCOUNTS)
-- ============================================

-- Coupons
CREATE TABLE IF NOT EXISTS coupons (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  name VARCHAR(255) NOT NULL,
  currency VARCHAR(3),
  amount_off BIGINT,
  percent_off DECIMAL(5,2),
  duration VARCHAR(20) NOT NULL, -- once, repeating, forever
  duration_in_months INTEGER,
  max_redemptions INTEGER,
  redeem_by TIMESTAMP,
  applies_to JSONB,
  min_purchase_amount BIGINT,
  first_time_transaction BOOLEAN DEFAULT false,
  times_redeemed INTEGER DEFAULT 0,
  valid BOOLEAN DEFAULT true,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_coupons_merchant ON coupons(merchant_id);
CREATE INDEX idx_coupons_valid ON coupons(valid);

-- Promotion Codes
CREATE TABLE IF NOT EXISTS promotion_codes (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  code VARCHAR(50) NOT NULL,
  coupon_id VARCHAR(100) NOT NULL REFERENCES coupons(id),
  active BOOLEAN DEFAULT true,
  customer UUID REFERENCES customers(id),
  expires_at TIMESTAMP,
  max_redemptions INTEGER,
  times_redeemed INTEGER DEFAULT 0,
  restrictions JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(merchant_id, code)
);

CREATE INDEX idx_promotion_codes_merchant ON promotion_codes(merchant_id);
CREATE INDEX idx_promotion_codes_code ON promotion_codes(code);

-- Discounts (applied to subscriptions/invoices)
CREATE TABLE IF NOT EXISTS discounts (
  id VARCHAR(100) PRIMARY KEY,
  coupon_id VARCHAR(100) NOT NULL REFERENCES coupons(id),
  customer_id UUID REFERENCES customers(id),
  subscription_id VARCHAR(100),
  invoice_id VARCHAR(100),
  promotion_code_id VARCHAR(100) REFERENCES promotion_codes(id),
  start_date TIMESTAMP DEFAULT NOW(),
  end_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_discounts_subscription ON discounts(subscription_id);
CREATE INDEX idx_discounts_customer ON discounts(customer_id);

-- ============================================
-- REVENUE RECOGNITION
-- ============================================

-- Deferred Revenue
CREATE TABLE IF NOT EXISTS deferred_revenue (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  subscription_id VARCHAR(100),
  invoice_id VARCHAR(100),
  transaction_price BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  recognized_amount BIGINT DEFAULT 0,
  deferred_amount BIGINT NOT NULL,
  recognition_method VARCHAR(50) NOT NULL, -- point_in_time, over_time, milestone, output, input, usage
  recognition_start_date DATE NOT NULL,
  recognition_end_date DATE NOT NULL,
  performance_obligations JSONB NOT NULL,
  schedule_entries JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- active, completed, cancelled
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE INDEX idx_deferred_revenue_merchant ON deferred_revenue(merchant_id);
CREATE INDEX idx_deferred_revenue_customer ON deferred_revenue(customer_id);
CREATE INDEX idx_deferred_revenue_status ON deferred_revenue(status);

-- Contract Modifications
CREATE TABLE IF NOT EXISTS contract_modifications (
  id VARCHAR(100) PRIMARY KEY,
  deferred_revenue_id VARCHAR(100) NOT NULL REFERENCES deferred_revenue(id),
  modification_type VARCHAR(50) NOT NULL, -- separate_contract, termination_new, cumulative_catchup
  adjustment_amount BIGINT NOT NULL,
  reason TEXT NOT NULL,
  effective_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_contract_mods_deferred ON contract_modifications(deferred_revenue_id);

-- Journal Entries
CREATE TABLE IF NOT EXISTS journal_entries (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  entry_date DATE NOT NULL,
  description TEXT NOT NULL,
  lines JSONB NOT NULL,
  reference VARCHAR(255),
  posted BOOLEAN DEFAULT false,
  posted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_journal_entries_merchant ON journal_entries(merchant_id, entry_date DESC);
CREATE INDEX idx_journal_entries_posted ON journal_entries(posted);

-- ============================================
-- TERMINAL / POS
-- ============================================

-- Terminal Locations
CREATE TABLE IF NOT EXISTS terminal_locations (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  display_name VARCHAR(255) NOT NULL,
  address JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_terminal_locations_merchant ON terminal_locations(merchant_id);

-- Terminal Readers
CREATE TABLE IF NOT EXISTS terminal_readers (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  location_id VARCHAR(100) NOT NULL REFERENCES terminal_locations(id),
  label VARCHAR(255) NOT NULL,
  serial_number VARCHAR(100) UNIQUE NOT NULL,
  device_type VARCHAR(50) NOT NULL, -- bbpos_wisepos_e, stripe_m2, etc.
  status VARCHAR(20) DEFAULT 'offline', -- online, offline
  ip_address VARCHAR(45),
  device_sw_version VARCHAR(50),
  last_seen_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_terminal_readers_merchant ON terminal_readers(merchant_id);
CREATE INDEX idx_terminal_readers_location ON terminal_readers(location_id);
CREATE INDEX idx_terminal_readers_status ON terminal_readers(status);

-- Terminal Connection Tokens
CREATE TABLE IF NOT EXISTS terminal_connection_tokens (
  secret VARCHAR(255) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  location_id VARCHAR(100) REFERENCES terminal_locations(id),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Terminal Payment Intents
CREATE TABLE IF NOT EXISTS terminal_payment_intents (
  id VARCHAR(100) PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(30) DEFAULT 'requires_payment_method',
  capture_method VARCHAR(20) DEFAULT 'automatic', -- automatic, manual
  statement_descriptor VARCHAR(22),
  receipt_email VARCHAR(255),
  payment_method JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_terminal_pi_merchant ON terminal_payment_intents(merchant_id, created_at DESC);
CREATE INDEX idx_terminal_pi_status ON terminal_payment_intents(status);

-- Terminal Reader Actions
CREATE TABLE IF NOT EXISTS terminal_reader_actions (
  id VARCHAR(100) PRIMARY KEY,
  reader_id VARCHAR(100) NOT NULL REFERENCES terminal_readers(id),
  type VARCHAR(50) NOT NULL, -- process_payment_intent, set_reader_display, refund_payment
  status VARCHAR(20) DEFAULT 'in_progress', -- in_progress, succeeded, failed
  payment_intent_id VARCHAR(100),
  display_cart JSONB,
  failure_code VARCHAR(50),
  failure_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_terminal_actions_reader ON terminal_reader_actions(reader_id, created_at DESC);

-- Terminal Refunds
CREATE TABLE IF NOT EXISTS terminal_refunds (
  id VARCHAR(100) PRIMARY KEY,
  payment_intent_id VARCHAR(100) NOT NULL REFERENCES terminal_payment_intents(id),
  amount BIGINT NOT NULL,
  status VARCHAR(20) DEFAULT 'succeeded',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_terminal_refunds_pi ON terminal_refunds(payment_intent_id);
`;
