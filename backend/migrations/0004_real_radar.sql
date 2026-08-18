CREATE TABLE IF NOT EXISTS radar_candidates (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  public_case_id TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_excerpt TEXT NOT NULL,
  author_login TEXT,
  author_name TEXT,
  contact_email TEXT,
  contact_route TEXT,
  impact_score INTEGER NOT NULL,
  evidence_score INTEGER NOT NULL,
  case_value_score INTEGER NOT NULL,
  amount_signal REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  promoted_at TEXT,
  PRIMARY KEY (source, external_id)
);

CREATE TABLE IF NOT EXISTS radar_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  contactable_count INTEGER NOT NULL DEFAULT 0,
  promoted_case_id TEXT,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_radar_candidates_score
  ON radar_candidates(case_value_score DESC, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_radar_candidates_status
  ON radar_candidates(status, contact_email);
