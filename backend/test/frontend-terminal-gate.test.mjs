import test from 'node:test';
import { loadSlimUi } from './helpers/slim-ui.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapters = fs.readFileSync(path.join(here, '..', '..', 'adapters.js'), 'utf8');
const governance = fs.readFileSync(path.join(here, '..', '..', 'governance.js'), 'utf8');

test('terminal central cases are never rendered as active Owner Gate 1', () => {
  assert.match(adapters, /TERMINAL_CASE_STATUSES/);
  assert.match(adapters, /TERMINAL_CASE_STATUSES\.has\(payload\.status\)/);
  assert.match(adapters, /return noActiveCaseState\(\)/);
  assert.match(adapters, /this\.clearCache\(\)/);
});

test('owner cockpit shows decision intervention only for an open authoritative backend case', async () => {
  assert.match(governance, /centralRead && ownerState\.caseId && decisionStillOpen\(\)/);
  assert.match(governance, /container\.dataset\.workItemCaseId = hasAuthoritativeWorkItem \? String\(ownerState\.caseId\) : ''/);
  assert.match(governance, /container\.dataset\.workItemStatus = hasAuthoritativeWorkItem \? String\(ownerState\.status\) : ''/);
  assert.match(governance, /container\.dataset\.workItemVersion/);
  assert.match(governance, /container\.dataset\.workItemUpdatedAt/);
  for (const status of ['PENDING_APPROVAL', 'APPROVED_PENDING_DISPATCH']) {
    const ui = await loadSlimUi({owner: {caseId: 'CASE-1', status}});
    assert.equal(ui.get('slimIntervention').hidden, false, status);
    assert.equal(ui.get('slimNoAction').hidden, true, status);
    assert.match(ui.get('slimInterventionText').textContent, /CASE-1/);
    assert.ok(ui.calls.some(c => c.url === 'https://backend.example/v1/owner-state'));
  }
  for (const owner of [
    {noActiveCase: true},
    ...['REJECTED', 'DISPATCHED', 'CLOSED', 'PAID'].map(status => ({caseId: 'CASE-1', status})),
    {status: 'PENDING_APPROVAL'}
  ]) {
    const ui = await loadSlimUi({owner});
    assert.equal(ui.get('slimIntervention').hidden, true, JSON.stringify(owner));
    assert.equal(ui.get('slimNoAction').hidden, false, JSON.stringify(owner));
    assert.equal(ui.get('slimDecisionRuntime').hidden, true, JSON.stringify(owner));
  }
  assert.match(governance, /id="approveIntentBtn"/);
  assert.match(governance, /id="rejectIntentBtn"/);
});
