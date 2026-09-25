import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const governance = fs.readFileSync(path.join(root, 'governance.js'), 'utf8');
const slim = fs.readFileSync(path.join(root, 'slim-owner-ui.js'), 'utf8');

test('successful passkey verification rerenders owner auth and the decision gate', () => {
  const verify = governance.slice(
    governance.indexOf('async function verifyOwnerPasskey'),
    governance.indexOf('function renderOwnerGate')
  );
  assert.match(verify, /renderOwnerAuth\(\)/);
  assert.match(verify, /renderOwnerGate\(\)/);
  assert.match(verify, /kf001:owner-verified/);
  assert.match(governance, /section\.dataset\.ownerVerified/);
  assert.match(governance, /ownerAuthState\.enrolled && !ownerAuthState\.verified/);
});

test('Fall öffnen and Entscheidung öffnen target the owner decision gate, not the diagnostic passkey button', () => {
  assert.match(slim, /function focusDecisionGate/);
  assert.match(slim, /if \(focusDecisionGate\(\)\) return/);
  assert.match(slim, /if \(approve && reject && !approve\.disabled\) \{\s*focusDecisionGate\(\)/);
  const authRouting = slim.slice(slim.indexOf('const needsAction ='), slim.indexOf('const gateText ='));
  assert.match(authRouting, /registerPasskeyBtn/);
  assert.doesNotMatch(authRouting, /verifyPasskeyBtn.*\|\|/);
  assert.match(slim, /kf001:owner-verified/);
});

test('owner cockpit uses D1-backed autopilot metrics and exposes the passkey kill switch', () => {
  assert.match(slim, /autopilotStatusPath/);
  assert.match(slim, /realizedRevenueEur/);
  assert.match(slim, /checkoutViews/);
  assert.match(slim, /AUTOPILOT_KILL_SWITCH/);
  assert.match(slim, /autopilotKillSwitchPath/);
});
