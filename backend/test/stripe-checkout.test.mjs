import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSuccessFee,
  calculateSuccessFeeEur,
  createSuccessFeeCheckoutSession
} from '../src/stripe.js';
import { REVENUE_AUTOPILOT_INTERNALS, revenueAutopilotStatus } from '../src/revenue-autopilot.js';

const stripeEnv = (overrides = {}) => ({
  STRIPE_SECRET_KEY: 'UNIT_TEST_SECRET',
  STRIPE_SUCCESS_URL: 'https://example.test/payment/success',
  STRIPE_CANCEL_URL: 'https://example.test/payment/cancel',
  SUCCESS_FEE_PERCENT: '10',
  SUCCESS_FEE_MIN_EUR: '750',
  SUCCESS_FEE_MAX_EUR: '5000',
  SUCCESS_MIN_RECOVERED_USD: '8000',
  SUCCESS_FEE_EUR_USD_RATE: '0.90',
  ...overrides
});

test('dynamic success-fee formula enforces threshold, minimum, percentage and maximum', () => {
  assert.throws(() => calculateSuccessFee(7999, 0.90), /RECOVERED_AMOUNT_BELOW_MINIMUM/);
  assert.equal(calculateSuccessFeeEur(8000, 0.90), 75000);
  assert.equal(calculateSuccessFeeEur(10000, 0.90), 90000);
  assert.equal(calculateSuccessFeeEur(25000, 0.90), 225000);
  assert.equal(calculateSuccessFeeEur(100000, 0.90), 500000);
  const minimum = calculateSuccessFee(8000, 0.90);
  assert.equal(minimum.uncappedFeeAmountCents, 72000);
  assert.equal(minimum.feeAmountCents, 75000);
});

test('success-fee calculation rejects invalid amounts and exchange rates', () => {
  for (const value of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => calculateSuccessFee(value, 0.90), /INVALID_RECOVERED_AMOUNT_USD/);
  }
  for (const rate of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => calculateSuccessFee(10000, rate), /INVALID_USD_TO_EUR_RATE/);
  }
});

test('success-fee calculation rounds commercially to integer cents', () => {
  const result = calculateSuccessFee(10000.06, 0.90);
  assert.equal(result.feeAmountCents, 90001);
  assert.equal(Number.isInteger(result.feeAmountCents), true);
});

test('Checkout ignores any customer-supplied amount and sends the server-calculated integer cents', async (t) => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init, body: new URLSearchParams(init.body) };
    return new Response(JSON.stringify({
      id: 'cs_test_dynamic',
      url: 'https://checkout.stripe.com/c/pay/cs_test_dynamic',
      amount_total: 90000,
      currency: 'eur',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const checkout = await createSuccessFeeCheckoutSession(stripeEnv(), {
    publicCaseId: 'PUB-TEST-001',
    recoveredAmountUsd: 10000,
    customerEmail: 'verified@example.test',
    feeAmountCents: 1,
    amount: 1
  });

  assert.equal(request.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(request.body.get('line_items[0][price_data][unit_amount]'), '90000');
  assert.equal(request.body.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(request.body.get('line_items[0][quantity]'), '1');
  assert.equal(request.body.get('metadata[public_case_id]'), 'PUB-TEST-001');
  assert.equal(request.init.headers['Idempotency-Key'], 'kf001-success-fee-PUB-TEST-001-10000.00');
  assert.equal(checkout.pricing.feeAmountCents, 90000);
});

test('missing Stripe secret fails closed before any network request', async (t) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('SHOULD_NOT_RUN'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(
    createSuccessFeeCheckoutSession(stripeEnv({ STRIPE_SECRET_KEY: '' }), {
      publicCaseId: 'PUB-TEST-001', recoveredAmountUsd: 10000, customerEmail: 'verified@example.test'
    }),
    /STRIPE_SECRET_KEY_NOT_CONFIGURED/
  );
  assert.equal(called, false);
});

function checkoutDb({ failCheckoutSave = false } = {}) {
  const state = {};
  return {
    state,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes('FROM revenue_autopilot')) return {
            recovered_approx_usd: state.recoveredUsd,
            success_fee_percent: state.feePercent,
            success_fee_min_eur: state.feeMinEur,
            success_fee_max_eur: state.feeMaxEur,
            success_min_recovered_usd: state.minRecoveredUsd,
            usd_to_eur_rate: state.rate,
            calculated_fee_minor: state.feeAmountCents,
            success_fee_amount_cents: state.feeAmountCents,
            success_fee_currency: 'EUR',
            pricing_version: state.pricingVersion,
            success_event_key: state.successEventKey,
            checkout_creation_attempted_at: state.attemptedAt || null,
            stripe_checkout_session_id: state.sessionId || null,
            stripe_checkout_url: state.url || null,
            checkout_expires_at: state.expiresAt || null
          };
          return null;
        },
        async run() {
          if (sql.includes("stage = 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED'")) {
            state.stage = 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED';
            if (sql.includes('success_fee_percent')) {
              state.recoveredUsd = this.values[2];
              state.feePercent = this.values[3];
              state.feeMinEur = this.values[4];
              state.feeMaxEur = this.values[5];
              state.minRecoveredUsd = this.values[6];
              state.rate = this.values[7];
              state.feeAmountCents = this.values[9];
              state.pricingVersion = this.values[10];
              state.successEventKey = this.values[11];
              state.errorCode = this.values[12];
            } else {
              state.errorCode = this.values[1];
            }
          }
          if (sql.includes('stripe_checkout_session_id = ?2')) {
            if (failCheckoutSave) return { meta: { changes: 0 } };
            state.sessionId = this.values[1];
            state.url = this.values[2];
            state.expiresAt = this.values[4];
          }
          if (sql.includes('SET checkout_creation_attempted_at = ?2')) state.attemptedAt = this.values[1];
          return { meta: { changes: 1 } };
        }
      };
    }
  };
}

