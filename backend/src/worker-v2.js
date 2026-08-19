import baseWorker from './worker.js';
import { verifyOwnerAssertion } from './webauthn.js';
import { privateCaseDetail, radarStatus, runRadarScan } from './radar.js';
import {
  economicSelectionStatus,
  ensureEconomicSelectionSchema,
  selectBestEconomicCandidate
} from './economic-selector.js';

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

async function ensureProductionSchema(env) {
  const tableInfo = await env.CASE_DB.prepare('PRAGMA table_info(radar_candidates)').all();
  const columns = Array.isArray(tableInfo?.results) ? tableInfo.results.map((row) => String(row.name || '')) : [];
  if (columns.length > 0 && !columns.includes('published_at')) {
    await env.CASE_DB.prepare('ALTER TABLE radar_candidates ADD COLUMN published_at TEXT').run();
  }

  // Economic scores exist before a candidate is promoted into cases, so this table intentionally
  // has no foreign key to cases. Migration 0008 mirrors this authoritative production shape.
  await env.CASE_DB.prepare(`
    CREATE TABLE IF NOT EXISTS case_economic_scores (
      public_case_id TEXT PRIMARY KEY,
      economic_score INTEGER NOT NULL,
      economically_qualified INTEGER NOT NULL CHECK (economically_qualified IN (0, 1)),
      solvability_score INTEGER NOT NULL,
      payer_probability_score INTEGER NOT NULL,
      reachability_score INTEGER NOT NULL,
      evidence_score INTEGER NOT NULL,
      platform_ack_score INTEGER NOT NULL,
      recoverable_value_score INTEGER NOT NULL,
      effort_score INTEGER NOT NULL,
      uncertainty_score INTEGER NOT NULL,
      proprietary_data_value_score INTEGER NOT NULL,
      reference_value_score INTEGER NOT NULL,
      amount_currency TEXT,
      amount_native REAL NOT NULL DEFAULT 0,
      amount_approx_usd REAL NOT NULL DEFAULT 0,
      scoring_version TEXT NOT NULL,
      selected_at TEXT,
      updated_at TEXT NOT NULL
    )
  `).run();
  await ensureEconomicSelectionSchema(env);

  const retired = await env.CASE_DB.prepare(`
    UPDATE cases
       SET status = 'REJECTED',
           version = version + 1,
           updated_at = ?1
     WHERE public_case_id = 'PUB-001'
       AND is_active = 1
       AND status NOT IN ('DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED')
  `).bind(new Date().toISOString()).run();

  if (Number(retired.meta?.changes || 0) > 0) {
    await env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES ('PUB-001', 'LEGACY_TEST_CASE_RETIRED', 'REJECTED', 'SYSTEM_RUNTIME_MIGRATION', ?1)
    `).bind(new Date().toISOString()).run();
  }
}

async function healthWithRadar(request, env, ctx) {
  const baseResponse = await baseWorker.fetch(request, env, ctx);
  const payload = await baseResponse.json().catch(() => ({}));
  let radar;
  let economicSelection = null;
  try {
    await ensureProductionSchema(env);
    radar = await radarStatus(env);
    economicSelection = await economicSelectionStatus(env);
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
    radarLastPromotedCaseId: radar.lastPromotedCaseId || null,
    economicSelector: economicSelection ? 'LIVE' : 'NO_SCORED_CASES',
    economicWinnerCaseId: economicSelection?.caseId || null,
    economicWinnerScore: economicSelection?.economicScore || null,
    economicWinnerQualified: economicSelection?.economicallyQualified || false,
    economicWinnerApproxUsd: economicSelection?.amountApproxUsd || 0,
    economicScoringVersion: economicSelection?.scoringVersion || null
  }, baseResponse.status, Object.fromEntries(headers.entries()));
}

async function suppressUneconomicPendingGate(env, economicResult) {
  if (economicResult?.reason !== 'NO_ECONOMICALLY_QUALIFIED_CASE') return false;
  const active = await env.CASE_DB.prepare(`
    SELECT c.public_case_id
      FROM cases c
      LEFT JOIN case_economic_scores e ON e.public_case_id = c.public_case_id
     WHERE c.is_active = 1
       AND c.status = 'PENDING_APPROVAL'
       AND COALESCE(e.economically_qualified, 0) = 0
     LIMIT 1
  `).first();
  if (!active?.public_case_id) return false;

  const now = new Date().toISOString();
  await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      UPDATE cases SET is_active = 0, version = version + 1, updated_at = ?2
      WHERE public_case_id = ?1 AND status = 'PENDING_APPROVAL'
    `).bind(active.public_case_id, now),
    env.CASE_DB.prepare(`
      UPDATE radar_candidates SET status = 'DISCOVERED'
      WHERE public_case_id = ?1 AND status = 'PROMOTED'
    `).bind(active.public_case_id),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES (?1, 'ECONOMIC_GATE_SUPPRESSED', 'PENDING_APPROVAL', 'ECONOMIC_SELECTOR_V1', ?2)
    `).bind(active.public_case_id, now)
  ]);
  return true;
}

async function executeRadarAndEconomicSelection(env) {
  const radarResult = await runRadarScan(env);
  const economicResult = await selectBestEconomicCandidate(env);
  const suppressedUneconomicGate = await suppressUneconomicPendingGate(env, economicResult);
  return {
    ...radarResult,
    rawPromotedCaseId: radarResult.promotedCaseId || null,
    promotedCaseId: suppressedUneconomicGate ? null : (economicResult.selectedCaseId || radarResult.promotedCaseId || null),
    economicSelection: economicResult,
    suppressedUneconomicGate
  };
}

async function handleOwnerRadarRun(request, env) {
  const cors = corsHeaders(request, env);
  const body = await request.json().catch(() => null);
  try {
    await verifyOwnerAssertion(env, body?.auth, 'RADAR_SCAN', null);
    await ensureProductionSchema(env);
    const result = await executeRadarAndEconomicSelection(env);
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
    await ensureProductionSchema(env);
    const detail = await privateCaseDetail(env, caseId);
    if (!detail) return json({ error: 'PRIVATE_CASE_NOT_FOUND' }, 404, cors);
    const economic = await env.CASE_DB.prepare(`
      SELECT economic_score, economically_qualified, solvability_score,
             payer_probability_score, reachability_score, evidence_score,
             platform_ack_score, recoverable_value_score, effort_score,
             uncertainty_score, proprietary_data_value_score, reference_value_score,
             amount_currency, amount_native, amount_approx_usd, scoring_version, selected_at
        FROM case_economic_scores
       WHERE public_case_id = ?1
    `).bind(caseId).first();
    return json({
      ...detail,
      economic: economic ? {
        economicScore: Number(economic.economic_score || 0),
        economicallyQualified: Number(economic.economically_qualified || 0) === 1,
        solvability: Number(economic.solvability_score || 0),
        payerProbability: Number(economic.payer_probability_score || 0),
        reachability: Number(economic.reachability_score || 0),
        evidence: Number(economic.evidence_score || 0),
        platformAck: Number(economic.platform_ack_score || 0),
        recoverableValue: Number(economic.recoverable_value_score || 0),
        effort: Number(economic.effort_score || 0),
        uncertainty: Number(economic.uncertainty_score || 0),
        proprietaryDataValue: Number(economic.proprietary_data_value_score || 0),
        referenceValue: Number(economic.reference_value_score || 0),
        amountCurrency: economic.amount_currency || null,
        amountNative: Number(economic.amount_native || 0),
        amountApproxUsd: Number(economic.amount_approx_usd || 0),
        scoringVersion: economic.scoring_version,
        selectedAt: economic.selected_at || null
      } : null
    }, 200, cors);
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
    ctx.waitUntil((async () => {
      await ensureProductionSchema(env);
      await executeRadarAndEconomicSelection(env);
    })());
  }
};
