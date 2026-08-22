import baseWorker from './worker.js';
import { verifyOwnerAssertion } from './webauthn.js';
import { privateCaseDetail, radarStatus, runRadarScan } from './radar.js';
import { handleRadarIntakeRequest } from './radar-intake.js';
import {
  caseCheckEligible,
  economicSelectionStatus,
  ensureEconomicSelectionSchema,
  selectBestEconomicCandidate
} from './economic-selector.js';

const ECONOMIC_SCORING_VERSION = 'ECON_V1';
const MIN_ECONOMIC_SCORE = 72;

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

function economicRowIsApprovalQualified(row) {
  return Boolean(row)
    && Number(row.economically_qualified || 0) === 1
    && Number(row.economic_score || 0) >= MIN_ECONOMIC_SCORE
    && String(row.scoring_version || '') === ECONOMIC_SCORING_VERSION
    && Boolean(row.selected_at);
}

function economicRowIsSelectedRevenueCandidate(row, env) {
  if (economicRowIsApprovalQualified(row)) return true;
  if (!row || String(row.scoring_version || '') !== ECONOMIC_SCORING_VERSION || !row.selected_at) return false;
  return caseCheckEligible({
    economicScore: Number(row.economic_score || 0),
    amountApproxUsd: Number(row.amount_approx_usd || 0),
    solvability: Number(row.solvability_score || 0),
    reachability: Number(row.reachability_score || 0),
    evidence: Number(row.evidence_score || 0),
    effort: Number(row.effort_score || 0),
    uncertainty: Number(row.uncertainty_score || 0)
  }, env);
}

async function economicApprovalQualification(env, caseId) {
  const row = await env.CASE_DB.prepare(`
    SELECT public_case_id, economic_score, economically_qualified, scoring_version, selected_at,
           solvability_score, payer_probability_score, reachability_score, evidence_score,
           platform_ack_score, recoverable_value_score, proprietary_data_value_score,
           reference_value_score, amount_currency, amount_native, amount_approx_usd
      FROM case_economic_scores
     WHERE public_case_id = ?1
  `).bind(caseId).first();
  return {
    allowed: economicRowIsApprovalQualified(row),
    row
  };
}

async function suppressInvalidPendingGate(env) {
  const active = await env.CASE_DB.prepare(`
    SELECT c.public_case_id,
           e.economic_score, e.economically_qualified, e.scoring_version, e.selected_at,
           e.solvability_score, e.reachability_score, e.evidence_score,
           e.effort_score, e.uncertainty_score, e.amount_approx_usd
      FROM cases c
      LEFT JOIN case_economic_scores e ON e.public_case_id = c.public_case_id
     WHERE c.is_active = 1
       AND c.status = 'PENDING_APPROVAL'
     ORDER BY c.updated_at DESC
     LIMIT 1
  `).first();
  if (!active?.public_case_id || economicRowIsSelectedRevenueCandidate(active, env)) return false;

  const now = new Date().toISOString();
  await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      UPDATE cases SET is_active = 0, version = version + 1, updated_at = ?2
      WHERE public_case_id = ?1 AND status = 'PENDING_APPROVAL' AND is_active = 1
    `).bind(active.public_case_id, now),
    env.CASE_DB.prepare(`
      UPDATE radar_candidates SET status = 'DISCOVERED'
      WHERE public_case_id = ?1 AND status = 'PROMOTED'
    `).bind(active.public_case_id),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES (?1, 'ECONOMIC_GATE_HARD_BLOCKED', 'PENDING_APPROVAL', 'ECONOMIC_SELECTOR_V1', ?2)
    `).bind(active.public_case_id, now)
  ]);
  return true;
}

async function healthWithRadar(request, env, ctx) {
  await ensureProductionSchema(env);
  await suppressInvalidPendingGate(env);
  const baseResponse = await baseWorker.fetch(request, env, ctx);
  const payload = await baseResponse.json().catch(() => ({}));
  let radar;
  let economicSelection = null;
  try {
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
    economicWinnerCaseId: economicSelection?.selectedAt ? economicSelection.caseId : null,
    economicWinnerScore: economicSelection?.selectedAt ? economicSelection.economicScore : null,
    economicWinnerQualified: Boolean(economicSelection?.selectedAt && economicSelection?.economicallyQualified),
    economicWinnerApproxUsd: economicSelection?.selectedAt ? (economicSelection.amountApproxUsd || 0) : 0,
    economicScoringVersion: economicSelection?.scoringVersion || null
  }, baseResponse.status, Object.fromEntries(headers.entries()));
}

async function executeRadarAndEconomicSelection(env) {
  const radarResult = await runRadarScan(env);
  const economicResult = await selectBestEconomicCandidate(env);
  const suppressedInvalidGate = await suppressInvalidPendingGate(env);
  const selectedCaseId = !suppressedInvalidGate && economicResult?.selectedCaseId
    ? (economicResult.selectedCaseId || null)
    : null;
  return {
    ...radarResult,
    rawPromotedCaseId: radarResult.promotedCaseId || null,
    promotedCaseId: selectedCaseId,
    economicSelection: economicResult,
    suppressedInvalidGate
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

async function hardGateApprovalRequest(request, env) {
  const body = await request.clone().json().catch(() => null);
  const intent = body?.intent;
  if (intent?.decision !== 'APPROVE') return null;
  const caseId = String(intent?.caseId || '');
  if (!/^PUB-[A-Z0-9-]{3,40}$/.test(caseId)) {
    return json({ error: 'INVALID_CASE_ID', dispatchExecuted: false }, 400, corsHeaders(request, env));
  }

  await ensureProductionSchema(env);
  const active = await env.CASE_DB.prepare(`
    SELECT public_case_id, status FROM cases
    WHERE public_case_id = ?1 AND is_active = 1
  `).bind(caseId).first();
  const qualification = await economicApprovalQualification(env, caseId);
  if (!active || String(active.status) !== 'PENDING_APPROVAL' || !qualification.allowed) {
    await suppressInvalidPendingGate(env);
    return json({
      error: 'ECONOMIC_APPROVAL_BLOCKED',
      dispatchExecuted: false,
      caseId,
      economicScore: Number(qualification.row?.economic_score || 0),
      economicallyQualified: Number(qualification.row?.economically_qualified || 0) === 1,
      scoringVersion: qualification.row?.scoring_version || null,
      selectedAt: qualification.row?.selected_at || null
    }, 409, corsHeaders(request, env));
  }
  return null;
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

    if (request.method === 'GET' && url.pathname === '/v1/owner-state') {
      await ensureProductionSchema(env);
      await suppressInvalidPendingGate(env);
      return baseWorker.fetch(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/v1/radar/run') {
      return handleOwnerRadarRun(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/radar/intake') {
      return handleRadarIntakeRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/private/case-detail') {
      return handlePrivateCaseRead(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/v1/approval-intents') {
      const blocked = await hardGateApprovalRequest(request, env);
      if (blocked) return blocked;
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
