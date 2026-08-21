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

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(String(signatureHeader).split(',').map((part) => {
    const [key, ...rest] = part.split('=');
    return [key, rest.join('=')];
  }));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  const verified = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) return json({ ok: false, error: 'INVALID_STRIPE_SIGNATURE' }, 400);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  if (event.type !== 'checkout.session.completed') return json({ ok: true, ignored: true });

  const session = event.data?.object || {};
  if (session.payment_status !== 'paid') return json({ ok: true, ignored: true, reason: 'NOT_PAID' });

  const amount = Number(session.amount_total || 0);
  const currency = String(session.currency || '').toUpperCase();
  const eventId = String(event.id || '');
  const sessionId = String(session.id || '');
  const paidAt = new Date(Number(event.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();

  if (env.CASE_DB) {
    await env.CASE_DB.prepare(`CREATE TABLE IF NOT EXISTS stripe_payments (
      event_id TEXT PRIMARY KEY,
      session_id TEXT,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
    await env.CASE_DB.prepare(`INSERT OR IGNORE INTO stripe_payments (event_id, session_id, amount_minor, currency, paid_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(eventId, sessionId, amount, currency, paidAt).run();
  }

  return json({ ok: true, received: true });
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
