import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/webauthn.js', import.meta.url), 'utf8');

test('WebAuthn verification uses PUBLIC_APP_ORIGIN as authoritative browser origin', () => {
  assert.match(source, /normalizedPublicOrigin\(env\)/);
  assert.match(source, /env\.PUBLIC_APP_ORIGIN/);
  assert.doesNotMatch(source, /origin:\s*env\.WEBAUTHN_ORIGIN/);
  assert.match(source, /if \(data\.origin !== rp\(env\)\.origin\) throw new Error\('WEBAUTHN_ORIGIN_MISMATCH'\)/);
});
