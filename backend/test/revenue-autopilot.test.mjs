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
  assert.match(autopilot, /hardAutoApproveRules\(row, env\)\.approved/);
  assert.match(autopilot, /LIMIT 20/);
  assert.match(autopilot, /AUTOPILOT_MAX_NEW_OUTREACH_PER_DAY/);
  assert.match(autopilot, /AUTO_CONTACT_NOT_VERIFIED_PUBLIC/);
  assert.match(autopilot, /CASE_CHECK_OFFER_SENT/);
});

test('open customers are monitored in a bounded set without blocking daily acquisition', () => {
  assert.match(autopilot, /OPEN_STAGES/);
  assert.match(autopilot, /MAX_OPEN_CASES_PER_RUN = 25/);
  assert.match(autopilot, /const monitoring = await monitorOpenCases\(env, openCases, monitorCase\)/);
  assert.match(autopilot, /const acquisition = await acquireDailyCandidate\(env, operations\)/);
  assert.doesNotMatch(autopilot, /if \(open\) return await monitorOpenCase/);
  assert.match(autopilot, /CLOSED_NO_RESPONSE/);
});

function cycleOperations({ openCases = [], quotaAvailable = true, winner = null, caseCheck = null, monitor, sendWinner, sendCaseCheck } = {}) {
  return {
    openAutopilotCases: async () => openCases,
    monitorOpenCase: monitor || (async (_, record) => ({ ok: true, action: 'WAITING_FOR_REPLY', caseId: record.public_case_id, stage: record.stage })),
    dailyQuotaStatus: async () => ({ day: '2026-08-22', max: 1, sentCount: quotaAvailable ? 0 : 1, available: quotaAvailable }),
    currentWinner: async () => winner,
    sendInitialOutreach: sendWinner || (async (_, row) => ({ ok: true, action: 'OUTREACH_SENT', caseId: row.public_case_id })),
    currentCaseCheckCandidate: async () => caseCheck,
    sendCaseCheckOffer: sendCaseCheck || (async (_, row) => ({ ok: true, action: 'CASE_CHECK_OFFER_SENT', caseId: row.public_case_id }))
  };
}

test('case-check waiting case is monitored and a new qualified winner receives the one daily outreach', async () => {
  const monitored = [];
  let outreach = 0;
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, cycleOperations({
    openCases: [{ public_case_id: 'CASE-A', stage: 'CASE_CHECK_PAYMENT_PENDING' }],
    winner: { public_case_id: 'CASE-B' },
    monitor: async (_, record) => { monitored.push(record.public_case_id); return { ok: true, action: 'WAITING_FOR_REPLY', caseId: record.public_case_id }; },
    sendWinner: async (_, row) => { outreach += 1; return { ok: true, action: 'OUTREACH_SENT', caseId: row.public_case_id }; }
  }));
  assert.deepEqual(monitored, ['CASE-A']);
  assert.equal(outreach, 1);
  assert.equal(result.acquisition.caseId, 'CASE-B');
  assert.equal(result.acquisition.quota.max, 1);
});

test('two open cases with distinct inbound replies are both processed in one cycle', async () => {
  const replies = new Set();
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, cycleOperations({
    openCases: [
      { public_case_id: 'CASE-A', stage: 'OUTREACH_SENT', inbound: 'gmail-a' },
      { public_case_id: 'CASE-B', stage: 'TERMS_SENT', inbound: 'gmail-b' }
    ],
    quotaAvailable: false,
    monitor: async (_, record) => {
      replies.add(record.inbound);
      return { ok: true, action: 'REPLY_RECORDED', caseId: record.public_case_id };
    }
  }));
  assert.deepEqual([...replies], ['gmail-a', 'gmail-b']);
  assert.equal(result.monitoring.attempted, 2);
  assert.equal(result.monitoring.succeeded, 2);
});

test('one monitor failure is isolated while other cases and safe acquisition continue', async () => {
  const monitored = [];
  let outreach = 0;
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, cycleOperations({
    openCases: [{ public_case_id: 'CASE-A' }, { public_case_id: 'CASE-B' }],
    winner: { public_case_id: 'CASE-C' },
    monitor: async (_, record) => {
      monitored.push(record.public_case_id);
      if (record.public_case_id === 'CASE-A') throw new Error('CASE_MONITOR_FAILED');
      return { ok: true, action: 'WAITING_FOR_REPLY', caseId: record.public_case_id };
    },
    sendWinner: async () => { outreach += 1; return { ok: true, action: 'OUTREACH_SENT', caseId: 'CASE-C' }; }
  }));
  assert.deepEqual(monitored, ['CASE-A', 'CASE-B']);
  assert.equal(result.monitoring.failed, 1);
  assert.equal(outreach, 1);
  assert.equal(result.action, 'OUTREACH_SENT');
});

