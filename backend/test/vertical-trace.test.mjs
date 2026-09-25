import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker, { handleStripeWebhook } from '../src/worker-v3.js';
import { handleRadarIntakeRequest } from '../src/radar-intake.js';
import { runRevenueAutopilot } from '../src/revenue-autopilot.js';

const CASE_ID = 'PUB-GH-26D297B74D33';
const CHECKOUT_ID = 'cs_test_kf001_vertical_trace_001';
const PAYMENT_EVENT_ID = 'evt_kf001_vertical_trace_001';
const PAYMENT_INTENT_ID = 'pi_kf001_vertical_trace_001';
const WEBHOOK_SECRET = 'unit_test_webhook_secret';

const CASE_CHECK_FIXTURE = Object.freeze({
  externalId: 'EXT-CASE-CHECK-001',
  platform: 'github',
  sourceUrl: 'https://github.com/example/project/issues/42',
  title: 'Business account reports unresolved platform auto-charge discrepancy',
  rawDescription: 'A company developer documents USD 12,000 in disputed unexpected platform charges and an unexplained account balance. The public report includes invoices, screenshots, transaction dates, billing records, a support case ID and a detailed support timeline. The chronology starts on 2026-07-14, links the public supporting record at https://example.com/public-billing-record, and records each response supplied to billing support. The company requested a refund and supplied the requested records, but the issue remains unresolved after repeated billing support contact with no response. The business account owner requests a clear escalation route and identifies the account, invoice and affected payment period.',
  claimAmountUsd: 12000,
  authorName: 'Business Account Owner',
  contactEmail: 'billing@company.example',
  contactRoute: 'PUBLIC_POST_EMAIL'
});

class SqliteD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  runSync() {
    const result = this.database.sqlite.prepare(this.sql).run(...this.args);
    return {
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0)
      }
    };
  }

  async run() {
    return this.runSync();
  }

  async first() {
    return this.database.sqlite.prepare(this.sql).get(...this.args) || null;
  }

  async all() {
    return { results: this.database.sqlite.prepare(this.sql).all(...this.args) };
  }
}

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  execMigration(name) {
    const migration = new URL(`../migrations/${name}`, import.meta.url);
    this.sqlite.exec(fs.readFileSync(migration, 'utf8'));
  }

  get(sql, ...args) {
    return this.sqlite.prepare(sql).get(...args) || null;
  }

  all(sql, ...args) {
    return this.sqlite.prepare(sql).all(...args);
  }

  close() {
    this.sqlite.close();
  }
}

function applyAllMigrations(db) {
  for (const name of [
    '0001_initial.sql',
    '0002_owner_webauthn.sql',
    '0003_gmail_dispatch.sql',
    '0004_real_radar.sql',
    '0005_radar_provenance.sql',
    '0006_retire_legacy_test_case.sql',
    '0007_dispatch_hardening.sql',
    '0008_economic_selection.sql',
    '0009_release_terminal_owner_gate.sql',
    '0010_revenue_autopilot.sql',
    '0011_dynamic_success_fee_checkout.sql',
    '0012_case_check_offer.sql',
    '0013_state_events_audit_context.sql',
    '0014_controlled_autonomy.sql'
  ]) {
    db.execMigration(name);
  }
}

function intakeRequest() {
  return new Request('https://worker.test/v1/radar/intake', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer UNIT_TEST_ONLY',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(CASE_CHECK_FIXTURE)
  });
}

function signedWebhookRequest(event) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return new Request('https://worker.test/v1/stripe/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`
    },
    body
  });
}

