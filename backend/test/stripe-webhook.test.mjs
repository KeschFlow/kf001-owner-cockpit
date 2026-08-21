import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStripeWebhook } from '../src/worker-v3.js';

const encoder = new TextEncoder();

async function signedRequest(event, secret = 'whsec_unit_test') {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${raw}`));
  const signature = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://worker.test/v1/stripe/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
}

function validEvent(overrides = {}) {
  const sessionOverrides = overrides.session || {};
  return {
    id: overrides.eventId || 'evt_valid_001',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_valid_001',
        client_reference_id: 'PUB-TEST-001',
        payment_status: 'paid',
        amount_total: 90000,
        currency: 'eur',
        payment_intent: 'pi_valid_001',
        metadata: {
          public_case_id: 'PUB-TEST-001',
          case_id: 'PUB-TEST-001',
          success_fee_amount_cents: '90000'
        },
        ...sessionOverrides,
        metadata: {
          public_case_id: 'PUB-TEST-001',
          case_id: 'PUB-TEST-001',
          success_fee_amount_cents: '90000',
          ...(sessionOverrides.metadata || {})
        }
      }
    }
  };
}

function webhookDb(recordOverrides = {}) {
  const state = {
    record: {
      public_case_id: 'PUB-TEST-001',
      stage: 'PAYMENT_PENDING',
      payment_status: 'REQUESTED',
      calculated_fee_minor: 90000,
      success_fee_amount_cents: 90000,
      success_fee_currency: 'EUR',
      stripe_checkout_session_id: 'cs_valid_001',
      ...recordOverrides
    },
    webhookEvents: new Map(),
    paymentRows: 0,
    stateEvents: 0,
    caseClosed: false
  };

  const execute = async (sql, values) => {
    if (sql.includes('INSERT OR IGNORE INTO stripe_webhook_events')) {
      const [eventId, eventType, caseId, sessionId, createdAt] = values;
      if (state.webhookEvents.has(eventId)) return { meta: { changes: 0 } };
      state.webhookEvents.set(eventId, { status: 'PROCESSING', eventType, caseId, sessionId, createdAt });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'REJECTED'")) {
      const event = state.webhookEvents.get(values[0]);
      if (event?.status === 'PROCESSING') Object.assign(event, { status: 'REJECTED', errorCode: values[1] });
      return { meta: { changes: event ? 1 : 0 } };
    }
    if (sql.includes('UPDATE revenue_autopilot') && sql.includes("payment_status = 'PAID'")) {
      const [caseId, paidAt, paymentIntentId, eventId, sessionId, expectedAmount, paidStage, expectedStage] = values;
      const matches = state.record.public_case_id === caseId
        && state.record.stage === expectedStage
        && state.record.stripe_checkout_session_id === sessionId
        && (state.record.fixed_offer_amount_cents ?? state.record.calculated_fee_minor ?? state.record.success_fee_amount_cents) === expectedAmount;
      if (!matches) return { meta: { changes: 0 } };
      Object.assign(state.record, {
        stage: paidStage, payment_status: 'PAID', payment_confirmed_at: paidAt,
        stripe_payment_intent_id: paymentIntentId, stripe_payment_event_id: eventId
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE cases')) {
      state.caseClosed = true;
      return { meta: { changes: 1 } };
    }
    if (sql.includes('INSERT INTO state_events')) {
      state.stateEvents += 1;
      return { meta: { changes: 1 } };
    }
    if (sql.includes('INSERT OR IGNORE INTO stripe_payments')) {
      state.paymentRows += 1;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'PROCESSED'")) {
      const event = state.webhookEvents.get(values[0]);
      if (event?.status === 'PROCESSING') event.status = 'PROCESSED';
      return { meta: { changes: event ? 1 : 0 } };
    }
    return { meta: { changes: 1 } };
  };

  return {
    state,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes('FROM revenue_autopilot')) {
            return this.values[0] === state.record.public_case_id ? { ...state.record } : null;
          }
          return null;
        },
        async run() { return execute(sql, this.values); }
      };
    },
    async batch(statements) {
      const output = [];
      for (const statement of statements) output.push(await statement.run());
      return output;
    }
  };
}

async function deliver(event, db) {
  return handleStripeWebhook(await signedRequest(event), {
    STRIPE_WEBHOOK_SECRET: 'whsec_unit_test',
    CASE_DB: db
  });
}

test('webhook rejects wrong currency without confirming payment', async () => {
  const db = webhookDb();
  const response = await deliver(validEvent({ session: { currency: 'usd' } }), db);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'STRIPE_CURRENCY_MISMATCH');
  assert.equal(db.state.record.stage, 'PAYMENT_PENDING');
});

test('webhook rejects wrong amount without confirming payment', async () => {
  const db = webhookDb();
  const response = await deliver(validEvent({ session: { amount_total: 89999 } }), db);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'STRIPE_AMOUNT_MISMATCH');
  assert.equal(db.state.record.payment_status, 'REQUESTED');
});

test('webhook rejects a metadata amount mismatch', async () => {
  const db = webhookDb();
  const response = await deliver(validEvent({ session: {
    metadata: { success_fee_amount_cents: '1' }
  } }), db);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'STRIPE_AMOUNT_MISMATCH');
  assert.equal(db.state.record.payment_status, 'REQUESTED');
});

test('webhook rejects a foreign Checkout Session', async () => {
  const db = webhookDb();
  const response = await deliver(validEvent({ session: { id: 'cs_foreign' } }), db);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'STRIPE_SESSION_MISMATCH');
  assert.equal(db.state.record.payment_status, 'REQUESTED');
});

test('webhook rejects a foreign case ID', async () => {
  const db = webhookDb();
  const response = await deliver(validEvent({ session: {
    client_reference_id: 'PUB-OTHER-001',
    metadata: { public_case_id: 'PUB-OTHER-001', case_id: 'PUB-OTHER-001' }
  } }), db);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'OPEN_PAYMENT_RECORD_NOT_FOUND');
  assert.equal(db.state.record.payment_status, 'REQUESTED');
});

test('webhook rejects a missing Payment Intent', async () => {
  const db = webhookDb();
  const response = await deliver(validEvent({ session: { payment_intent: null } }), db);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'STRIPE_PAYMENT_INTENT_MISSING');
  assert.equal(db.state.record.payment_status, 'REQUESTED');
});

test('valid paid Checkout closes the case once and duplicate event is idempotent', async () => {
  const db = webhookDb();
  const event = validEvent();
  const first = await deliver(event, db);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).paymentStatus, 'PAID');
  assert.equal(db.state.record.stage, 'PAID');
  assert.equal(db.state.record.payment_status, 'PAID');
  assert.equal(db.state.record.stripe_payment_intent_id, 'pi_valid_001');
  assert.equal(db.state.caseClosed, true);
  assert.equal(db.state.paymentRows, 1);
  assert.equal(db.state.stateEvents, 1);

  const duplicate = await deliver(event, db);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(db.state.paymentRows, 1);
  assert.equal(db.state.stateEvents, 1);
});

test('paid case check stays active and waits for evidence', async () => {
  const db = webhookDb({
    stage: 'CASE_CHECK_PAYMENT_PENDING',
    offer_type: 'CASE_CHECK_49',
    fixed_offer_amount_cents: 4900
  });
  const event = validEvent({ session: {
    amount_total: 4900,
    metadata: {
      product_type: 'CASE_CHECK_49',
      expected_amount_cents: '4900'
    }
  } });
  const response = await deliver(event, db);
  assert.equal(response.status, 200);
  assert.equal(db.state.record.stage, 'CASE_CHECK_PAID_AWAITING_EVIDENCE');
  assert.equal(db.state.record.payment_status, 'PAID');
});
