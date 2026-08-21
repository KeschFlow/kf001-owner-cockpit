import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseCheckCheckoutSession } from '../src/stripe.js';
import { REVENUE_AUTOPILOT_INTERNALS } from '../src/revenue-autopilot.js';

test('case check Checkout is fixed at server-configured EUR 49 and idempotent per case', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, init, body: new URLSearchParams(init.body) };
    return new Response(JSON.stringify({
      id: 'cs_case_check', url: 'https://checkout.stripe.com/c/pay/cs_case_check',
      amount_total: 4900, currency: 'eur', expires_at: Math.floor(Date.now() / 1000) + 3600
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const checkout = await createCaseCheckCheckoutSession({
    STRIPE_SECRET_KEY: 'sk_test', CASE_CHECK_PRICE_EUR: '49',
    STRIPE_SUCCESS_URL: 'https://example.com/success', STRIPE_CANCEL_URL: 'https://example.com/cancel'
  }, { publicCaseId: 'PUB-TEST-002', customerEmail: 'owner@example.com' });
  assert.equal(checkout.amountCents, 4900);
  assert.equal(request.body.get('metadata[product_type]'), 'CASE_CHECK_49');
  assert.equal(request.body.get('metadata[expected_amount_cents]'), '4900');
  assert.equal(request.init.headers['Idempotency-Key'], 'kf001-case-check-PUB-TEST-002-v1');
});

test('case check offer states exactly what the customer receives', () => {
  const text = REVENUE_AUTOPILOT_INTERNALS.caseCheckMessage({ source_title: 'Billing dispute' }, 'https://checkout.stripe.com/c/pay/test', 49);
  assert.match(text, /reconstructed timeline/);
  assert.match(text, /missing evidence/);
  assert.match(text, /escalation route/);
  assert.match(text, /ready-to-send escalation letter/);
  assert.match(text, /EUR 49\.00/);
});