test('KF-001 traces one case through intake, Owner Gate, Checkout, payment, replay protection and D1 audit', async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());

  for (const name of [
    '0001_initial.sql',
    '0002_owner_webauthn.sql',
    '0003_gmail_dispatch.sql',
    '0004_real_radar.sql',
    '0005_radar_provenance.sql',
    '0006_retire_legacy_test_case.sql',
    '0007_dispatch_hardening.sql',
    '0008_economic_selection.sql',
    '0009_release_terminal_owner_gate.sql',
    '0010_revenue_autopilot.sql',
    '0011_dynamic_success_fee_checkout.sql',
    '0012_case_check_offer.sql',
    '0013_state_events_audit_context.sql',
    '0014_controlled_autonomy.sql'
  ]) {
    db.execMigration(name);
  }

  const calls = { stripe: 0, gmailSend: 0, gmailThread: 0 };
  let checkoutIdempotencyKey = null;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://api.stripe.com/v1/checkout/sessions') {
      calls.stripe += 1;
      checkoutIdempotencyKey = init.headers['Idempotency-Key'];
      return new Response(JSON.stringify({
        id: CHECKOUT_ID,
        url: `https://checkout.stripe.com/c/pay/${CHECKOUT_ID}`,
        amount_total: 4900,
        currency: 'eur',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'unit-test-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      calls.gmailSend += 1;
      return new Response(JSON.stringify({
        id: 'msg_kf001_vertical_trace_001',
        threadId: 'thread_kf001_vertical_trace_001'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/gmail/v1/users/me/threads/thread_kf001_vertical_trace_001')) {
      calls.gmailThread += 1;
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw new Error(`Unexpected network call: ${url}`);
  });

  const env = {
    CASE_DB: db,
    RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY',
    REVENUE_AUTOPILOT_ENABLED: 'true',
    AUTOPILOT_AUTO_APPROVE_ENABLED: 'true',
    AUTOPILOT_MIN_ECONOMIC_SCORE: '72',
    AUTOPILOT_MIN_VALUE_USD: '8000',
    CASE_CHECK_ENABLED: 'true',
    CASE_CHECK_MIN_ECONOMIC_SCORE: '58',
    CASE_CHECK_MIN_VALUE_USD: '500',
    CASE_CHECK_PRICE_EUR: '49',
    AUTOPILOT_MAX_NEW_OUTREACH_PER_DAY: '1',
    AUTOPILOT_FOLLOWUP_HOURS: '12',
    AUTOPILOT_MAX_CONTACTS_PER_CASE: '2',
    PUBLIC_WORKER_URL: 'https://worker.test',
    GMAIL_CLIENT_ID: 'unit-test-client-id',
    GMAIL_CLIENT_SECRET: 'unit-test-client-secret',
    GMAIL_REFRESH_TOKEN: 'unit-test-refresh-token',
    GMAIL_FROM: 'owner@example.test',
    STRIPE_SECRET_KEY: 'unit-test-stripe-key',
    STRIPE_SUCCESS_URL: 'https://example.test/payment/success',
    STRIPE_CANCEL_URL: 'https://example.test/payment/cancel',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET
  };

  const emptyOwnerGate = await worker.fetch(
    new Request('https://worker.test/v1/owner-state'),
    env,
    { waitUntil() {} }
  );
  assert.equal(emptyOwnerGate.status, 404);

  const firstIntake = await handleRadarIntakeRequest(intakeRequest(), env);
  const firstBody = await firstIntake.json();
  assert.equal(firstIntake.status, 201);
  assert.equal(firstBody.intake.publicCaseId, CASE_ID);
  assert.equal(firstBody.economicSelection.reason, 'ECONOMIC_WINNER_SELECTED');
  assert.equal(firstBody.economicSelection.selectionTier, 'SUCCESS_FEE');

  const initialCase = db.get('SELECT * FROM cases WHERE public_case_id = ?', CASE_ID);
  assert.equal(initialCase.status, 'PENDING_APPROVAL');
  assert.equal(initialCase.is_active, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM cases WHERE is_active = 1').count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM radar_candidates WHERE public_case_id = ?', CASE_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM dispatch_targets WHERE public_case_id = ?', CASE_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM case_economic_scores WHERE public_case_id = ?', CASE_ID).count, 1);

  const ownerResponse = await worker.fetch(
    new Request('https://worker.test/v1/owner-state'),
    env,
    { waitUntil() {} }
  );
  const ownerState = await ownerResponse.json();
  assert.equal(ownerResponse.status, 200);
  assert.equal(ownerState.caseId, CASE_ID);
  assert.equal(ownerState.status, 'PENDING_APPROVAL');
  assert.equal(ownerState.stateSource, 'D1');

  const duplicateIntake = await handleRadarIntakeRequest(intakeRequest(), env);
  const duplicateBody = await duplicateIntake.json();
  assert.equal(duplicateIntake.status, 200);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.intake.publicCaseId, CASE_ID);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM radar_candidates WHERE public_case_id = ?', CASE_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM cases WHERE public_case_id = ?', CASE_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM cases WHERE is_active = 1').count, 1);
  assert.equal(db.get('SELECT version FROM cases WHERE public_case_id = ?', CASE_ID).version, initialCase.version + 1);

  const firstCycle = await runRevenueAutopilot(env);
  assert.equal(firstCycle.action, 'CASE_CHECK_OFFER_SENT');
  assert.equal(firstCycle.acquisition.caseId, CASE_ID);
  assert.equal(calls.stripe, 1);
  assert.equal(calls.gmailSend, 1);
  assert.equal(checkoutIdempotencyKey, `kf001-case-check-${CASE_ID}-v1`);

  const pending = db.get('SELECT * FROM revenue_autopilot WHERE public_case_id = ?', CASE_ID);
  assert.equal(pending.stage, 'CASE_CHECK_PAYMENT_PENDING');
  assert.equal(pending.payment_status, 'REQUESTED');
  assert.equal(pending.offer_type, 'CASE_CHECK_49');
  assert.equal(pending.stripe_checkout_session_id, CHECKOUT_ID);
  assert.equal(pending.fixed_offer_amount_cents, 4900);
  assert.match(String(pending.checkout_public_token || ''), /^[a-f0-9-]{32,64}$/i);

  const checkoutRedirect = await worker.fetch(
    new Request(`https://worker.test/v1/checkout?t=${pending.checkout_public_token}`),
    env,
    { waitUntil() {} }
  );
  assert.equal(checkoutRedirect.status, 302);
  assert.equal(checkoutRedirect.headers.get('Location'), `https://checkout.stripe.com/c/pay/${CHECKOUT_ID}`);
  assert.equal(db.get('SELECT checkout_view_count FROM revenue_autopilot WHERE public_case_id = ?', CASE_ID).checkout_view_count, 1);

  assert.equal(db.get('SELECT status FROM cases WHERE public_case_id = ?', CASE_ID).status, 'DISPATCHED');
  assert.equal(db.get('SELECT COUNT(*) AS count FROM revenue_autopilot WHERE public_case_id = ?', CASE_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM dispatch_log WHERE public_case_id = ?', CASE_ID).count, 1);

  db.sqlite.prepare('UPDATE revenue_autopilot_quota SET sent_count = 0').run();
  const duplicateCycle = await runRevenueAutopilot(env);
  assert.equal(duplicateCycle.action, 'NO_WINNER');
  assert.equal(calls.stripe, 1);
  assert.equal(calls.gmailSend, 1);
  assert.equal(calls.gmailThread, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM revenue_autopilot WHERE public_case_id = ?', CASE_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM dispatch_log WHERE public_case_id = ?', CASE_ID).count, 1);

  const stripeEvent = {
    id: PAYMENT_EVENT_ID,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: CHECKOUT_ID,
        client_reference_id: CASE_ID,
        payment_status: 'paid',
        amount_total: 4900,
        currency: 'eur',
        payment_intent: PAYMENT_INTENT_ID,
        metadata: {
          public_case_id: CASE_ID,
          case_id: CASE_ID,
          product_type: 'CASE_CHECK_49',
          expected_amount_cents: '4900'
        }
      }
    }
  };

  const firstWebhook = await handleStripeWebhook(signedWebhookRequest(stripeEvent), env);
  assert.equal(firstWebhook.status, 200);
  assert.deepEqual(await firstWebhook.json(), { ok: true, received: true, paymentStatus: 'PAID' });

  const paid = db.get('SELECT * FROM revenue_autopilot WHERE public_case_id = ?', CASE_ID);
  assert.equal(paid.stage, 'CASE_CHECK_PAID_AWAITING_EVIDENCE');
  assert.equal(paid.payment_status, 'PAID');
  assert.equal(paid.stripe_payment_intent_id, PAYMENT_INTENT_ID);
  assert.equal(paid.stripe_payment_event_id, PAYMENT_EVENT_ID);
  assert.equal(db.get('SELECT status FROM cases WHERE public_case_id = ?', CASE_ID).status, 'RESPONSE_RECEIVED');
  assert.equal(db.get('SELECT COUNT(*) AS count FROM cases WHERE is_active = 1').count, 0);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM stripe_payments WHERE event_id = ?', PAYMENT_EVENT_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM stripe_webhook_events WHERE event_id = ?', PAYMENT_EVENT_ID).count, 1);

  const auditEvents = db.all(`
    SELECT event_type, state, source, previous_state, actor_ref, request_key, created_at
      FROM state_events
     WHERE public_case_id = ?
     ORDER BY id
  `, CASE_ID);
  assert.deepEqual(auditEvents.map(({
    event_type, state, source, previous_state, actor_ref, request_key
  }) => ({ event_type, state, source, previous_state, actor_ref, request_key })), [
    {
      event_type: 'ECONOMIC_WINNER_SELECTED',
      state: 'PENDING_APPROVAL',
      source: 'ECONOMIC_SELECTOR_V1',
      previous_state: null,
      actor_ref: 'ECONOMIC_SELECTOR_V1',
      request_key: 'GH:EXT-CASE-CHECK-001'
    },
    {
      event_type: 'AUTONOMY_AUTO_APPROVED',
      state: 'APPROVED_PENDING_DISPATCH',
      source: 'AUTONOMY_CONTROL_V1',
      previous_state: 'PENDING_APPROVAL',
      actor_ref: 'AUTONOMY_CONTROL_V1',
      request_key: `kf001-case-check-${CASE_ID}-v1`
    },
    {
      event_type: 'CASE_CHECK_OFFER_SENT',
      state: 'PAYMENT_PENDING',
      source: 'REVENUE_AUTOPILOT',
      previous_state: 'APPROVED_PENDING_DISPATCH',
      actor_ref: 'REVENUE_AUTOPILOT',
      request_key: `kf001-case-check-${CASE_ID}-v1`
    },
    {
      event_type: 'CASE_CHECK_PAYMENT_CONFIRMED',
      state: 'PAID',
      source: 'STRIPE_WEBHOOK',
      previous_state: 'PAYMENT_PENDING',
      actor_ref: 'STRIPE_WEBHOOK',
      request_key: PAYMENT_EVENT_ID
    }
  ]);
  assert.equal(auditEvents.every((event) => !Number.isNaN(Date.parse(event.created_at))), true);

  const duplicateWebhook = await handleStripeWebhook(signedWebhookRequest(stripeEvent), env);
  assert.equal(duplicateWebhook.status, 200);
  assert.deepEqual(await duplicateWebhook.json(), { ok: true, received: true, duplicate: true });
  assert.equal(db.get('SELECT COUNT(*) AS count FROM stripe_payments WHERE event_id = ?', PAYMENT_EVENT_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM stripe_webhook_events WHERE event_id = ?', PAYMENT_EVENT_ID).count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM state_events WHERE public_case_id = ?', CASE_ID).count, 4);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM autonomy_audit_log WHERE public_case_id = ?', CASE_ID).count >= 3, true);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM dispatch_log WHERE public_case_id = ?', CASE_ID).count, 1);
});


