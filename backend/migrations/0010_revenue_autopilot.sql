CREATE TABLE IF NOT EXISTS revenue_autopilot (
  public_case_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  economic_score INTEGER NOT NULL DEFAULT 0,
  amount_approx_usd REAL NOT NULL DEFAULT 0,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  subject TEXT,
  initial_message_id TEXT,
  gmail_thread_id TEXT,
  initial_sent_at TEXT,
  last_inbound_message_id TEXT,
  last_inbound_at TEXT,
  last_reply_class TEXT,
  terms_sent_at TEXT,
  engagement_accepted_at TEXT,
  evidence_received_at TEXT,
  success_confirmed_at TEXT,
  recovered_approx_usd REAL NOT NULL DEFAULT 0,
  payment_requested_at TEXT,
  payment_status TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (public_case_id) REFERENCES cases(public_case_id)
);

CREATE TABLE IF NOT EXISTS revenue_autopilot_quota (
  quota_day TEXT PRIMARY KEY,
  sent_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_autopilot_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lock_token TEXT,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO revenue_autopilot_lock (id, lock_token, locked_until, updated_at)
VALUES (1, NULL, NULL, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_revenue_autopilot_stage
  ON revenue_autopilot(stage, updated_at);
