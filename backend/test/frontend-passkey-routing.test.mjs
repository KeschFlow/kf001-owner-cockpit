import test from 'node:test';
import { loadSlimUi } from './helpers/slim-ui.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const governance = fs.readFileSync(path.join(root, 'governance.js'), 'utf8');

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

test('intervention opens the real owner decision gate without triggering diagnostic passkey verification', async () => {
  const ui = await loadSlimUi({owner: {caseId: 'CASE-1', status: 'PENDING_APPROVAL'}});
  assert.equal(ui.get('slimIntervention').hidden, false);
  assert.equal(ui.get('slimNoAction').hidden, true);
  assert.equal(ui.get('slimDecisionRuntime').hidden, true);
  assert.ok(ui.get('slimDecisionRuntime').children.includes(ui.gate));
  await ui.get('slimInterventionBtn').click();
  assert.equal(ui.get('slimDecisionRuntime').hidden, false);
  assert.equal(ui.get('slimDecisionRuntime').scrolled, true);
  assert.equal(ui.diagnosticClicks, 0);
  assert.equal(ui.assertions.length, 0);
});

test('owner cockpit uses backend revenue metrics and requires a passkey assertion for the kill switch', async () => {
  const ui = await loadSlimUi();
  const money = new Intl.NumberFormat('de-DE', {style: 'currency', currency: 'EUR'});
  assert.equal(ui.get('slimRevenue').textContent, money.format(123.45));
  assert.equal(ui.get('slimOpenRevenue').textContent, money.format(67.89));
  assert.ok(ui.calls.some(c => c.url === 'https://backend.example/v1/autopilot/status'));
  await ui.get('slimControlBtn').click();
  assert.equal(ui.assertions.length, 1);
  assert.equal(ui.assertions[0].action, 'AUTOPILOT_KILL_SWITCH');
  assert.equal(ui.assertions[0].payload.outreachEnabled, false);
  const write = ui.calls.find(c => c.options.method === 'POST');
  assert.equal(write.url, 'https://backend.example/v1/autopilot/kill-switch');
  assert.deepEqual(JSON.parse(write.options.body), {outreachEnabled: false, auth: {credential: 'test-assertion'}});
  assert.equal(ui.get('slimSystem').textContent, 'VERSAND GESTOPPT');
  assert.equal(ui.get('slimControlBtn').disabled, false);
  const denied = await loadSlimUi({assertionError: true});
  await denied.get('slimControlBtn').click();
  assert.equal(denied.calls.filter(c => c.options.method === 'POST').length, 0);
  assert.equal(denied.get('slimSystem').textContent, 'VERBINDUNG PRÜFEN');
  assert.equal(denied.get('slimControlBtn').disabled, false);
});
