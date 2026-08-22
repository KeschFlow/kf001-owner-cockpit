import test from 'node:test';
import assert from 'node:assert/strict';
import { automatedOrDigestIssue, explicitPublicEmail } from '../src/radar.js';

test('public business account address is valid provenance while consumer account address stays fail-closed', () => {
  assert.equal(
    explicitPublicEmail('Account: billing@company.example. The public billing report remains unresolved.'),
    'billing@company.example'
  );
  assert.equal(
    explicitPublicEmail('Account: private-person@gmail.com. The public billing report remains unresolved.'),
    null
  );
});

test('explicit contact invitations remain supported', () => {
  assert.equal(explicitPublicEmail('You can reach me at owner@company.example about this case.'), 'owner@company.example');
});

test('bots and generated digests are excluded before radar scoring', () => {
  assert.equal(automatedOrDigestIssue({ user: { login: 'github-actions[bot]', type: 'Bot' } }, 'Billing issue', ''), true);
  assert.equal(automatedOrDigestIssue({ user: { login: 'person', type: 'User' } }, 'AI CLI Tools Digest', 'Generated list'), true);
  assert.equal(automatedOrDigestIssue({ user: { login: 'person', type: 'User' } }, 'Unexpected auto-charge', 'Real billing report'), false);
});
