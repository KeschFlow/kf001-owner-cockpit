import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVENUE_AUTOPILOT_INTERNALS } from '../src/revenue-autopilot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilot = fs.readFileSync(path.join(here, '..', 'src', 'revenue-autopilot.js'), 'utf8');
const workerV3 = fs.readFileSync(path.join(here, '..', 'src', 'worker-v3.js'), 'utf8');
const wrangler = fs.readFileSync(path.join(here, '..', 'wrangler.toml'), 'utf8');
const gmail = fs.readFileSync(path.join(here, '..', 'src', 'gmail.js'), 'utf8');

test('revenue autopilot sends only a hard-qualified current winner and caps new outreach', () => {
  assert.match(autopilot, /e\.economically_qualified = 1/);
  assert.match(autopilot, /e\.economic_score >= \?1/);
  assert.match(autopilot, /e\.amount_approx_usd >= \?2/);
  assert.match(autopilot, /e\.solvability_score >= 65/);
  assert.match(autopilot, /e\.reachability_score >= 65/);
  assert.match(autopilot, /e\.evidence_score >= 55/);
  assert.match(autopilot, /e\.effort_score <= 70/);
  assert.match(autopilot, /e\.uncertainty_score <= 55/);
  assert.match(autopilot, /find\(autoContactAllowed\)/);
  assert.match(autopilot, /LIMIT 20/);
  assert.match(autopilot, /AUTOPILOT_MAX_NEW_OUTREACH_PER_DAY/);
  assert.match(autopilot, /AUTO_CONTACT_NOT_VERIFIED_PUBLIC/);
  assert.match(autopilot, /AUTOPILOT_OUTREACH_SENT/);
});

test('one open customer blocks further cold outreach until the case closes', () => {
  assert.match(autopilot, /OPEN_STAGES/);
  assert.match(autopilot, /const open = await openAutopilotCase\(env\)/);
  assert.match(autopilot, /if \(open\) return await monitorOpenCase\(env, open\)/);
  assert.match(autopilot, /CLOSED_NO_RESPONSE/);
});

test('positive reply moves to explicit engagement terms before evidence intake', () => {
  assert.match(autopilot, /reply exactly: I AGREE/);
  assert.match(autopilot, /stage = 'TERMS_SENT'/);
  assert.match(autopilot, /stage = 'ENGAGED'/);
  assert.match(autopilot, /evidenceChecklistMessage/);
});

test('cancelled or voided documented value is recognized as a successful outcome', () => {
  assert.equal(
    REVENUE_AUTOPILOT_INTERNALS.classifyReply('USD 10,000 was cancelled and resolved.', [], 'ENGAGED'),
    'SUCCESS'
  );
  assert.equal(
    REVENUE_AUTOPILOT_INTERNALS.classifyReply('The USD 10,000 charge was voided.', [], 'EVIDENCE_RECEIVED'),
    'SUCCESS'
  );
});

test('success fee is calculated server-side and only requested through an individual Stripe Checkout', () => {
  assert.match(autopilot, /recovered < minValue/);
  assert.match(autopilot, /createSuccessFeeCheckoutSession/);
  assert.match(autopilot, /stripe_checkout_session_id/);
  assert.match(autopilot, /stage = 'PAYMENT_PENDING'/);
  assert.doesNotMatch(autopilot, /env\.PAYMENT_LINK/);
  assert.doesNotMatch(autopilot, /fixed success fee/i);
});

test('worker v3 runs the revenue autopilot only inside the isolated sidecar', () => {
  assert.match(workerV3, /runRevenueAutopilot\(env\)/);
  assert.match(workerV3, /ctx\.waitUntil\(runAutonomySidecar\(env\)\)/);
});

test('gmail module supports thread reads and replies for reply monitoring', () => {
  assert.match(gmail, /getGmailThread/);
  assert.match(gmail, /GMAIL_READ_SCOPE_REQUIRED/);
  assert.match(gmail, /sendGmailReply/);
});

test('production config enables the capped dynamic success-fee model', () => {
  assert.match(wrangler, /REVENUE_AUTOPILOT_ENABLED = "true"/);
  assert.match(wrangler, /AUTOPILOT_MAX_NEW_OUTREACH_PER_DAY = "1"/);
  assert.match(wrangler, /SUCCESS_FEE_PERCENT = "10"/);
  assert.match(wrangler, /SUCCESS_FEE_MIN_EUR = "750"/);
  assert.match(wrangler, /SUCCESS_FEE_MAX_EUR = "5000"/);
  assert.match(wrangler, /SUCCESS_MIN_RECOVERED_USD = "8000"/);
  assert.match(wrangler, /SUCCESS_FEE_EUR_USD_RATE = "0.90"/);
  assert.match(wrangler, /USD_TO_EUR_RATE = "0.90"/);
  assert.doesNotMatch(wrangler, /SUCCESS_FEE_EUR =/);
  assert.doesNotMatch(wrangler, /PAYMENT_LINK/);
});

test('public autopilot status exposes no checkout URL, Stripe ID, or customer email', () => {
  assert.match(autopilot, /pricingModel: 'DYNAMIC_SUCCESS_FEE'/);
  assert.match(autopilot, /stripeCheckoutReady/);
  const statusBody = autopilot.slice(autopilot.indexOf('export async function revenueAutopilotStatus'), autopilot.indexOf('export async function runRevenueAutopilot'));
  assert.doesNotMatch(statusBody, /recipient_email/);
  assert.doesNotMatch(statusBody, /stripe_checkout_url/);
  assert.doesNotMatch(statusBody, /stripe_checkout_session_id/);
});
