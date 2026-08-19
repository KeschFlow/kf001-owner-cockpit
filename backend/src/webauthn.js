const textEncoder = new TextEncoder();

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return b64url(value);
}

async function sha256Bytes(value) {
  const input = typeof value === 'string' ? textEncoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

async function sha256B64url(value) {
  return b64url(await sha256Bytes(value));
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export async function payloadHash(payload) {
  return sha256B64url(canonical(payload));
}

function rp(env) {
  return {
    id: env.WEBAUTHN_RP_ID,
    name: env.WEBAUTHN_RP_NAME || 'KF-001 Owner Cockpit',
    origin: env.WEBAUTHN_ORIGIN
  };
}

async function saveChallenge(env, purpose, payload = null) {
  const challenge = randomToken(32);
  const challengeId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const hash = payload === null ? null : await payloadHash(payload);
  await env.CASE_DB.prepare(`
    INSERT INTO webauthn_challenges (challenge_id, challenge, purpose, payload_hash, expires_at, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(challengeId, challenge, purpose, hash, expires, now.toISOString()).run();
  return { challengeId, challenge };
}

async function loadChallenge(env, challengeId, purpose, payload = null) {
  const row = await env.CASE_DB.prepare(`
    SELECT challenge_id, challenge, purpose, payload_hash, expires_at, consumed_at
    FROM webauthn_challenges
    WHERE challenge_id = ?1 AND consumed_at IS NULL
  `).bind(challengeId).first();
  if (!row) throw new Error('WEBAUTHN_CHALLENGE_NOT_FOUND_OR_CONSUMED');
  if (row.purpose !== purpose) throw new Error('WEBAUTHN_PURPOSE_MISMATCH');
  if (Date.parse(row.expires_at) < Date.now()) throw new Error('WEBAUTHN_CHALLENGE_EXPIRED');
  if (payload !== null) {
    const hash = await payloadHash(payload);
    if (hash !== row.payload_hash) throw new Error('WEBAUTHN_PAYLOAD_MISMATCH');
  }
  return row;
}

async function consumeChallenge(env, challengeId) {
  const result = await env.CASE_DB.prepare(`
    UPDATE webauthn_challenges
       SET consumed_at = ?2
     WHERE challenge_id = ?1 AND consumed_at IS NULL
  `).bind(challengeId, new Date().toISOString()).run();
  if (Number(result.meta?.changes || 0) !== 1) throw new Error('WEBAUTHN_CHALLENGE_RACE_CONSUMED');
}

function parseClientData(clientDataJSON) {
  const bytes = fromB64url(clientDataJSON);
  const json = new TextDecoder().decode(bytes);
  return { bytes, data: JSON.parse(json) };
}

async function verifyClientData(clientDataJSON, expectedType, expectedChallenge, env) {
  const { bytes, data } = parseClientData(clientDataJSON);
  if (data.type !== expectedType) throw new Error('WEBAUTHN_CLIENT_TYPE_MISMATCH');
  if (data.challenge !== expectedChallenge) throw new Error('WEBAUTHN_CHALLENGE_MISMATCH');
  if (data.origin !== rp(env).origin) throw new Error('WEBAUTHN_ORIGIN_MISMATCH');
  return bytes;
}

async function verifyAuthenticatorData(authenticatorDataB64, env, requireUV = true) {
  const bytes = fromB64url(authenticatorDataB64);
  if (bytes.length < 37) throw new Error('WEBAUTHN_AUTH_DATA_INVALID');
  const expectedRpHash = await sha256Bytes(rp(env).id);
  for (let i = 0; i < 32; i += 1) {
    if (bytes[i] !== expectedRpHash[i]) throw new Error('WEBAUTHN_RP_ID_MISMATCH');
  }
  const flags = bytes[32];
  if ((flags & 0x01) === 0) throw new Error('WEBAUTHN_USER_PRESENCE_REQUIRED');
  if (requireUV && (flags & 0x04) === 0) throw new Error('WEBAUTHN_USER_VERIFICATION_REQUIRED');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const counter = view.getUint32(33, false);
  return { bytes, counter };
}

function derEcdsaToRaw(signature) {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  if (bytes[0] !== 0x30) return bytes;
  let offset = 2;
  if (bytes[1] & 0x80) offset = 2 + (bytes[1] & 0x7f);
  if (bytes[offset] !== 0x02) throw new Error('WEBAUTHN_ECDSA_SIGNATURE_INVALID');
  const rLen = bytes[offset + 1];
  let r = bytes.slice(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  if (bytes[offset] !== 0x02) throw new Error('WEBAUTHN_ECDSA_SIGNATURE_INVALID');
  const sLen = bytes[offset + 1];
  let s = bytes.slice(offset + 2, offset + 2 + sLen);
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

async function importCredentialKey(spki, algorithm) {
  if (algorithm === -7) {
    return crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  if (algorithm === -257) {
    return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  throw new Error('WEBAUTHN_ALGORITHM_UNSUPPORTED');
}

async function verifySignature({ publicKey, algorithm, authenticatorData, clientDataJSON, signature }) {
  const clientHash = await sha256Bytes(clientDataJSON);
  const signed = new Uint8Array(authenticatorData.length + clientHash.length);
  signed.set(authenticatorData, 0);
  signed.set(clientHash, authenticatorData.length);
  const key = await importCredentialKey(publicKey, algorithm);
  const sig = algorithm === -7 ? derEcdsaToRaw(signature) : signature;
  const params = algorithm === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  return crypto.subtle.verify(params, key, sig, signed);
}

function assertBootstrap(request, env) {
  if (!env.OWNER_BOOTSTRAP_TOKEN) throw new Error('OWNER_BOOTSTRAP_NOT_CONFIGURED');
  const authorization = request.headers.get('Authorization') || '';
  if (authorization !== `Bearer ${env.OWNER_BOOTSTRAP_TOKEN}`) throw new Error('OWNER_BOOTSTRAP_UNAUTHORIZED');
}

export async function ownerStatus(env) {
  const row = await env.CASE_DB.prepare('SELECT COUNT(*) AS count FROM owner_credentials').first();
  return { enrolled: Number(row?.count || 0) > 0, credentialCount: Number(row?.count || 0) };
}

export async function registrationOptions(request, env) {
  assertBootstrap(request, env);
  const status = await ownerStatus(env);
  if (status.enrolled) throw new Error('OWNER_ALREADY_ENROLLED');
  const { challengeId, challenge } = await saveChallenge(env, 'OWNER_REGISTER');
  const userId = randomToken(32);
  return {
    challengeId,
    options: {
      challenge,
      rp: { id: rp(env).id, name: rp(env).name },
      user: { id: userId, name: 'owner', displayName: 'KF-001 Owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      timeout: 120000,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: []
    }
  };
}

export async function verifyRegistration(request, env, body) {
  assertBootstrap(request, env);
  const status = await ownerStatus(env);
  if (status.enrolled) throw new Error('OWNER_ALREADY_ENROLLED');
  const challengeRow = await loadChallenge(env, body.challengeId, 'OWNER_REGISTER');
  const expectedChallenge = challengeRow.challenge;
  const response = body.response || {};
  await verifyClientData(response.response?.clientDataJSON, 'webauthn.create', expectedChallenge, env);
  await verifyAuthenticatorData(response.response?.authenticatorData, env, true);
  const credentialId = String(response.id || '');
  const algorithm = Number(response.response?.publicKeyAlgorithm);
  const publicKey = fromB64url(response.response?.publicKey);
  if (!credentialId || !publicKey.length || ![-7, -257].includes(algorithm)) throw new Error('WEBAUTHN_REGISTRATION_DATA_INVALID');
  await consumeChallenge(env, body.challengeId);
  const now = new Date().toISOString();
  await env.CASE_DB.prepare(`
    INSERT INTO owner_credentials (credential_id, public_key_spki, algorithm, counter, transports, created_at, updated_at)
    VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)
  `).bind(credentialId, publicKey.buffer, algorithm, JSON.stringify(response.response?.transports || []), now).run();
  return { verified: true, enrolled: true, credentialCount: 1 };
}

export async function authenticationOptions(env, purpose, payload = null) {
  const rows = await env.CASE_DB.prepare('SELECT credential_id, transports FROM owner_credentials ORDER BY created_at ASC').all();
  if (!rows.results?.length) throw new Error('OWNER_NOT_ENROLLED');
  const { challengeId, challenge } = await saveChallenge(env, purpose, payload);
  return {
    challengeId,
    options: {
      challenge,
      rpId: rp(env).id,
      timeout: 120000,
      userVerification: 'required',
      allowCredentials: rows.results.map((row) => ({
        type: 'public-key',
        id: row.credential_id,
        transports: JSON.parse(row.transports || '[]')
      }))
    }
  };
}

export async function verifyOwnerAssertion(env, auth, purpose, payload = null) {
  if (!auth?.challengeId || !auth?.response?.id) throw new Error('WEBAUTHN_ASSERTION_MISSING');
  const challengeRow = await loadChallenge(env, auth.challengeId, purpose, payload);
  const expectedChallenge = challengeRow.challenge;
  const response = auth.response;
  const credential = await env.CASE_DB.prepare(`
    SELECT credential_id, public_key_spki, algorithm, counter, transports
    FROM owner_credentials WHERE credential_id = ?1
  `).bind(response.id).first();
  if (!credential) throw new Error('WEBAUTHN_CREDENTIAL_UNKNOWN');
  const clientBytes = await verifyClientData(response.response?.clientDataJSON, 'webauthn.get', expectedChallenge, env);
  const authData = await verifyAuthenticatorData(response.response?.authenticatorData, env, true);
  const signature = fromB64url(response.response?.signature);
  const publicKey = new Uint8Array(credential.public_key_spki);
  const verified = await verifySignature({
    publicKey,
    algorithm: Number(credential.algorithm),
    authenticatorData: authData.bytes,
    clientDataJSON: clientBytes,
    signature
  });
  if (!verified) throw new Error('WEBAUTHN_SIGNATURE_INVALID');
  const oldCounter = Number(credential.counter || 0);
  if (oldCounter > 0 && authData.counter <= oldCounter) throw new Error('WEBAUTHN_COUNTER_INVALID');
  await consumeChallenge(env, auth.challengeId);
  await env.CASE_DB.prepare('UPDATE owner_credentials SET counter = ?2, updated_at = ?3 WHERE credential_id = ?1')
    .bind(credential.credential_id, authData.counter, new Date().toISOString()).run();
  return { verified: true, credentialId: credential.credential_id };
}
