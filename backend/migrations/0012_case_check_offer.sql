ALTER TABLE revenue_autopilot ADD COLUMN offer_type TEXT NOT NULL DEFAULT 'SUCCESS_FEE';
ALTER TABLE revenue_autopilot ADD COLUMN fixed_offer_amount_cents INTEGER;

CREATE INDEX IF NOT EXISTS idx_revenue_autopilot_offer_type
  ON revenue_autopilot(offer_type, stage, updated_at);
