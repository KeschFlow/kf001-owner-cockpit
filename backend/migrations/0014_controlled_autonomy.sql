CREATE TABLE IF NOT EXISTS autonomy_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  outreach_enabled INTEGER NOT NULL DEFAULT 1 CHECK (outreach_enabled IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO autonomy_control (id, outreach_enabled, updated_by, updated_at)
VALUES (1, 1, 'SYSTEM_BOOTSTRAP', CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS outreach_suppression (
  email_normalized TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  public_case_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS autonomy_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_case_id TEXT,
  event_type TEXT NOT NULL,
  decision TEXT,
  message_hash TEXT,
  recipient_hash TEXT,
  provider_message_id TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_autonomy_audit_no_update
BEFORE UPDATE ON autonomy_audit_log
BEGIN
  SELECT RAISE(ABORT, 'AUTONOMY_AUDIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_autonomy_audit_no_delete
BEFORE DELETE ON autonomy_audit_log
BEGIN
  SELECT RAISE(ABORT, 'AUTONOMY_AUDIT_IMMUTABLE');
END;

ALTER TABLE revenue_autopilot ADD COLUMN outbound_contact_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE revenue_autopilot ADD COLUMN follow_up_sent_at TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN next_follow_up_at TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN owner_attention_reason TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN auto_decision TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN checkout_public_token TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN checkout_view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE revenue_autopilot ADD COLUMN checkout_first_view_at TEXT;
ALTER TABLE revenue_autopilot ADD COLUMN checkout_last_view_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_checkout_public_token
  ON revenue_autopilot(checkout_public_token)
  WHERE checkout_public_token IS NOT NULL;
