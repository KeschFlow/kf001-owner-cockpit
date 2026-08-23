import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_V3_INTERNALS } from '../src/worker-v3.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerV3 = fs.readFileSync(path.join(here, '..', 'src', 'worker-v3.js'), 'utf8');
const gmail = fs.readFileSync(path.join(here, '..', 'src', 'gmail.js'), 'utf8');

test('Gmail read capability is probed independently from Gmail send capability', () => {
  assert.match(gmail, /export async function gmailReadAvailable/);
  assert.match(gmail, /gmail\/v1\/users\/me\/profile/);
  assert.match(workerV3, /replyProcessingAvailable = await gmailReadAvailable\(env\)/);
});

test('missing Gmail read capability routes acquisition to direct case-check revenue', () => {
  assert.match(workerV3, /mode: 'DIRECT_CASE_CHECK_FALLBACK'/);
  assert.match(workerV3, /currentWinner: async \(\) => null/);
  assert.match(workerV3, /REVENUE_AUTOPILOT_INTERNALS\.acquireDailyCandidate/);
});

test('blocked requested payments are normalized back to Stripe-waiting states', async () => {
  const calls = [];
  const env = { CASE_DB: { prepare(sql) { return { bind(...args) { return { async run() { calls.push({ sql, args }); return { meta: { changes: 2 } }; } }; } }; } } };
  const result = await WORKER_V3_INTERNALS.normalizePaymentWaitStates(env);
  assert.equal(result.repaired, 2);
  assert.match(calls[0].sql, /CASE_CHECK_PAYMENT_PENDING/);
  assert.match(calls[0].sql, /PAYMENT_PENDING/);
  assert.match(calls[0].sql, /payment_status = 'REQUESTED'/);
});

test('public status tells the truth about fallback mode', () => {
  assert.match(workerV3, /revenueMode: replyProcessingAvailable \? 'FULL' : 'DIRECT_CASE_CHECK_FALLBACK'/);
});
