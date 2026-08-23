import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const autopilotPath = path.join(root, 'src', 'revenue-autopilot.js');
const testPath = path.join(root, 'test', 'revenue-autopilot.test.mjs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`PATCH_ANCHOR_MISSING:${label}`);
  return source.replace(before, after);
}

let s = fs.readFileSync(autopilotPath, 'utf8');

s = replaceOnce(s, `async function monitorOpenCase(env, record) {
  if (!record.gmail_thread_id || !record.initial_sent_at) return { ok: false, reason: 'THREAD_NOT_READY' };
  let thread;
  try {
    thread = await getGmailThread(env, record.gmail_thread_id);
  } catch (error) {
    const code = clean(error.message || 'GMAIL_THREAD_FAILED', 120);
    await env.CASE_DB.prepare(\`
      UPDATE revenue_autopilot SET stage = 'REPLY_MONITOR_BLOCKED', error_code = ?2, updated_at = ?3
      WHERE public_case_id = ?1 AND stage NOT IN ('PAYMENT_PENDING')
    \`).bind(record.public_case_id, code, nowIso()).run();
    return { ok: false, reason: code, caseId: record.public_case_id };
  }

  const messages = inboundMessages(thread, record.recipient_email, record.initial_sent_at);
`, `async function monitorOpenCase(env, record) {
  // Payment collection is webhook-driven and must never depend on Gmail read scope.
  // Recover a case-check checkout that an older worker incorrectly moved to REPLY_MONITOR_BLOCKED.
  const isCaseCheckPayment = String(record.offer_type || '') === 'CASE_CHECK_49'
    && String(record.payment_status || '') === 'REQUESTED'
    && Boolean(record.stripe_checkout_session_id);
  if (isCaseCheckPayment && String(record.stage) === 'REPLY_MONITOR_BLOCKED') {
    await env.CASE_DB.prepare(\`
      UPDATE revenue_autopilot
         SET stage = 'CASE_CHECK_PAYMENT_PENDING', error_code = NULL, updated_at = ?2
       WHERE public_case_id = ?1 AND stage = 'REPLY_MONITOR_BLOCKED'
    \`).bind(record.public_case_id, nowIso()).run();
    record = { ...record, stage: 'CASE_CHECK_PAYMENT_PENDING', error_code: null };
  }

  if (record.stage === 'CASE_CHECK_PAYMENT_PENDING') {
    const expiresAt = Date.parse(record.checkout_expires_at || '');
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      await env.CASE_DB.prepare(\`
        UPDATE revenue_autopilot SET stage = 'CLOSED_NO_RESPONSE', updated_at = ?2
         WHERE public_case_id = ?1 AND stage = 'CASE_CHECK_PAYMENT_PENDING'
      \`).bind(record.public_case_id, nowIso()).run();
      return { ok: true, action: 'CASE_CHECK_EXPIRED', caseId: record.public_case_id };
    }
    return { ok: true, action: 'WAITING_FOR_PAYMENT', caseId: record.public_case_id, stage: record.stage };
  }

  if (record.stage === 'PAYMENT_PENDING') {
    return { ok: true, action: 'WAITING_FOR_PAYMENT', caseId: record.public_case_id, stage: record.stage };
  }

  if (!record.gmail_thread_id || !record.initial_sent_at) return { ok: false, reason: 'THREAD_NOT_READY' };
  let thread;
  try {
    thread = await getGmailThread(env, record.gmail_thread_id);
  } catch (error) {
    const code = clean(error.message || 'GMAIL_THREAD_FAILED', 120);
    await env.CASE_DB.prepare(\`
      UPDATE revenue_autopilot SET stage = 'REPLY_MONITOR_BLOCKED', error_code = ?2, updated_at = ?3
      WHERE public_case_id = ?1 AND stage NOT IN ('PAYMENT_PENDING','CASE_CHECK_PAYMENT_PENDING')
    \`).bind(record.public_case_id, code, nowIso()).run();
    // Missing Gmail read scope degrades reply handling but must not stop checkout revenue acquisition.
    return {
      ok: code === 'GMAIL_READ_SCOPE_REQUIRED',
      action: code === 'GMAIL_READ_SCOPE_REQUIRED' ? 'REPLY_MONITOR_DEGRADED' : 'REPLY_MONITOR_FAILED',
      reason: code,
      caseId: record.public_case_id
    };
  }

  const messages = inboundMessages(thread, record.recipient_email, record.initial_sent_at);
`, 'monitorOpenCase');

s = s.replace(`  if (record.stage === 'CASE_CHECK_PAYMENT_PENDING') {
    const expiresAt = Date.parse(record.checkout_expires_at || '');
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      await env.CASE_DB.prepare(\`
        UPDATE revenue_autopilot SET stage = 'CLOSED_NO_RESPONSE', updated_at = ?2
         WHERE public_case_id = ?1 AND stage = 'CASE_CHECK_PAYMENT_PENDING'
      \`).bind(record.public_case_id, nowIso()).run();
      return { ok: true, action: 'CASE_CHECK_EXPIRED', caseId: record.public_case_id };
    }
  }

`, '');

