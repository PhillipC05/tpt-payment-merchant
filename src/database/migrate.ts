import { getPool, closePool } from './connection';
import { logger } from '../utils/logger';

const migrations = [
  {
    version: 1,
    name: 'create_merchants_table',
    up: `
      CREATE TABLE IF NOT EXISTS merchants (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        business_name VARCHAR(255) NOT NULL,
        business_type VARCHAR(100) NOT NULL,
        tax_id VARCHAR(100),
        status merchant_status DEFAULT 'pending',
        api_key_hash VARCHAR(255),
        webhook_url VARCHAR(500),
        webhook_secret VARCHAR(255),
        settings JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_merchants_email ON merchants(email);
      CREATE INDEX idx_merchants_status ON merchants(status);
      CREATE INDEX idx_merchants_api_key_hash ON merchants(api_key_hash);
    `,
    down: `DROP TABLE IF EXISTS merchants;`,
  },
  {
    version: 2,
    name: 'create_customers_table',
    up: `
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        phone VARCHAR(50),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(merchant_id, email)
      );

      CREATE INDEX idx_customers_merchant_id ON customers(merchant_id);
      CREATE INDEX idx_customers_email ON customers(email);
    `,
    down: `DROP TABLE IF EXISTS customers;`,
  },
  {
    version: 3,
    name: 'create_payment_methods_table',
    up: `
      CREATE TABLE IF NOT EXISTS payment_methods (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        type payment_method_type NOT NULL,
        is_default BOOLEAN DEFAULT false,
        details JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_payment_methods_customer_id ON payment_methods(customer_id);
    `,
    down: `DROP TABLE IF EXISTS payment_methods;`,
  },
  {
    version: 4,
    name: 'create_transactions_table',
    up: `
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        customer_id UUID REFERENCES customers(id),
        payment_method_id UUID REFERENCES payment_methods(id),
        type VARCHAR(50) NOT NULL,
        status transaction_status DEFAULT 'pending',
        amount BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        fee BIGINT DEFAULT 0,
        net_amount BIGINT NOT NULL,
        description TEXT,
        statement_descriptor VARCHAR(22),
        metadata JSONB DEFAULT '{}',
        gateway_reference VARCHAR(255),
        gateway_response JSONB,
        error_code VARCHAR(100),
        error_message TEXT,
        refunded_amount BIGINT DEFAULT 0,
        idempotency_key VARCHAR(255),
        captured_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_transactions_merchant_id ON transactions(merchant_id);
      CREATE INDEX idx_transactions_customer_id ON transactions(customer_id);
      CREATE INDEX idx_transactions_status ON transactions(status);
      CREATE INDEX idx_transactions_created_at ON transactions(created_at);
      CREATE INDEX idx_transactions_idempotency_key ON transactions(idempotency_key);
      CREATE INDEX idx_transactions_gateway_reference ON transactions(gateway_reference);
    `,
    down: `DROP TABLE IF EXISTS transactions;`,
  },
  {
    version: 5,
    name: 'create_payouts_table',
    up: `
      CREATE TABLE IF NOT EXISTS payouts (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        status payout_status DEFAULT 'pending',
        amount BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        fee BIGINT DEFAULT 0,
        net_amount BIGINT NOT NULL,
        bank_account_id VARCHAR(255),
        transaction_ids UUID[] DEFAULT '{}',
        period_start TIMESTAMP WITH TIME ZONE NOT NULL,
        period_end TIMESTAMP WITH TIME ZONE NOT NULL,
        arrived_at TIMESTAMP WITH TIME ZONE,
        failure_reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_payouts_merchant_id ON payouts(merchant_id);
      CREATE INDEX idx_payouts_status ON payouts(status);
      CREATE INDEX idx_payouts_created_at ON payouts(created_at);
    `,
    down: `DROP TABLE IF EXISTS payouts;`,
  },
  {
    version: 6,
    name: 'create_webhook_events_table',
    up: `
      CREATE TABLE IF NOT EXISTS webhook_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        type VARCHAR(100) NOT NULL,
        status webhook_status DEFAULT 'pending',
        payload JSONB NOT NULL,
        attempts INT DEFAULT 0,
        last_attempt_at TIMESTAMP WITH TIME ZONE,
        delivered_at TIMESTAMP WITH TIME ZONE,
        next_retry_at TIMESTAMP WITH TIME ZONE,
        response TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_webhook_events_merchant_id ON webhook_events(merchant_id);
      CREATE INDEX idx_webhook_events_status ON webhook_events(status);
      CREATE INDEX idx_webhook_events_next_retry ON webhook_events(next_retry_at);
    `,
    down: `DROP TABLE IF EXISTS webhook_events;`,
  },
  {
    version: 7,
    name: 'create_api_keys_table',
    up: `
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        key_prefix VARCHAR(20) NOT NULL,
        key_hash VARCHAR(255) NOT NULL,
        permissions TEXT[] DEFAULT '{}',
        last_used_at TIMESTAMP WITH TIME ZONE,
        expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_api_keys_merchant_id ON api_keys(merchant_id);
      CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
    `,
    down: `DROP TABLE IF EXISTS api_keys;`,
  },
  {
    version: 8,
    name: 'create_disputes_table',
    up: `
      CREATE TABLE IF NOT EXISTS disputes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        transaction_id UUID NOT NULL REFERENCES transactions(id),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        status VARCHAR(50) DEFAULT 'open',
        reason VARCHAR(100) NOT NULL,
        amount BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        evidence JSONB DEFAULT '{}',
        due_by TIMESTAMP WITH TIME ZONE NOT NULL,
        resolved_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_disputes_transaction_id ON disputes(transaction_id);
      CREATE INDEX idx_disputes_merchant_id ON disputes(merchant_id);
      CREATE INDEX idx_disputes_status ON disputes(status);
    `,
    down: `DROP TABLE IF EXISTS disputes;`,
  },
  {
    version: 9,
    name: 'create_balances_table',
    up: `
      CREATE TABLE IF NOT EXISTS balances (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        currency VARCHAR(3) NOT NULL,
        available BIGINT DEFAULT 0,
        pending BIGINT DEFAULT 0,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(merchant_id, currency)
      );

      CREATE INDEX idx_balances_merchant_id ON balances(merchant_id);
    `,
    down: `DROP TABLE IF EXISTS balances;`,
  },
  {
    version: 10,
    name: 'create_audit_logs_table',
    up: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(100) NOT NULL,
        entity_id UUID,
        old_values JSONB,
        new_values JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX idx_audit_logs_merchant_id ON audit_logs(merchant_id);
      CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
      CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
    `,
    down: `DROP TABLE IF EXISTS audit_logs;`,
  },
  {
    version: 11,
    name: 'create_updated_at_trigger',
    up: `
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql';

      CREATE TRIGGER update_merchants_updated_at BEFORE UPDATE ON merchants
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      CREATE TRIGGER update_payouts_updated_at BEFORE UPDATE ON payouts
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      CREATE TRIGGER update_disputes_updated_at BEFORE UPDATE ON disputes
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `,
    down: `
      DROP TRIGGER IF EXISTS update_merchants_updated_at ON merchants;
      DROP TRIGGER IF EXISTS update_customers_updated_at ON customers;
      DROP TRIGGER IF EXISTS update_transactions_updated_at ON transactions;
      DROP TRIGGER IF EXISTS update_payouts_updated_at ON payouts;
      DROP TRIGGER IF EXISTS update_disputes_updated_at ON disputes;
      DROP FUNCTION IF EXISTS update_updated_at_column();
    `,
  },
];

async function ensureMigrationsTable(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}

async function getExecutedMigrations(pool: any): Promise<number[]> {
  const result = await pool.query('SELECT version FROM migrations ORDER BY version');
  return result.rows.map((row: any) => row.version);
}

async function runMigrations() {
  const pool = await getPool();

  try {
    await ensureMigrationsTable(pool);
    const executed = await getExecutedMigrations(pool);

    for (const migration of migrations) {
      if (!executed.includes(migration.version)) {
        logger.info(`Running migration ${migration.version}: ${migration.name}`);

        await pool.query('BEGIN');
        try {
          await pool.query(migration.up);
          await pool.query(
            'INSERT INTO migrations (version, name) VALUES ($1, $2)',
            [migration.version, migration.name]
          );
          await pool.query('COMMIT');
          logger.info(`Migration ${migration.version} completed`);
        } catch (error) {
          await pool.query('ROLLBACK');
          throw error;
        }
      }
    }

    logger.info('All migrations completed');
  } finally {
    await closePool();
  }
}

async function rollbackMigration() {
  const pool = await getPool();

  try {
    await ensureMigrationsTable(pool);
    const executed = await getExecutedMigrations(pool);

    if (executed.length === 0) {
      logger.info('No migrations to rollback');
      return;
    }

    const lastVersion = Math.max(...executed);
    const migration = migrations.find(m => m.version === lastVersion);

    if (!migration) {
      throw new Error(`Migration ${lastVersion} not found`);
    }

    logger.info(`Rolling back migration ${migration.version}: ${migration.name}`);

    await pool.query('BEGIN');
    try {
      await pool.query(migration.down);
      await pool.query('DELETE FROM migrations WHERE version = $1', [lastVersion]);
      await pool.query('COMMIT');
      logger.info(`Rollback of migration ${migration.version} completed`);
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } finally {
    await closePool();
  }
}

// CLI handling
const command = process.argv[2];

if (command === 'rollback') {
  rollbackMigration().catch(error => {
    logger.error('Rollback failed', { error: error.message });
    process.exit(1);
  });
} else {
  runMigrations().catch(error => {
    logger.error('Migration failed', { error: error.message });
    process.exit(1);
  });
}