test('repeated setup reuses the stored Checkout Session and does not create another one', async (t) => {
  const originalFetch = globalThis.fetch;
  let stripeCalls = 0;
  globalThis.fetch = async () => {
    stripeCalls += 1;
    return new Response(JSON.stringify({
      id: 'cs_test_once',
      url: 'https://checkout.stripe.com/c/pay/cs_test_once',
      amount_total: 90000,
      currency: 'eur',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const db = checkoutDb();
  const env = stripeEnv({ CASE_DB: db });
  const record = { public_case_id: 'PUB-TEST-001', recipient_email: 'verified@example.test' };

  const first = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(env, record, 10000);
  const second = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(env, record, 10000);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.checkout.id, 'cs_test_once');
  assert.equal(second.checkout.id, 'cs_test_once');
  assert.equal(stripeCalls, 1);
});

test('missing Stripe configuration stores setup-required state and sends no request', async (t) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('SHOULD_NOT_RUN'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const db = checkoutDb();
  const env = stripeEnv({ CASE_DB: db, STRIPE_SECRET_KEY: '' });
  const result = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(
    env,
    { public_case_id: 'PUB-TEST-001', recipient_email: 'verified@example.test' },
    10000
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'STRIPE_SECRET_KEY_NOT_CONFIGURED');
  assert.equal(db.state.stage, 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED');
  assert.equal(called, false);
});

test('missing Stripe secret sends no payment email', async (t) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('SHOULD_NOT_RUN'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const db = checkoutDb();
  const env = stripeEnv({ CASE_DB: db, STRIPE_SECRET_KEY: '' });
  const result = await REVENUE_AUTOPILOT_INTERNALS.requestDynamicPayment(
    env,
    { public_case_id: 'PUB-TEST-001', recipient_email: 'verified@example.test' },
    { id: 'gmail-success-message' },
    10000
  );
  assert.equal(result.action, 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED');
  assert.equal(called, false);
});

test('stored pricing and Checkout stay immutable after configuration changes', async (t) => {
  const originalFetch = globalThis.fetch;
  let stripeCalls = 0;
  globalThis.fetch = async () => {
    stripeCalls += 1;
    return new Response(JSON.stringify({
      id: 'cs_test_locked',
      url: 'https://checkout.stripe.com/c/pay/cs_test_locked',
      amount_total: 90000,
      currency: 'eur',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const db = checkoutDb();
  const record = { public_case_id: 'PUB-TEST-001', recipient_email: 'verified@example.test' };
  const first = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(stripeEnv({ CASE_DB: db }), record, 10000);
  const changedEnv = stripeEnv({ CASE_DB: db, SUCCESS_FEE_EUR_USD_RATE: '0.80', USD_TO_EUR_RATE: '0.80' });
  const replay = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(changedEnv, record, 10000);
  const changedAmount = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(changedEnv, record, 11000);
  assert.equal(first.pricing.feeAmountCents, 90000);
  assert.equal(replay.pricing.feeAmountCents, 90000);
  assert.equal(replay.checkout.id, 'cs_test_locked');
  assert.equal(changedAmount.error, 'SUCCESS_FEE_ALREADY_LOCKED');
  assert.equal(stripeCalls, 1);
});

test('an uncertain post-Stripe persistence result never creates a second Checkout', async (t) => {
  const originalFetch = globalThis.fetch;
  let stripeCalls = 0;
  globalThis.fetch = async () => {
    stripeCalls += 1;
    return new Response(JSON.stringify({
      id: 'cs_test_uncertain',
      url: 'https://checkout.stripe.com/c/pay/cs_test_uncertain',
      amount_total: 90000,
      currency: 'eur',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const db = checkoutDb({ failCheckoutSave: true });
  const env = stripeEnv({ CASE_DB: db });
  const record = { public_case_id: 'PUB-TEST-001', recipient_email: 'verified@example.test' };
  const first = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(env, record, 10000);
  const retry = await REVENUE_AUTOPILOT_INTERNALS.ensureDynamicCheckout(env, record, 10000);
  assert.equal(first.error, 'STRIPE_CHECKOUT_STATE_CONFLICT');
  assert.equal(retry.error, 'STRIPE_CHECKOUT_RECONCILIATION_REQUIRED');
  assert.equal(stripeCalls, 1);
});

test('public status contains only safe pricing and stage fields', async () => {
  const row = { stage: 'PAYMENT_PENDING', payment_status: 'REQUESTED' };
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return sql.includes('FROM revenue_autopilot') ? { results: [row] } : { results: [] }; },
        async first() { return row; },
        async run() { return { meta: { changes: 1 } }; }
      };
    },
    async batch() { return []; }
  };
  const result = await revenueAutopilotStatus(stripeEnv({ CASE_DB: db, REVENUE_AUTOPILOT_ENABLED: 'true' }));
  assert.deepEqual(result, {
    enabled: true,
    stage: 'PAYMENT_PENDING',
    pricingModel: 'DYNAMIC_SUCCESS_FEE',
    feePercent: 10,
    feeMinEur: 750,
    feeMaxEur: 5000,
    stripeCheckoutReady: true,
    paymentStatus: 'REQUESTED'
  });
});
