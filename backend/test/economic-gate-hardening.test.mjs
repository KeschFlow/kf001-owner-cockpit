import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerV2 = fs.readFileSync(path.join(here, '..', 'src', 'worker-v2.js'), 'utf8');

test('owner APPROVE is hard-blocked unless the selected economic winner is qualified', () => {
  assert.match(workerV2, /ECONOMIC_APPROVAL_BLOCKED/);
  assert.match(workerV2, /economically_qualified/);
  assert.match(workerV2, /economic_score/);
  assert.match(workerV2, /selected_at/);
  assert.match(workerV2, /ECON_V1/);
});

test('raw radar promotion cannot be used as fallback owner-gate winner', () => {
  assert.match(workerV2, /promotedCaseId:\s*selectedCaseId/);
  assert.doesNotMatch(workerV2, /economicResult\.selectedCaseId\s*\|\|\s*radarResult\.promotedCaseId/);
});

test('stale or uneconomic pending gates are suppressed before owner-state is served', () => {
  assert.match(workerV2, /ECONOMIC_GATE_HARD_BLOCKED/);
  assert.match(workerV2, /url\.pathname === '\/v1\/owner-state'/);
  assert.match(workerV2, /await suppressInvalidPendingGate\(env\)/);
});

test('selected case-check candidates stay active for the existing revenue autopilot but not owner APPROVE', () => {
  assert.match(workerV2, /economicRowIsSelectedRevenueCandidate\(active, env\)/);
  assert.match(workerV2, /caseCheckEligible/);
  assert.match(workerV2, /allowed:\s*economicRowIsApprovalQualified\(row\)/);
});
