import baseWorker from './worker-v2.js';
import { enrichQualifiedContacts } from './contact-enrichment.js';
import { selectBestEconomicCandidate } from './economic-selector.js';
import { revenueAutopilotStatus, runRevenueAutopilot } from './revenue-autopilot.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  }
});

export async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const parts = String(signatureHeader).split(',').map((part) => {
    const [key, ...rest] = part.split('=');
    return [key, rest.join('=')];
  });
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((signature) => {
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  });
}

async function rejectStripeEvent(env, eventId, errorCode, status = 400) {
  await env.CASE_DB.prepare(`
    UPDATE stripe_webhook_events
       SET status = 'REJECTED', error_code = ?2, processed_at = ?3
     WHERE event_id = ?1 AND status = 'PROCESSING'
  `).bind(eventId, errorCode, new Date().toISOString()).run();
  return json({ ok: false, error: errorCode }, status);
}

async function readBodyLimited(request, maximumBytes) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maximumBytes) throw new Error('WEBHOOK_BODY_TOO_LARGE');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('WEBHOOK_BODY_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handleStripeWebhook(request, env) {
  let rawBody;
  try { rawBody = await readBodyLimited(request, 65536); } catch {
    return json({ ok: false, error: 'WEBHOOK_BODY_TOO_LARGE' }, 413);
  }
  const signature = request.headers.get('stripe-signature');
  const verified = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) return json({ ok: false, error: 'INVALID_STRIPE_SIGNATURE' }, 400);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  if (event.type !== 'checkout.session.completed') return json({ ok: true, ignored: true });
  if (!env.CASE_DB) return json({ ok: false, error: 'D1_NOT_CONFIGURED' }, 503);

  const session = event.data?.object || {};
  const eventId = String(event.id || '');
  if (!eventId) return json({ ok: false, error: 'STRIPE_EVENT_ID_MISSING' }, 400);
  const sessionId = String(session.id || '');
  const publicCaseId = String(session.metadata?.public_case_id || '');
  const legacyCaseId = String(session.metadata?.case_id || '');
  const claimedAt = new Date().toISOString();
  const claim = await env.CASE_DB.prepare(`
    INSERT OR IGNORE INTO stripe_webhook_events (
      event_id, event_type, public_case_id, session_id, status, created_at
    ) VALUES (?1, ?2, ?3, ?4, 'PROCESSING', ?5)
  `).bind(eventId, event.type, publicCaseId || null, sessionId || null, claimedAt).run();
  if (Number(claim.meta?.changes || 0) !== 1) {
    return json({ ok: true, received: true, duplicate: true });
  }

  if (session.payment_status !== 'paid') return rejectStripeEvent(env, eventId, 'PAYMENT_STATUS_NOT_PAID');
  if (!/^PUB-[A-Z0-9-]{3,40}$/.test(publicCaseId)) return rejectStripeEvent(env, eventId, 'INVALID_PAYMENT_CASE_ID');
  if (legacyCaseId && legacyCaseId !== publicCaseId) return rejectStripeEvent(env, eventId, 'PAYMENT_CASE_METADATA_MISMATCH');
  if (String(session.client_reference_id || '') !== publicCaseId) return rejectStripeEvent(env, eventId, 'CLIENT_REFERENCE_MISMATCH');

  const record = await env.CASE_DB.prepare(`
    SELECT public_case_id, stage, payment_status, calculated_fee_minor,
           success_fee_amount_cents, success_fee_currency, stripe_checkout_session_id
      FROM revenue_autopilot
     WHERE public_case_id = ?1
  `).bind(publicCaseId).first();
  if (!record || record.stage !== 'PAYMENT_PENDING') return rejectStripeEvent(env, eventId, 'OPEN_PAYMENT_RECORD_NOT_FOUND');
  if (String(record.stripe_checkout_session_id || '') !== sessionId) return rejectStripeEvent(env, eventId, 'STRIPE_SESSION_MISMATCH');

  const amount = Number(session.amount_total);
  const expectedAmount = Number(record.calculated_fee_minor ?? record.success_fee_amount_cents);
  const metadataAmount = Number(session.metadata?.success_fee_amount_cents);
  const currency = String(session.currency || '').toUpperCase();
  if (!Number.isInteger(amount) || amount <= 0 || amount !== expectedAmount || metadataAmount !== expectedAmount) {
    return rejectStripeEvent(env, eventId, 'STRIPE_AMOUNT_MISMATCH');
  }
  if (currency !== 'EUR' || String(record.success_fee_currency || '').toUpperCase() !== 'EUR') {
    return rejectStripeEvent(env, eventId, 'STRIPE_CURRENCY_MISMATCH');
  }

  const paidAt = new Date(Number(event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const paymentIntentId = String(session.payment_intent || '') || null;
  if (!paymentIntentId) return rejectStripeEvent(env, eventId, 'STRIPE_PAYMENT_INTENT_MISSING');
  const paymentBatch = await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stage = 'PAID', payment_status = 'PAID', payment_confirmed_at = ?2,
             stripe_payment_intent_id = ?3, stripe_payment_event_id = ?4,
             error_code = NULL, updated_at = ?2
       WHERE public_case_id = ?1 AND stage = 'PAYMENT_PENDING'
         AND stripe_checkout_session_id = ?5 AND calculated_fee_minor = ?6
    `).bind(publicCaseId, paidAt, paymentIntentId, eventId, sessionId, expectedAmount),
    env.CASE_DB.prepare(`
      UPDATE cases
         SET status = 'RESPONSE_RECEIVED', is_active = 0, version = version + 1, updated_at = ?2
       WHERE public_case_id = ?1
         AND EXISTS (
           SELECT 1 FROM revenue_autopilot
            WHERE public_case_id = ?1 AND stripe_payment_event_id = ?3 AND payment_status = 'PAID'
         )
    `).bind(publicCaseId, paidAt, eventId),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      SELECT ?1, 'AUTOPILOT_PAYMENT_CONFIRMED', 'PAID', 'STRIPE_WEBHOOK', ?2
       WHERE EXISTS (
         SELECT 1 FROM revenue_autopilot
          WHERE public_case_id = ?1 AND stripe_payment_event_id = ?3 AND payment_status = 'PAID'
       )
    `).bind(publicCaseId, paidAt, eventId),
    env.CASE_DB.prepare(`
      INSERT OR IGNORE INTO stripe_payments (event_id, session_id, amount_minor, currency, paid_at)
      SELECT ?1, ?2, ?3, 'EUR', ?4
       WHERE EXISTS (
         SELECT 1 FROM revenue_autopilot
          WHERE public_case_id = ?5 AND stripe_payment_event_id = ?1 AND payment_status = 'PAID'
       )
    `).bind(eventId, sessionId, expectedAmount, paidAt, publicCaseId),
    env.CASE_DB.prepare(`
      UPDATE stripe_webhook_events
         SET status = 'PROCESSED', error_code = NULL, processed_at = ?2
       WHERE event_id = ?1 AND status = 'PROCESSING'
         AND EXISTS (
           SELECT 1 FROM revenue_autopilot
            WHERE public_case_id = ?3 AND stripe_payment_event_id = ?1 AND payment_status = 'PAID'
         )
    `).bind(eventId, paidAt, publicCaseId)
  ]);
  if (Number(paymentBatch[0]?.meta?.changes || 0) !== 1) {
    return rejectStripeEvent(env, eventId, 'PAYMENT_STATE_CONFLICT', 409);
  }

  return json({ ok: true, received: true, paymentStatus: 'PAID' });
}

