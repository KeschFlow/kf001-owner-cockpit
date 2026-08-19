-- Harden the existing live schema without replacing legacy case/radar tables.
ALTER TABLE webauthn_challenges ADD COLUMN consumed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_active
  ON webauthn_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS dispatch_operations (
  operation_key TEXT PRIMARY KEY,
  public_case_id TEXT NOT NULL,
  approval_version INTEGER NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','SENDING','SENT','FAILED_PRE_SEND','UNKNOWN')),
  claim_token TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (public_case_id) REFERENCES cases(public_case_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_operations_case_status
  ON dispatch_operations(public_case_id, status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_log_provider_message
  ON dispatch_log(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
