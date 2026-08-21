ALTER TABLE revenue_autopilot ADD COLUMN success_fee_percent REAL;
ALTER TABLE revenue_autopilot ADD COLUMN success_fee_min_eur REAL;
ALTER TABLE revenue_autopilot ADD COLUMN success_fee_max_eur REAL;
ALTER TABLE revenue_autopilot ADD COLUMN success_min_recovered_usd REAL;
ALTER TABLE revenue_autopilot ADD COLUMN usd_to_eur_rate REAL;
ALTER TABLE revenue_autopilot ADD COLUMN success_fee_eur_usd_rate REAL;
ALTER TABLE revenue_autopilot ADD COLUMN calculated_fee_eur REAL;
ALTER TABLE revenue_autopilot ADD COLUMN calculated_fee_minor INTEGER;
ALTER TABLE revenue_autopilot ADD COLUMN success_fee_amount_cents INTEGER;
ALTER TABLE revenue_autopilot ADD COLUMN success_fee_currency TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN pricing_version TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN success_event_key TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN stripe_checkout_url TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN stripe_payment_event_id TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN checkout_created_at TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN checkout_creation_attempted_at TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN stripe_checkout_created_at TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN checkout_expires_at TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN payment_confirmed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_autopilot_checkout_session
  ON revenue_autopilot(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_autopilot_success_event
  ON revenue_autopilot(success_event_key)
  WHERE success_event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  public_case_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_case
  ON stripe_webhook_events(public_case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stripe_payments (
  event_id TEXT PRIMARY KEY,
  session_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