test('reached daily quota still monitors all open cases and sends no outreach', async () => {
  let monitored = 0;
  let selected = 0;
  const operations = cycleOperations({
    openCases: [{ public_case_id: 'CASE-A' }, { public_case_id: 'CASE-B' }],
    quotaAvailable: false,
    monitor: async (_, record) => { monitored += 1; return { ok: true, action: 'WAITING_FOR_REPLY', caseId: record.public_case_id }; }
  });
  operations.currentWinner = async () => { selected += 1; return { public_case_id: 'CASE-C' }; };
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, operations);
  assert.equal(monitored, 2);
  assert.equal(selected, 0);
  assert.equal(result.action, 'DAILY_OUTREACH_CAP_REACHED');
});

test('borderline case-check candidates remain pending for owner review and never consume outreach quota', async () => {
  let outreach = 0;
  let checkout = 0;
  let replies = 0;
  let inboundPending = true;
  const operations = cycleOperations({
    openCases: [{ public_case_id: 'CASE-A', stage: 'RESPONSE_REVIEW' }],
    monitor: async (_, record) => {
      if (inboundPending) { inboundPending = false; replies += 1; return { ok: true, action: 'OWNER_ATTENTION_REQUIRED', caseId: record.public_case_id }; }
      return { ok: true, action: 'WAITING_FOR_REPLY', caseId: record.public_case_id };
    },
    sendCaseCheck: async () => {
      checkout += 1;
      outreach += 1;
      return { ok: true, action: 'CASE_CHECK_OFFER_SENT' };
    }
  });
  operations.currentWinner = async () => null;
  operations.currentCaseCheckCandidate = async () => ({ public_case_id: 'CASE-B' });
  const first = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, operations);
  const second = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, operations);
  assert.equal(first.action, 'PENDING_OWNER_REVIEW');
  assert.equal(second.action, 'PENDING_OWNER_REVIEW');
  assert.equal(outreach, 0);
  assert.equal(checkout, 0);
  assert.equal(replies, 1);
});

test('case-check payment waiting remains open and does not block another daily candidate', async () => {
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, cycleOperations({
    openCases: [{ public_case_id: 'CASE-A', stage: 'CASE_CHECK_PAYMENT_PENDING' }],
    winner: { public_case_id: 'CASE-B' }
  }));
  assert.equal(result.monitoring.results[0].stage, 'CASE_CHECK_PAYMENT_PENDING');
  assert.equal(result.acquisition.caseId, 'CASE-B');
});

test('success-fee payment waiting remains monitored and does not block another daily candidate', async () => {
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, cycleOperations({
    openCases: [{ public_case_id: 'CASE-A', stage: 'PAYMENT_PENDING' }],
    winner: { public_case_id: 'CASE-B' }
  }));
  assert.equal(result.monitoring.results[0].stage, 'PAYMENT_PENDING');
  assert.equal(result.acquisition.caseId, 'CASE-B');
});

test('duplicate open rows are monitored at most once per cycle', async () => {
  let monitored = 0;
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, cycleOperations({
    openCases: [{ public_case_id: 'CASE-A' }, { public_case_id: 'CASE-A' }],
    quotaAvailable: false,
    monitor: async () => { monitored += 1; return { ok: true, action: 'WAITING_FOR_REPLY', caseId: 'CASE-A' }; }
  }));
  assert.equal(monitored, 1);
  assert.equal(result.monitoring.attempted, 1);
});

test('all non-negative replies stop automation and require owner attention', () => {
  assert.match(autopilot, /stage = 'RESPONSE_REVIEW'/);
  assert.match(autopilot, /OWNER_ATTENTION_REQUIRED/);
  assert.match(autopilot, /INBOUND_REQUIRES_OWNER/);
  assert.match(autopilot, /RECIPIENT_OPT_OUT/);
  assert.match(autopilot, /suppressRecipient/);
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
  assert.match(wrangler, /AUTOPILOT_AUTO_APPROVE_ENABLED = "true"/);
  assert.match(wrangler, /AUTOPILOT_FOLLOWUP_HOURS = "12"/);
  assert.match(wrangler, /AUTOPILOT_MAX_CONTACTS_PER_CASE = "2"/);
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
