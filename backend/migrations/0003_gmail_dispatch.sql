CREATE TABLE IF NOT EXISTS dispatch_targets (
  public_case_id TEXT PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  subject TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_case_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispatch_log_case
  ON dispatch_log(public_case_id, created_at DESC);
