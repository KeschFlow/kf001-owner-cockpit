import test from 'node:test';
import assert from 'node:assert/strict';
import { derEcdsaToRaw } from '../src/webauthn.js';

test('ES256 DER conversion preserves r and s in separate 32-byte halves', () => {
  const der = Uint8Array.from(Buffer.from(
    '3045022100ce8a5444cd3f3f05628d807bb5dae417f207c93d30d708a9b71cb7775918caa602205e9e23be3c02e4d5a45d378f7a662826318e9b459220f5b4c79614ca08e0bea2',
    'hex'
  ));

  const raw = derEcdsaToRaw(der);

  assert.equal(raw.length, 64);
  assert.equal(
    Buffer.from(raw).toString('hex'),
    'ce8a5444cd3f3f05628d807bb5dae417f207c93d30d708a9b71cb7775918caa65e9e23be3c02e4d5a45d378f7a662826318e9b459220f5b4c79614ca08e0bea2'
  );
});

test('ES256 DER conversion pads short integers into the correct half', () => {
  const der = Uint8Array.from(Buffer.from('3006020101020102', 'hex'));
  const raw = derEcdsaToRaw(der);

  assert.equal(raw.length, 64);
  assert.equal(raw[31], 1);
  assert.equal(raw[63], 2);
  assert.equal(raw.slice(0, 31).every((value) => value === 0), true);
  assert.equal(raw.slice(32, 63).every((value) => value === 0), true);
});
