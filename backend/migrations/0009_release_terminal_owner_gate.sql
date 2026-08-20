-- Terminal cases are history, not current Owner Gate 1 work.
-- Keep the record, but never leave a terminal case as the single active gate.

UPDATE cases
SET is_active = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE is_active = 1
  AND status IN ('DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED');

CREATE TRIGGER IF NOT EXISTS trg_cases_release_terminal_after_update
AFTER UPDATE OF status ON cases
WHEN NEW.is_active = 1
 AND NEW.status IN ('DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED')
BEGIN
  UPDATE cases
     SET is_active = 0,
         updated_at = CURRENT_TIMESTAMP
   WHERE public_case_id = NEW.public_case_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_cases_release_terminal_after_insert
AFTER INSERT ON cases
WHEN NEW.is_active = 1
 AND NEW.status IN ('DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED')
BEGIN
  UPDATE cases
     SET is_active = 0,
         updated_at = CURRENT_TIMESTAMP
   WHERE public_case_id = NEW.public_case_id;
END;
