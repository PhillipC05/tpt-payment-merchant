// Migrations for Compliance & Security
// Includes: Audit Logs, Privacy, 3DS, Encryption Keys, SARs, Reconciliation

export const migrationsCompliance = `
-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  category VARCHAR(50) NOT NULL,
  action VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  actor_id UUID,
  actor_type VARCHAR(50) NOT NULL,
  actor_email VARCHAR(255),
  merchant_id UUID,
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  ip_address VARCHAR(45),
  user_agent TEXT,
  request_id VARCHAR(100),
  success BOOLEAN NOT NULL,
  error_message TEXT,
  metadata JSONB,
  changes JSONB
);

CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_logs_merchant ON audit_logs(merchant_id, timestamp DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, timestamp DESC);
CREATE INDEX idx_audit_logs_category ON audit_logs(category, action);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- 3D Secure Authentications
CREATE TABLE IF NOT EXISTS three_ds_authentications (
  id UUID PRIMARY KEY,
  transaction_id UUID NOT NULL,
  version VARCHAR(10) NOT NULL,
  status VARCHAR(50) NOT NULL,
  transaction_status VARCHAR(1),
  eci VARCHAR(2),
  cavv VARCHAR(50),
  xid VARCHAR(50),
  ds_transaction_id UUID,
  acs_url TEXT,
  acs_transaction_id UUID,
  challenge_required BOOLEAN DEFAULT false,
  risk_score INTEGER,
  exemption_applied VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX idx_3ds_transaction ON three_ds_authentications(transaction_id);
CREATE INDEX idx_3ds_status ON three_ds_authentications(status);

-- Privacy Requests (GDPR/CCPA)
CREATE TABLE IF NOT EXISTS privacy_requests (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  subject_id UUID NOT NULL,
  subject_email VARCHAR(255) NOT NULL,
  request_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  regulation VARCHAR(20) DEFAULT 'gdpr',
  verification_token UUID,
  verified_at TIMESTAMP,
  processed_data JSONB,
  denial_reason TEXT,
  due_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX idx_privacy_requests_merchant ON privacy_requests(merchant_id, status);
CREATE INDEX idx_privacy_requests_subject ON privacy_requests(subject_id);

-- Consent Records
CREATE TABLE IF NOT EXISTS consent_records (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  subject_id UUID NOT NULL,
  subject_email VARCHAR(255) NOT NULL,
  consent_type VARCHAR(100) NOT NULL,
  version VARCHAR(50) NOT NULL,
  granted BOOLEAN NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP
);

CREATE INDEX idx_consent_subject ON consent_records(subject_id, consent_type);
CREATE INDEX idx_consent_merchant ON consent_records(merchant_id);

-- Data Retention Policies
CREATE TABLE IF NOT EXISTS data_retention_policies (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  data_type VARCHAR(100) NOT NULL,
  retention_days INTEGER NOT NULL,
  legal_basis TEXT NOT NULL,
  auto_delete BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(merchant_id, data_type)
);

-- Legal Holds
CREATE TABLE IF NOT EXISTS legal_holds (
  id UUID PRIMARY KEY,
  subject_id UUID NOT NULL,
  reason TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  released_at TIMESTAMP
);

CREATE INDEX idx_legal_holds_subject ON legal_holds(subject_id, active);

-- Suspicious Activity Reports (SARs)
CREATE TABLE IF NOT EXISTS suspicious_activity_reports (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  subject_id UUID NOT NULL,
  subject_type VARCHAR(50) NOT NULL,
  subject_name VARCHAR(255) NOT NULL,
  reason VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  transaction_ids JSONB NOT NULL,
  total_amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(50) DEFAULT 'draft',
  filing_reference VARCHAR(100),
  filed_by VARCHAR(255),
  filed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sar_merchant ON suspicious_activity_reports(merchant_id, status);
CREATE INDEX idx_sar_subject ON suspicious_activity_reports(subject_id);

-- Reconciliation Records
CREATE TABLE IF NOT EXISTS reconciliation_records (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  reconciliation_type VARCHAR(50) NOT NULL,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  expected_amount BIGINT NOT NULL,
  actual_amount BIGINT NOT NULL,
  discrepancy BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  transaction_count INTEGER NOT NULL,
  matched_count INTEGER NOT NULL,
  unmatched_transactions JSONB,
  notes TEXT,
  reconciled_by VARCHAR(255),
  reconciled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reconciliation_merchant ON reconciliation_records(merchant_id, period_start DESC);
CREATE INDEX idx_reconciliation_status ON reconciliation_records(status);

-- Encryption Key Metadata
CREATE TABLE IF NOT EXISTS encryption_keys (
  id VARCHAR(100) PRIMARY KEY,
  key_type VARCHAR(50) NOT NULL,
  version INTEGER NOT NULL,
  encrypted_key TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  rotated_at TIMESTAMP
);

CREATE INDEX idx_encryption_keys_type ON encryption_keys(key_type, is_active);

-- Sessions (for retention policy)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID,
  merchant_id UUID,
  token_hash VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  last_activity TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);

-- Add last_activity to customers for retention
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP DEFAULT NOW();

-- Blocked IPs
CREATE TABLE IF NOT EXISTS blocked_ips (
  ip_address VARCHAR(45) PRIMARY KEY,
  reason VARCHAR(255),
  blocked_by VARCHAR(255),
  blocked_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

-- Rate Limit Violations
CREATE TABLE IF NOT EXISTS rate_limit_violations (
  id UUID PRIMARY KEY,
  ip_address VARCHAR(45) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  violations INTEGER NOT NULL,
  first_violation TIMESTAMP NOT NULL,
  last_violation TIMESTAMP NOT NULL
);

CREATE INDEX idx_rate_limit_ip ON rate_limit_violations(ip_address);

-- Security Events Summary
CREATE TABLE IF NOT EXISTS security_events_summary (
  id UUID PRIMARY KEY,
  date DATE NOT NULL,
  merchant_id UUID REFERENCES merchants(id),
  event_type VARCHAR(100) NOT NULL,
  count INTEGER NOT NULL,
  metadata JSONB,
  UNIQUE(date, merchant_id, event_type)
);

CREATE INDEX idx_security_events_date ON security_events_summary(date DESC);
`;
