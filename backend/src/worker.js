import {
  authenticationOptions,
  ownerStatus,
  registrationOptions,
  verifyOwnerAssertion,
  verifyRegistration
} from './webauthn.js';
import { gmailConfigured, sendGmail } from './gmail.js';

const ALLOWED_PUBLIC_FIELDS = new Set([
  'caseId',
  'caseValueScore',
  'outreachReady',
  'impactClass',
  'evidenceQuality',
  'recommendation',
  'outreachMessage',
  'status',
  'version'
]);

const ALLOWED_STATUSES = new Set([
  'PENDING_APPROVAL',
  'APPROVED_PENDING_DISPATCH',
  'DISPATCHED',
  'RESPONSE_RECEIVED',
  'REJECTED'
]);

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  }
});

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== env.PUBLIC_APP_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function isAuthorizedRadarRequest(request, env) {
  if (!env.RADAR_INGEST_TOKEN) return false;
  const authorization = request.headers.get('Authorization') || '';
  return authorization === `Bearer ${env.RADAR_INGEST_TOKEN}`;
}

function validEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePublicCase(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_BODY');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_PUBLIC_FIELDS.has(key)) throw new Error(`FIELD_NOT_ALLOWED:${key}`);
  }
  if (!/^PUB-[A-Z0-9-]{3,40}$/.test(input.caseId || '')) throw new Error('INVALID_CASE_ID');
  if (!ALLOWED_STATUSES.has(input.status)) throw new Error('INVALID_STATUS');
  if (input.caseValueScore !== null && input.caseValueScore !== undefined) {
    if (!Number.isInteger(input.caseValueScore) || input.caseValueScore < 0 || input.caseValueScore > 100) {
      throw new Error('INVALID_CASE_VALUE_SCORE');
    }
  }
  if (typeof input.outreachReady !== 'boolean') throw new Error('INVALID_OUTREACH_READY');
  for (const key of ['impactClass', 'evidenceQuality', 'recommendation', 'outreachMessage']) {
    if (typeof input[key] !== 'string' || input[key].length < 1 || input[key].length > 500) {
      throw new Error(`INVALID_${key.toUpperCase()}`);
    }
  }
  return {
    caseId: input.caseId,
    caseValueScore: input.caseValueScore ?? null,
    outreachReady: input.outreachReady,
    impactClass: input.impactClass,
    evidenceQuality: input.evidenceQuality,
    recommendation: input.recommendation,
    outreachMessage: input.outreachMessage,
    status: input.status,
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1
  };
}

async function readOwnerState(env) {
  const row = await env.CASE_DB.prepare(`
    SELECT public_case_id, case_value_score, outreach_ready, impact_class,
           evidence_quality, recommendation, outreach_message, status,
           version, updated_at
      FROM cases
     WHERE is_active = 1
     ORDER BY updated_at DESC
     LIMIT 1
  `).first();
  if (!row) return null;
  return {
    caseId: row.public_case_id,
    caseValueScore: row.case_value_score ?? 'PRIVATE / NOT EXPOSED',
    outreachReady: Boolean(row.outreach_ready),
    impactClass: row.impact_class,
    evidenceQuality: row.evidence_quality,
    recommendation: row.recommendation,
    outreachMessage: row.outreach_message,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at
  };
}