test('global kill switch blocks a hard-qualified case before Gmail outreach', async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());
  applyAllMigrations(db);

  let stripeCalls = 0;
  let gmailSends = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    if (url === 'https://api.stripe.com/v1/checkout/sessions') {
      stripeCalls += 1;
      return new Response(JSON.stringify({
        id: 'cs_test_kill_switch',
        url: 'https://checkout.stripe.com/c/pay/cs_test_kill_switch',
        amount_total: 4900,
        currency: 'eur',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'unit-test-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      gmailSends += 1;
      return new Response(JSON.stringify({ id: 'SHOULD_NOT_SEND', threadId: 'SHOULD_NOT_SEND' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw new Error(`Unexpected network call: ${url}`);
  });

  const env = {
    CASE_DB: db,
    RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY',
    REVENUE_AUTOPILOT_ENABLED: 'true',
    AUTOPILOT_AUTO_APPROVE_ENABLED: 'true',
    AUTOPILOT_MIN_ECONOMIC_SCORE: '72',
    AUTOPILOT_MIN_VALUE_USD: '8000',
    CASE_CHECK_ENABLED: 'true',
    CASE_CHECK_MIN_ECONOMIC_SCORE: '58',
    CASE_CHECK_MIN_VALUE_USD: '500',
    CASE_CHECK_PRICE_EUR: '49',
    AUTOPILOT_MAX_NEW_OUTREACH_PER_DAY: '1',
    AUTOPILOT_FOLLOWUP_HOURS: '12',
    AUTOPILOT_MAX_CONTACTS_PER_CASE: '2',
    PUBLIC_WORKER_URL: 'https://worker.test',
    GMAIL_CLIENT_ID: 'unit-test-client-id',
    GMAIL_CLIENT_SECRET: 'unit-test-client-secret',
    GMAIL_REFRESH_TOKEN: 'unit-test-refresh-token',
    GMAIL_FROM: 'owner@example.test',
    STRIPE_SECRET_KEY: 'unit-test-stripe-key',
    STRIPE_SUCCESS_URL: 'https://example.test/payment/success',
    STRIPE_CANCEL_URL: 'https://example.test/payment/cancel'
  };

  const intake = await handleRadarIntakeRequest(intakeRequest(), env);
  assert.equal(intake.status, 201);
  db.sqlite.prepare(`
    UPDATE autonomy_control
       SET outreach_enabled = 0, updated_by = 'TEST_KILL', updated_at = CURRENT_TIMESTAMP
     WHERE id = 1
  `).run();

  const cycle = await runRevenueAutopilot(env, { replyMonitoringAvailable: false });
  assert.equal(cycle.action, 'PENDING_OWNER_REVIEW');
  assert.equal(cycle.acquisition.reasons.includes('GLOBAL_KILL_SWITCH'), true);
  assert.equal(stripeCalls, 1);
  assert.equal(gmailSends, 0);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM dispatch_log WHERE public_case_id = ?', CASE_ID).count, 0);
  assert.equal(db.get('SELECT status FROM cases WHERE public_case_id = ?', CASE_ID).status, 'PENDING_APPROVAL');
  assert.equal(db.get('SELECT sent_count FROM revenue_autopilot_quota LIMIT 1')?.sent_count || 0, 0);
  assert.equal(
    db.get("SELECT COUNT(*) AS count FROM autonomy_audit_log WHERE public_case_id = ? AND event_type = 'OUTREACH_PREFLIGHT_BLOCKED'", CASE_ID).count,
    1
  );
});