// A sidecar failure must never break the proven radar or owner-gate response.
async function runAutonomySidecar(env) {
  try {
    const contactEnrichment = await enrichQualifiedContacts(env);
    const economicSelection = await selectBestEconomicCandidate(env);
    const revenueAutopilot = await runRevenueAutopilot(env);
    return { ok: true, contactEnrichment, economicSelection, revenueAutopilot };
  } catch (error) {
    return { ok: false, error: String(error?.message || 'AUTONOMY_SIDECAR_FAILED') };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/v1/stripe/webhook') {
      return handleStripeWebhook(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/v1/autopilot/status') {
      try {
        return json(await revenueAutopilotStatus(env));
      } catch (error) {
        return json({ enabled: false, stage: 'ERROR', error: String(error?.message || 'AUTOPILOT_STATUS_FAILED') }, 503);
      }
    }

    const response = await baseWorker.fetch(request, env, ctx);

    if (request.method === 'POST' && url.pathname === '/v1/radar/run' && response.ok) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.ok) ctx.waitUntil(runAutonomySidecar(env));
    }

    return response;
  },

  scheduled(controller, env, ctx) {
    let basePromise = Promise.resolve();
    const captureCtx = { waitUntil(promise) { basePromise = Promise.resolve(promise); } };
    baseWorker.scheduled(controller, env, captureCtx);
    ctx.waitUntil((async () => {
      await basePromise;
      await runAutonomySidecar(env);
    })());
  }
};