async function upsertRadarCase(request, env) {
  if (!isAuthorizedRadarRequest(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  let input;
  try {
    input = validatePublicCase(await request.json());
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  const now = new Date().toISOString();
  await env.CASE_DB.batch([
    env.CASE_DB.prepare('UPDATE cases SET is_active = 0 WHERE is_active = 1 AND public_case_id <> ?1').bind(input.caseId),
    env.CASE_DB.prepare(`
      INSERT INTO cases (
        public_case_id, case_value_score, outreach_ready, impact_class,
        evidence_quality, recommendation, outreach_message, status,
        version, is_active, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)
      ON CONFLICT(public_case_id) DO UPDATE SET
        case_value_score = excluded.case_value_score,
        outreach_ready = excluded.outreach_ready,
        impact_class = excluded.impact_class,
        evidence_quality = excluded.evidence_quality,
        recommendation = excluded.recommendation,
        outreach_message = excluded.outreach_message,
        status = excluded.status,
        version = cases.version + 1,
        is_active = 1,
        updated_at = excluded.updated_at
    `).bind(
      input.caseId, input.caseValueScore, input.outreachReady ? 1 : 0,
      input.impactClass, input.evidenceQuality, input.recommendation,
      input.outreachMessage, input.status, input.version, now
    ),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES (?1, 'RADAR_CASE_UPSERTED', ?2, 'RADAR_API', ?3)
    `).bind(input.caseId, input.status, now)
  ]);
  return json({ accepted: true, caseId: input.caseId, stateSource: 'D1' }, 202);
}

async function upsertDispatchTarget(request, env) {
  if (!isAuthorizedRadarRequest(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !/^PUB-[A-Z0-9-]{3,40}$/.test(body.caseId || '')) return json({ error: 'INVALID_CASE_ID' }, 400);
  if (!validEmail(body.recipientEmail)) return json({ error: 'INVALID_RECIPIENT_EMAIL' }, 400);
  const recipientName = String(body.recipientName || '').trim().slice(0, 200) || null;
  const subject = String(body.subject || '').trim().slice(0, 300) || null;
  const now = new Date().toISOString();
  await env.CASE_DB.prepare(`
    INSERT INTO dispatch_targets (public_case_id, recipient_email, recipient_name, subject, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(public_case_id) DO UPDATE SET
      recipient_email = excluded.recipient_email,
      recipient_name = excluded.recipient_name,
      subject = excluded.subject,
      updated_at = excluded.updated_at
  `).bind(body.caseId, String(body.recipientEmail).trim(), recipientName, subject, now).run();
  return json({ accepted: true, caseId: body.caseId, targetStored: true }, 202);
}

async function executeDispatch(env, caseId) {
  if (!gmailConfigured(env)) return { executed: false, error: 'GMAIL_NOT_CONFIGURED' };
  const target = await env.CASE_DB.prepare(`
    SELECT recipient_email, recipient_name, subject
    FROM dispatch_targets WHERE public_case_id = ?1
  `).bind(caseId).first();
  if (!target) return { executed: false, error: 'DISPATCH_TARGET_NOT_CONFIGURED' };

  const state = await readOwnerState(env);
  if (!state || state.caseId !== caseId) return { executed: false, error: 'ACTIVE_CASE_MISMATCH' };
  const subject = target.subject || `KF-001 ${caseId}`;
  const body = state.outreachMessage;
  const now = new Date().toISOString();

  try {
    const sent = await sendGmail(env, {
      to: target.recipient_email,
      subject,
      text: body
    });
    await env.CASE_DB.batch([
      env.CASE_DB.prepare(`
        UPDATE cases
        SET status = 'DISPATCHED', version = version + 1, updated_at = ?2
        WHERE public_case_id = ?1 AND is_active = 1
      `).bind(caseId, now),
      env.CASE_DB.prepare(`
        INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
        VALUES (?1, 'OUTREACH_DISPATCHED', 'DISPATCHED', 'GMAIL_API', ?2)
      `).bind(caseId, now),
      env.CASE_DB.prepare(`
        INSERT INTO dispatch_log (
          public_case_id, provider, provider_message_id, recipient_email, status, error_code, created_at
        ) VALUES (?1, 'GMAIL', ?2, ?3, 'SENT', NULL, ?4)
      `).bind(caseId, sent.id, target.recipient_email, now)
    ]);
    return { executed: true, provider: 'GMAIL', messageId: sent.id };
  } catch (error) {
    await env.CASE_DB.prepare(`
      INSERT INTO dispatch_log (
        public_case_id, provider, provider_message_id, recipient_email, status, error_code, created_at
      ) VALUES (?1, 'GMAIL', NULL, ?2, 'FAILED', ?3, ?4)
    `).bind(caseId, target.recipient_email, String(error.message || 'GMAIL_SEND_FAILED').slice(0, 120), now).run();
    return { executed: false, error: error.message || 'GMAIL_SEND_FAILED' };
  }
}

async function handleApprovalIntent(request, env) {
  const body = await request.json().catch(() => null);
  const intent = body?.intent;
  const auth = body?.auth;
  if (!intent || !['APPROVE', 'REJECT'].includes(intent.decision)) {
    return json({ error: 'INVALID_APPROVAL_INTENT', dispatchExecuted: false }, 400);
  }
  if (!/^PUB-[A-Z0-9-]{3,40}$/.test(intent.caseId || '')) {
    return json({ error: 'INVALID_CASE_ID', dispatchExecuted: false }, 400);
  }
  const expectedVersion = Number(intent.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return json({ error: 'INVALID_EXPECTED_VERSION', dispatchExecuted: false }, 400);
  }

  try {
    await verifyOwnerAssertion(env, auth, 'APPROVAL_INTENT', intent);
  } catch (error) {
    return json({ error: error.message, dispatchExecuted: false }, 401);
  }

  const newStatus = intent.decision === 'APPROVE' ? 'APPROVED_PENDING_DISPATCH' : 'REJECTED';
  const now = new Date().toISOString();
  const update = await env.CASE_DB.prepare(`
    UPDATE cases
       SET status = ?3, version = version + 1, updated_at = ?4
     WHERE public_case_id = ?1 AND version = ?2 AND is_active = 1
  `).bind(intent.caseId, expectedVersion, newStatus, now).run();

  if (Number(update.meta?.changes || 0) !== 1) {
    return json({ error: 'VERSION_CONFLICT', dispatchExecuted: false }, 409);
  }

  await env.CASE_DB.prepare(`
    INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
    VALUES (?1, 'OWNER_DECISION', ?2, 'OWNER_WEBAUTHN', ?3)
  `).bind(intent.caseId, newStatus, now).run();

  let dispatch = { executed: false };
  if (intent.decision === 'APPROVE') dispatch = await executeDispatch(env, intent.caseId);

  const state = await readOwnerState(env);
  return json({
    ...state,
    centralState: true,
    stateSource: 'D1',
    dispatchExecuted: dispatch.executed,
    dispatchProvider: dispatch.provider || null,
    dispatchError: dispatch.error || null
  }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      if (!cors['Access-Control-Allow-Origin']) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        await env.CASE_DB.prepare('SELECT 1').first();
        const owner = await ownerStatus(env).catch(() => ({ enrolled: false, credentialCount: 0 }));
        return json({
          ok: true,
          service: 'kf001-owner-backend',
          centralState: 'LIVE',
          d1SourceOfTruth: 'LIVE',
          ownerWrite: owner.enrolled ? 'LIVE' : 'READY_FOR_ENROLLMENT',
          ownerCredentialCount: owner.credentialCount,
          realPush: 'NOT_LIVE',
          realOutreachDispatch: gmailConfigured(env) ? 'LIVE' : 'NOT_LIVE'
        }, 200, cors);
      } catch {
        return json({ ok: false, centralState: 'NOT_LIVE', d1SourceOfTruth: 'NOT_LIVE' }, 503, cors);
      }
    }

    if (request.method === 'GET' && url.pathname === '/v1/owner-state') {
      try {
        const state = await readOwnerState(env);
        if (!state) return json({ error: 'NO_ACTIVE_CASE' }, 404, cors);
        return json({ ...state, stateSource: 'D1', isSourceOfTruth: true }, 200, cors);
      } catch {
        return json({ error: 'D1_UNAVAILABLE' }, 503, cors);
      }
    }

    if (request.method === 'GET' && url.pathname === '/v1/auth/status') {
      try {
        return json(await ownerStatus(env), 200, cors);
      } catch (error) {
        return json({ error: error.message }, 503, cors);
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/auth/register/options') {
      try {
        return json(await registrationOptions(request, env), 200, cors);
      } catch (error) {
        const code = error.message === 'OWNER_BOOTSTRAP_UNAUTHORIZED' ? 401 : 400;
        return json({ error: error.message }, code, cors);
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/auth/register/verify') {
      try {
        const body = await request.json();
        return json(await verifyRegistration(request, env, body), 200, cors);
      } catch (error) {
        const code = error.message === 'OWNER_BOOTSTRAP_UNAUTHORIZED' ? 401 : 400;
        return json({ error: error.message }, code, cors);
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/auth/options') {
      try {
        const body = await request.json().catch(() => ({}));
        const purpose = String(body.purpose || 'OWNER_VERIFY');
        return json(await authenticationOptions(env, purpose, body.payload ?? null), 200, cors);
      } catch (error) {
        return json({ error: error.message }, 400, cors);
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/auth/verify') {
      try {
        const body = await request.json();
        return json(await verifyOwnerAssertion(env, body.auth, 'OWNER_VERIFY', null), 200, cors);
      } catch (error) {
        return json({ error: error.message, verified: false }, 401, cors);
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/radar/cases') {
      return upsertRadarCase(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/radar/dispatch-targets') {
      return upsertDispatchTarget(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/approval-intents') {
      const response = await handleApprovalIntent(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    if (request.method === 'POST' && url.pathname === '/v1/push/subscriptions') {
      return json({ error: 'REAL_PUSH_NOT_CONFIGURED', status: 'NOT_LIVE' }, 503, cors);
    }

    return json({ error: 'NOT_FOUND' }, 404, cors);
  }
};

