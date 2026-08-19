UPDATE cases
SET status = 'REJECTED',
    version = version + 1,
    updated_at = datetime('now')
WHERE public_case_id = 'PUB-001'
  AND is_active = 1
  AND status NOT IN ('DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED');

INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
SELECT 'PUB-001', 'LEGACY_TEST_CASE_RETIRED', 'REJECTED', 'SYSTEM_MIGRATION', datetime('now')
WHERE EXISTS (SELECT 1 FROM cases WHERE public_case_id = 'PUB-001')
  AND NOT EXISTS (
    SELECT 1 FROM state_events
    WHERE public_case_id = 'PUB-001'
      AND event_type = 'LEGACY_TEST_CASE_RETIRED'
  );
