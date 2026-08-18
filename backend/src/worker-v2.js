import baseWorker from './worker.js';
import { verifyOwnerAssertion } from './webauthn.js';
import { privateCaseDetail, radarStatus, runRadarScan } from './radar.js';

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

async function healthWithRadar(request, env, ctx) {
  const baseResponse = await baseWorker.fetch(request, env, ctx);
  const payload = await baseResponse.json().catch(() => ({}));
  let radar;
  try {
    radar = await radarStatus(env);
  } catch (error) {
    radar = { live: false, lastRunAt: null, lastRunError: error.message || 'RADAR_STATUS_FAILED' };
  }
  const headers = new Headers(baseResponse.headers);
  return json({
    ...payload,
    realRadar: radar.live ? 'LIVE' : 'NOT_LIVE',
    radarLastRunAt: radar.lastRunAt || null,
    radarLastRunError: radar.lastRunError || null,
    radarLastDiscovered: radar.lastDiscovered || 0,
    radarLastQualified: radar.lastQualified || 0,
    radarLastContactable: radar.lastContactable || 0,
    radarReadyCandidates: radar.readyCandidates || 0,
    radarLastPromotedCaseId: radar.lastPromotedCaseId || null
  }, baseResponse.status, Object.fromEntries(headers.entries()));
}

async function handleOwnerRadarRun(request, env) {
  const cors = corsHeaders(request, env);
  const body = await request.json().catch(() => null);
  try {
    await verifyOwnerAssertion(env, body?.auth, 'RADAR_SCAN', null);
    const result = await runRadarScan(env);
    return json(result, 200, cors);
  } catch (error) {
    const code = String(error.message || '').startsWith('WEBAUTHN_') || String(error.message || '').startsWith('OWNER_') ? 401 : 500;
    return json({ error: error.message || 'RADAR_SCAN_FAILED' }, code, cors);
  }
}

async function handlePrivateCaseRead(request, env) {
  const cors = corsHeaders(request, env);
  const body = await request.json().catch(() => null);
  const caseId = String(body?.caseId || '');
  if (!/^PUB-[A-Z0-9-]{3,40}$/.test(caseId)) return json({ error: 'INVALID_CASE_ID' }, 400, cors);
  const payload = { caseId };
  try {
    await verifyOwnerAssertion(env, body?.auth, 'PRIVATE_CASE_READ', payload);
    const detail = await privateCaseDetail(env, caseId);
    if (!detail) return json({ error: 'PRIVATE_CASE_NOT_FOUND' }, 404, cors);
    return json(detail, 200, cors);
  } catch (error) {
    const code = String(error.message || '').startsWith('WEBAUTHN_') || String(error.message || '').startsWith('OWNER_') ? 401 : 500;
    return json({ error: error.message || 'PRIVATE_CASE_READ_FAILED' }, code, cors);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS' && ['/v1/radar/run', '/v1/private/case-detail'].includes(url.pathname)) {
      if (!cors['Access-Control-Allow-Origin']) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return healthWithRadar(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/v1/radar/run') {
      return handleOwnerRadarRun(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/private/case-detail') {
      return handlePrivateCaseRead(request, env);
    }

    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRadarScan(env));
  }
};