s = replaceOnce(s, `async function acquireDailyCandidate(env, operations = {}) {
  const quotaStatus = operations.dailyQuotaStatus || dailyQuotaStatus;
  const selectWinner = operations.currentWinner || currentWinner;
  const sendWinner = operations.sendInitialOutreach || sendInitialOutreach;
  const selectCaseCheck = operations.currentCaseCheckCandidate || currentCaseCheckCandidate;
  const sendCaseCheck = operations.sendCaseCheckOffer || sendCaseCheckOffer;

  const quota = await quotaStatus(env);
  if (!quota.available) return { ok: true, action: 'DAILY_OUTREACH_CAP_REACHED', quota };

  const winner = await selectWinner(env);
  if (winner) return { ...(await sendWinner(env, winner)), quota };

  const caseCheckCandidate = await selectCaseCheck(env);
  if (caseCheckCandidate) return { ...(await sendCaseCheck(env, caseCheckCandidate)), quota };

  return { ok: true, action: 'NO_WINNER', quota };
}
`, `async function acquireDailyCandidate(env, operations = {}) {
  const quotaStatus = operations.dailyQuotaStatus || dailyQuotaStatus;
  const selectWinner = operations.currentWinner || currentWinner;
  const sendWinner = operations.sendInitialOutreach || sendInitialOutreach;
  const selectCaseCheck = operations.currentCaseCheckCandidate || currentCaseCheckCandidate;
  const sendCaseCheck = operations.sendCaseCheckOffer || sendCaseCheckOffer;
  const preferCheckoutOnly = Boolean(operations.preferCheckoutOnly);

  const quota = await quotaStatus(env);
  if (!quota.available) return { ok: true, action: 'DAILY_OUTREACH_CAP_REACHED', quota };

  // If Gmail reads are unavailable, preserve autonomous revenue by using the direct Stripe offer.
  if (preferCheckoutOnly) {
    const caseCheckCandidate = await selectCaseCheck(env);
    if (caseCheckCandidate) return { ...(await sendCaseCheck(env, caseCheckCandidate)), quota, mode: 'CHECKOUT_ONLY_DEGRADED' };
    return { ok: true, action: 'NO_CHECKOUT_CANDIDATE', quota, mode: 'CHECKOUT_ONLY_DEGRADED' };
  }

  const winner = await selectWinner(env);
  if (winner) return { ...(await sendWinner(env, winner)), quota };

  const caseCheckCandidate = await selectCaseCheck(env);
  if (caseCheckCandidate) return { ...(await sendCaseCheck(env, caseCheckCandidate)), quota };

  return { ok: true, action: 'NO_WINNER', quota };
}
`, 'acquireDailyCandidate');

s = replaceOnce(s, `  const monitoring = await monitorOpenCases(env, openCases, monitorCase);
  const acquisition = await acquireDailyCandidate(env, operations);
`, `  const monitoring = await monitorOpenCases(env, openCases, monitorCase);
  const gmailReadBlocked = monitoring.results.some((result) => result?.reason === 'GMAIL_READ_SCOPE_REQUIRED');
  const acquisition = await acquireDailyCandidate(env, { ...operations, preferCheckoutOnly: gmailReadBlocked });
`, 'runAutopilotCycle');

fs.writeFileSync(autopilotPath, s);

let t = fs.readFileSync(testPath, 'utf8');
t = t.replace(
  "  assert.match(autopilot, /const acquisition = await acquireDailyCandidate\\(env, operations\\)/);",
  "  assert.match(autopilot, /const acquisition = await acquireDailyCandidate\\(env, \\{ \\.\\.\\.operations, preferCheckoutOnly: gmailReadBlocked \\}\\)/);"
);

const anchor = "test('two open cases with distinct inbound replies are both processed in one cycle', async () => {";
const added = `test('gmail read scope failure degrades reply monitoring without blocking acquisition', async () => {
  let caseCheckSent = 0;
  const result = await REVENUE_AUTOPILOT_INTERNALS.runAutopilotCycle({}, cycleOperations({
    openCases: [{ public_case_id: 'CASE-A', stage: 'OUTREACH_SENT' }],
    caseCheck: { public_case_id: 'CASE-B' },
    monitor: async (_, record) => ({
      ok: true,
      action: 'REPLY_MONITOR_DEGRADED',
      reason: 'GMAIL_READ_SCOPE_REQUIRED',
      caseId: record.public_case_id
    }),
    sendCaseCheck: async (_, row) => {
      caseCheckSent += 1;
      return { ok: true, action: 'CASE_CHECK_OFFER_SENT', caseId: row.public_case_id };
    }
  }));
  assert.equal(result.ok, true);
  assert.equal(result.action, 'CASE_CHECK_OFFER_SENT');
  assert.equal(result.acquisition.mode, 'CHECKOUT_ONLY_DEGRADED');
  assert.equal(caseCheckSent, 1);
});

test('checkout payment stages are independent of Gmail reads', () => {
  assert.match(autopilot, /record\\.stage === 'CASE_CHECK_PAYMENT_PENDING'/);
  assert.match(autopilot, /record\\.stage === 'PAYMENT_PENDING'/);
  assert.match(autopilot, /action: 'WAITING_FOR_PAYMENT'/);
  assert.match(autopilot, /stage NOT IN \\('PAYMENT_PENDING','CASE_CHECK_PAYMENT_PENDING'\\)/);
  assert.match(autopilot, /isCaseCheckPayment/);
});

`;
if (!t.includes("gmail read scope failure degrades reply monitoring")) {
  if (!t.includes(anchor)) throw new Error('PATCH_ANCHOR_MISSING:tests');
  t = t.replace(anchor, added + anchor);
}
fs.writeFileSync(testPath, t);
console.log('Revenue-without-Gmail-read patch applied.');
