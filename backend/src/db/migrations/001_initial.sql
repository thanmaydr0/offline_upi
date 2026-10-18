CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rooted INTEGER NOT NULL DEFAULT 0 CHECK (rooted IN (0, 1)),
  integrity_is_device INTEGER NOT NULL DEFAULT 1 CHECK (integrity_is_device IN (0, 1)),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
  ledger_head_hash TEXT,
  ledger_counter INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  payee_vpa TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE kyc (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  started_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  amount_inr_paise INTEGER NOT NULL CHECK (amount_inr_paise > 0),
  funded_usdc_amount TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'failed', 'funded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vouchers (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  inr_paise INTEGER NOT NULL CHECK (inr_paise > 0),
  usdc_amount TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'spent', 'settled', 'rejected')),
  created_at INTEGER NOT NULL
);

CREATE TABLE received_items (
  id TEXT PRIMARY KEY,
  payee_device_id TEXT NOT NULL REFERENCES devices(id),
  voucher_id TEXT NOT NULL,
  payer_device_address TEXT NOT NULL,
  inr_paise INTEGER NOT NULL CHECK (inr_paise > 0),
  proof_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'rejected')),
  created_at INTEGER NOT NULL
);

CREATE TABLE settlement_items (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL,
  voucher_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  payee_device_id TEXT REFERENCES devices(id),
  inr_paise INTEGER NOT NULL CHECK (inr_paise > 0),
  status INTEGER NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 8),
  created_at INTEGER NOT NULL
);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  amount_inr_paise INTEGER NOT NULL CHECK (amount_inr_paise > 0),
  vpa TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
  gateway_reference TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_device_id TEXT REFERENCES devices(id),
  event_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE double_spend_attempts (
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES devices(id),
  voucher_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  result TEXT NOT NULL CHECK (result IN ('paid', 'failed')),
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE INDEX devices_user_id_idx ON devices(user_id);
CREATE INDEX devices_revoked_idx ON devices(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX orders_device_created_idx ON orders(device_id, created_at DESC);
CREATE INDEX vouchers_device_status_idx ON vouchers(device_id, status);
CREATE INDEX vouchers_order_idx ON vouchers(order_id);
CREATE INDEX received_payee_status_idx ON received_items(payee_device_id, status);
CREATE INDEX settlement_device_status_idx ON settlement_items(device_id, status);
CREATE INDEX payouts_user_created_idx ON payouts(user_id, created_at DESC);
CREATE INDEX audit_created_idx ON audit_log(created_at DESC);
CREATE INDEX double_spend_device_idx ON double_spend_attempts(device_id, created_at DESC);
