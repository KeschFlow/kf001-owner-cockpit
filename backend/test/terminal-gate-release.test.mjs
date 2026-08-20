import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(path.join(here, '..', 'migrations', '0009_release_terminal_owner_gate.sql'), 'utf8');

test('terminal cases are released from active Owner Gate 1', () => {
  assert.match(migration, /status IN \('DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED'\)/);
  assert.match(migration, /SET is_active = 0/);
  assert.match(migration, /trg_cases_release_terminal_after_update/);
  assert.match(migration, /trg_cases_release_terminal_after_insert/);
});
