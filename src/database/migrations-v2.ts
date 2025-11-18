// Additional migrations for v2 features
export const migrationsV2 = [
  {
    version: 12,
    name: 'create_plans_table',
    up: `
      CREATE TABLE IF NOT EXISTS plans (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        amount BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        interval VARCHAR(20) NOT NULL,
        interval_count INT DEFAULT 1,
        trial_period_days INT,
        features JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_plans_merchant_id ON plans(merchant_id);
    `,
    down: `DROP TABLE IF EXISTS plans;`,
  },
  {
    version: 13,
    name: 'create_subscriptions_table',
    up: `
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        plan_id UUID NOT NULL REFERENCES plans(id),
        status VARCHAR(50) DEFAULT 'active',
        quantity INT DEFAULT 1,
        current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
        current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
        cancel_at_period_end BOOLEAN DEFAULT false,
        canceled_at TIMESTAMP WITH TIME ZONE,
        trial_start TIMESTAMP WITH TIME ZONE,
        trial_end TIMESTAMP WITH TIME ZONE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_subscriptions_merchant_id ON subscriptions(merchant_id);
      CREATE INDEX idx_subscriptions_customer_id ON subscriptions(customer_id);
      CREATE INDEX idx_subscriptions_status ON subscriptions(status);
    `,
    down: `DROP TABLE IF EXISTS subscriptions;`,
  },
  {
    version: 14,
    name: 'create_coupons_table',
    up: `
      CREATE TABLE IF NOT EXISTS coupons (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        code VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        discount_type VARCHAR(20) NOT NULL,
        discount_value BIGINT NOT NULL,
        currency VARCHAR(3),
        max_redemptions INT,
        times_redeemed INT DEFAULT 0,
        expires_at TIMESTAMP WITH TIME ZONE,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(merchant_id, code)
      );
      CREATE INDEX idx_coupons_merchant_id ON coupons(merchant_id);
      CREATE INDEX idx_coupons_code ON coupons(code);
    `,
    down: `DROP TABLE IF EXISTS coupons;`,
  },
  {
    version: 15,
    name: 'create_crypto_payments_table',
    up: `
      CREATE TABLE IF NOT EXISTS crypto_payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        customer_id UUID REFERENCES customers(id),
        transaction_id UUID NOT NULL REFERENCES transactions(id),
        status VARCHAR(50) DEFAULT 'pending',
        cryptocurrency VARCHAR(10) NOT NULL,
        network VARCHAR(50) NOT NULL,
        amount BIGINT NOT NULL,
        crypto_amount VARCHAR(50) NOT NULL,
        exchange_rate DECIMAL(20, 8) NOT NULL,
        wallet_address VARCHAR(255) NOT NULL,
        tx_hash VARCHAR(255),
        confirmations INT DEFAULT 0,
        required_confirmations INT DEFAULT 1,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        paid_at TIMESTAMP WITH TIME ZONE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_crypto_payments_merchant_id ON crypto_payments(merchant_id);
      CREATE INDEX idx_crypto_payments_status ON crypto_payments(status);
      CREATE INDEX idx_crypto_payments_wallet ON crypto_payments(wallet_address);
      CREATE INDEX idx_crypto_payments_tx_hash ON crypto_payments(tx_hash);
    `,
    down: `DROP TABLE IF EXISTS crypto_payments;`,
  },
  {
    version: 16,
    name: 'create_crypto_wallets_table',
    up: `
      CREATE TABLE IF NOT EXISTS crypto_wallets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        network VARCHAR(50) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        address VARCHAR(255) NOT NULL,
        label VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(merchant_id, network, currency)
      );
      CREATE INDEX idx_crypto_wallets_merchant_id ON crypto_wallets(merchant_id);
    `,
    down: `DROP TABLE IF EXISTS crypto_wallets;`,
  },
  {
    version: 17,
    name: 'create_fraud_checks_table',
    up: `
      CREATE TABLE IF NOT EXISTS fraud_checks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        transaction_id UUID NOT NULL REFERENCES transactions(id),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        risk_score INT NOT NULL,
        risk_level VARCHAR(20) NOT NULL,
        action VARCHAR(20) NOT NULL,
        signals JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_fraud_checks_transaction_id ON fraud_checks(transaction_id);
      CREATE INDEX idx_fraud_checks_merchant_id ON fraud_checks(merchant_id);
    `,
    down: `DROP TABLE IF EXISTS fraud_checks;`,
  },
  {
    version: 18,
    name: 'create_fraud_rules_table',
    up: `
      CREATE TABLE IF NOT EXISTS fraud_rules (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        conditions JSONB NOT NULL,
        action VARCHAR(20) NOT NULL,
        priority INT DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_fraud_rules_merchant_id ON fraud_rules(merchant_id);
    `,
    down: `DROP TABLE IF EXISTS fraud_rules;`,
  },
  {
    version: 19,
    name: 'create_blocklist_table',
    up: `
      CREATE TABLE IF NOT EXISTS blocklist (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        value VARCHAR(255) NOT NULL,
        reason TEXT,
        expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_blocklist_merchant_id ON blocklist(merchant_id);
      CREATE INDEX idx_blocklist_type_value ON blocklist(type, value);
    `,
    down: `DROP TABLE IF EXISTS blocklist;`,
  },
  {
    version: 20,
    name: 'create_invoices_table',
    up: `
      CREATE TABLE IF NOT EXISTS invoices (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        customer_id UUID NOT NULL REFERENCES customers(id),
        subscription_id UUID REFERENCES subscriptions(id),
        number VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'draft',
        currency VARCHAR(3) NOT NULL,
        subtotal BIGINT NOT NULL,
        tax_amount BIGINT DEFAULT 0,
        total BIGINT NOT NULL,
        amount_paid BIGINT DEFAULT 0,
        amount_due BIGINT NOT NULL,
        line_items JSONB NOT NULL,
        due_date TIMESTAMP WITH TIME ZONE,
        paid_at TIMESTAMP WITH TIME ZONE,
        voided_at TIMESTAMP WITH TIME ZONE,
        notes TEXT,
        footer TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_invoices_merchant_id ON invoices(merchant_id);
      CREATE INDEX idx_invoices_customer_id ON invoices(customer_id);
      CREATE INDEX idx_invoices_status ON invoices(status);
      CREATE INDEX idx_invoices_number ON invoices(number);
    `,
    down: `DROP TABLE IF EXISTS invoices;`,
  },
  {
    version: 21,
    name: 'create_payment_links_table',
    up: `
      CREATE TABLE IF NOT EXISTS payment_links (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        url VARCHAR(500) NOT NULL,
        amount BIGINT,
        currency VARCHAR(3) NOT NULL,
        description TEXT,
        active BOOLEAN DEFAULT true,
        expires_at TIMESTAMP WITH TIME ZONE,
        max_redemptions INT,
        times_redeemed INT DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_payment_links_merchant_id ON payment_links(merchant_id);
    `,
    down: `DROP TABLE IF EXISTS payment_links;`,
  },
  {
    version: 22,
    name: 'create_connected_accounts_table',
    up: `
      CREATE TABLE IF NOT EXISTS connected_accounts (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        business_name VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        payout_schedule VARCHAR(50) DEFAULT 'weekly',
        commission_rate DECIMAL(5, 2) DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX idx_connected_accounts_merchant_id ON connected_accounts(merchant_id);
    `,
    down: `DROP TABLE IF EXISTS connected_accounts;`,
  },
  {
    version: 23,
    name: 'add_subscription_triggers',
    up: `
      CREATE TRIGGER update_plans_updated_at BEFORE UPDATE ON plans
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON invoices
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `,
    down: `
      DROP TRIGGER IF EXISTS update_plans_updated_at ON plans;
      DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
      DROP TRIGGER IF EXISTS update_invoices_updated_at ON invoices;
    `,
  },
];
