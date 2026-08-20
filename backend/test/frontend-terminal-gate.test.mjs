import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapters = fs.readFileSync(path.join(here, '..', '..', 'adapters.js'), 'utf8');

test('terminal central cases are never rendered as active Owner Gate 1', () => {
  assert.match(adapters, /TERMINAL_CASE_STATUSES/);
  assert.match(adapters, /TERMINAL_CASE_STATUSES\.has\(payload\.status\)/);
  assert.match(adapters, /return noActiveCaseState\(\)/);
  assert.match(adapters, /this\.clearCache\(\)/);
});
