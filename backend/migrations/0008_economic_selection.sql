CREATE TABLE IF NOT EXISTS case_economic_scores (
  public_case_id TEXT PRIMARY KEY,
  economic_score INTEGER NOT NULL CHECK (economic_score BETWEEN 0 AND 100),
  economically_qualified INTEGER NOT NULL CHECK (economically_qualified IN (0, 1)),
  solvability_score INTEGER NOT NULL CHECK (solvability_score BETWEEN 0 AND 100),
  payer_probability_score INTEGER NOT NULL CHECK (payer_probability_score BETWEEN 0 AND 100),
  reachability_score INTEGER NOT NULL CHECK (reachability_score BETWEEN 0 AND 100),
  evidence_score INTEGER NOT NULL CHECK (evidence_score BETWEEN 0 AND 100),
  platform_ack_score INTEGER NOT NULL CHECK (platform_ack_score BETWEEN 0 AND 100),
  recoverable_value_score INTEGER NOT NULL CHECK (recoverable_value_score BETWEEN 0 AND 100),
  effort_score INTEGER NOT NULL CHECK (effort_score BETWEEN 0 AND 100),
  uncertainty_score INTEGER NOT NULL CHECK (uncertainty_score BETWEEN 0 AND 100),
  proprietary_data_value_score INTEGER NOT NULL CHECK (proprietary_data_value_score BETWEEN 0 AND 100),
  reference_value_score INTEGER NOT NULL CHECK (reference_value_score BETWEEN 0 AND 100),
  amount_currency TEXT,
  amount_native REAL NOT NULL DEFAULT 0,
  amount_approx_usd REAL NOT NULL DEFAULT 0,
  scoring_version TEXT NOT NULL,
  selected_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_economic_scores_rank
  ON case_economic_scores(economically_qualified DESC, economic_score DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_case_economic_scores_selected
  ON case_economic_scores(selected_at DESC)
  WHERE selected_at IS NOT NULL;
