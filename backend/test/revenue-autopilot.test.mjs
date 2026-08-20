import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilot = fs.readFileSync(path.join(here, '..', 'src', 'revenue-autopilot.js'), 'utf8');
const workerV3 = fs.readFileSync(path.join(here, '..', 'src', 'worker-v3.js'), 'utf8');
const wrangler = fs.readFileSync(path.join(here, '..', 'wrangler.toml'), 'utf8');
const gmail = fs.readFileSync(path.join(here, '..', 'src', 'gmail.js'), 'utf8');

test('revenue autopilot sends only a hard-qualified current winner and caps new outreach', () => {
  assert.match(autopilot, /e\.economically_qualified = 1/);
  assert.match(autopilot, /e\.economic_score >= \?1/);
  assert.match(autopilot, /e\.amount_approx_usd >= \?2/);
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

test('success fee is requested only after success amount meets the threshold and a payment link exists', () => {
  assert.match(autopilot, /recovered < minValue/);
  assert.match(autopilot, /PAYMENT_LINK_NOT_CONFIGURED/);
  assert.match(autopilot, /stage = 'PAYMENT_PENDING'/);
  assert.match(autopilot, /SUCCESS_FEE_EUR/);
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

test('production config enables one-case revenue autopilot with EUR 750 success fee', () => {
  assert.match(wrangler, /REVENUE_AUTOPILOT_ENABLED = "true"/);
  assert.match(wrangler, /AUTOPILOT_MAX_NEW_OUTREACH_PER_DAY = "1"/);
  assert.match(wrangler, /SUCCESS_FEE_EUR = "750"/);
});
