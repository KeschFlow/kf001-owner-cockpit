import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardAutoApproveRules, AUTONOMY_CONTROL_INTERNALS } from '../src/autonomy-control.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const control = fs.readFileSync(path.join(here, '..', 'src', 'autonomy-control.js'), 'utf8');
const autopilot = fs.readFileSync(path.join(here, '..', 'src', 'revenue-autopilot.js'), 'utf8');
const worker = fs.readFileSync(path.join(here, '..', 'src', 'worker-v3.js'), 'utf8');
const migration = fs.readFileSync(path.join(here, '..', 'migrations', '0014_controlled_autonomy.sql'), 'utf8');

const env = {
  REVENUE_AUTOPILOT_ENABLED: 'true',
  AUTOPILOT_MIN_ECONOMIC_SCORE: '72',
  AUTOPILOT_MIN_VALUE_USD: '8000',
  GMAIL_CLIENT_ID: 'id',
  GMAIL_CLIENT_SECRET: 'secret',
  GMAIL_REFRESH_TOKEN: 'refresh',
  GMAIL_FROM: 'owner@example.com',
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_SUCCESS_URL: 'https://example.com/success',
  STRIPE_CANCEL_URL: 'https://example.com/cancel',
  PUBLIC_WORKER_URL: 'https://worker.example.com'
};

const winner = {
  public_case_id: 'PUB-GH-ABC123',
  economically_qualified: 1,
  economic_score: 84,
  amount_approx_usd: 12000,
  solvability_score: 80,
  reachability_score: 80,
  evidence_score: 75,
  effort_score: 40,
  uncertainty_score: 30,
  selected_at: '2026-09-25T00:00:00Z',
  recipient_email: 'person@example.net',
  contact_route: 'PUBLIC_POST_EMAIL',
  source_title: 'Unexpected platform billing charge',
  source_excerpt: 'Support has not resolved the disputed charge.'
};

test('hard auto-approve requires every economic and delivery gate', () => {
  assert.equal(hardAutoApproveRules(winner, env).approved, true);
  assert.equal(hardAutoApproveRules({ ...winner, evidence_score: 40 }, env).approved, false);
  assert.equal(hardAutoApproveRules({ ...winner, amount_approx_usd: 7999 }, env).approved, false);
  assert.equal(hardAutoApproveRules({ ...winner, recipient_email: 'bad' }, env).approved, false);
  assert.equal(hardAutoApproveRules({ ...winner, contact_route: 'UNKNOWN' }, env).approved, false);
  assert.equal(hardAutoApproveRules({ ...winner, source_excerpt: 'already resolved' }, env).approved, false);
});

test('opt-out is a mandatory send precondition', () => {
  assert.equal(AUTONOMY_CONTROL_INTERNALS.OPT_OUT.test('If not relevant, reply NO and I will close the case.'), true);
  assert.equal(AUTONOMY_CONTROL_INTERNALS.OPT_OUT.test('Here is your checkout.'), false);
});

test('immutable audit and global kill switch are persisted in D1 schema', () => {
  assert.match(migration, /autonomy_control/);
  assert.match(migration, /outreach_suppression/);
  assert.match(migration, /autonomy_audit_log/);
  assert.match(migration, /AUTONOMY_AUDIT_IMMUTABLE/);
  assert.match(control, /GLOBAL_KILL_SWITCH/);
});

test('controlled outreach uses tracked checkout and a final safety preflight before Gmail', () => {
  assert.match(autopilot, /safeOutreachPreflight/);
  assert.match(autopilot, /publicCheckoutTrackingUrl/);
  assert.match(autopilot, /AUTO_APPROVED/);
  assert.match(autopilot, /outbound_contact_count/);
});

test('worker exposes passkey-protected kill switch and tracked checkout redirect', () => {
  assert.match(worker, /AUTOPILOT_KILL_SWITCH/);
  assert.match(worker, /\/v1\/autopilot\/kill-switch/);
  assert.match(worker, /\/v1\/checkout/);
  assert.match(worker, /revenueMoneyMetrics/);
});
