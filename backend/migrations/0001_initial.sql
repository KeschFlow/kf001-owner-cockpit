CREATE TABLE IF NOT EXISTS cases (
  public_case_id TEXT PRIMARY KEY,
  case_value_score INTEGER CHECK (case_value_score IS NULL OR (case_value_score BETWEEN 0 AND 100)),
  outreach_ready INTEGER NOT NULL CHECK (outreach_ready IN (0, 1)),
  impact_class TEXT NOT NULL,
  evidence_quality TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  outreach_message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'PENDING_APPROVAL',
    'APPROVED_PENDING_DISPATCH',
    'DISPATCHED',
    'RESPONSE_RECEIVED',
    'REJECTED'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_single_active
  ON cases(is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_case_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (public_case_id) REFERENCES cases(public_case_id)
);

CREATE INDEX IF NOT EXISTS idx_state_events_case_time
  ON state_events(public_case_id, created_at DESC);

INSERT OR IGNORE INTO cases (
  public_case_id,
  case_value_score,
  outreach_ready,
  impact_class,
  evidence_quality,
  recommendation,
  outreach_message,
  status,
  version,
  is_active,
  updated_at
) VALUES (
  'PUB-001',
  NULL,
  1,
  'HOCH',
  'PRIVATE / NOT EXPOSED',
  'APPROVE OUTREACH',
  'Anonymisierte Erstkontakt-Nachricht ist vorbereitet. Empfänger, Falldetails, Beweise und Konditionen verbleiben ausschließlich im privaten System.',
  'PENDING_APPROVAL',
  1,
  1,
  CURRENT_TIMESTAMP
);

INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
SELECT 'PUB-001', 'BASELINE_MIGRATED', 'PENDING_APPROVAL', 'PUBLIC_ANONYMIZED_BASELINE', CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM state_events
  WHERE public_case_id = 'PUB-001' AND event_type = 'BASELINE_MIGRATED'
);
