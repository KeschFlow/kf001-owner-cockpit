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

test('missing Gmail read capability still permits one safe initial checkout outreach but no reply monitor or follow-up', () => {
  assert.match(workerV3, /runRevenueAutopilot\(env, \{ replyMonitoringAvailable: replyProcessingAvailable \}\)/);
  assert.match(workerV3, /CONTROLLED_SEND_ONLY_NO_FOLLOWUP/);
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

test('public status tells the truth about send-only mode', () => {
  assert.match(workerV3, /revenueMode: replyProcessingAvailable \? 'CONTROLLED_AUTONOMY' : 'CONTROLLED_SEND_ONLY_NO_FOLLOWUP'/);
});

test('Stripe webhook accepts a payment record that Gmail previously marked reply-monitor-blocked', () => {
  assert.match(workerV3, /record\.stage === 'REPLY_MONITOR_BLOCKED' && record\.payment_status === 'REQUESTED'/);
  assert.match(workerV3, /stage = 'REPLY_MONITOR_BLOCKED' AND payment_status = 'REQUESTED'/);
});
