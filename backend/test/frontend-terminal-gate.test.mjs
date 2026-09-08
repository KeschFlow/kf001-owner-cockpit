import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapters = fs.readFileSync(path.join(here, '..', '..', 'adapters.js'), 'utf8');
const governance = fs.readFileSync(path.join(here, '..', '..', 'governance.js'), 'utf8');
const slimOwnerUi = fs.readFileSync(path.join(here, '..', '..', 'slim-owner-ui.js'), 'utf8');

test('terminal central cases are never rendered as active Owner Gate 1', () => {
  assert.match(adapters, /TERMINAL_CASE_STATUSES/);
  assert.match(adapters, /TERMINAL_CASE_STATUSES\.has\(payload\.status\)/);
  assert.match(adapters, /return noActiveCaseState\(\)/);
  assert.match(adapters, /this\.clearCache\(\)/);
});

test('owner cockpit renders only an authoritative active case as Active Work Item', () => {
  assert.match(governance, /centralRead && ownerState\.caseId && decisionStillOpen\(\)/);
  assert.match(governance, /container\.dataset\.workItemCaseId = hasAuthoritativeWorkItem \? String\(ownerState\.caseId\) : ''/);
  assert.match(governance, /container\.dataset\.workItemStatus = hasAuthoritativeWorkItem \? String\(ownerState\.status\) : ''/);
  assert.match(governance, /container\.dataset\.workItemVersion/);
  assert.match(governance, /container\.dataset\.workItemUpdatedAt/);
  assert.match(slimOwnerUi, /ACTIVE WORK ITEM/);
  assert.match(slimOwnerUi, /NO ACTIVE WORK ITEM/);
  assert.match(slimOwnerUi, /workItemState === 'active'/);
  assert.match(slimOwnerUi, /openCase\?\.classList\.toggle\('hidden', !hasActiveWorkItem\)/);
  assert.match(governance, /id="approveIntentBtn"/);
  assert.match(governance, /id="rejectIntentBtn"/);
});
