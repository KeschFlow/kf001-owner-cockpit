const ECONOMIC_SCORING_VERSION = 'ECON_V1';
const MIN_ECONOMIC_SCORE = 72;
const MIN_APPROX_USD_VALUE = 8000;
const DEFAULT_CASE_CHECK_MIN_SCORE = 58;
const DEFAULT_CASE_CHECK_MIN_VALUE_USD = 500;
const TERMINAL_CASE_STATUSES = new Set(['DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED']);

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const clean = (value, max = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function numericEnv(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function caseCheckEligible(score, env = {}) {
  if (String(env.CASE_CHECK_ENABLED || '').toLowerCase() !== 'true') return false;
  return Number(score?.economicScore || 0) >= numericEnv(env, 'CASE_CHECK_MIN_ECONOMIC_SCORE', DEFAULT_CASE_CHECK_MIN_SCORE)
    && Number(score?.amountApproxUsd || 0) >= numericEnv(env, 'CASE_CHECK_MIN_VALUE_USD', DEFAULT_CASE_CHECK_MIN_VALUE_USD)
    && Number(score?.solvability || 0) >= 50
    && Number(score?.reachability || 0) >= 60
    && Number(score?.evidence || 0) >= 45
    && Number(score?.effort || 100) <= 75
    && Number(score?.uncertainty || 100) <= 60;
}

const CURRENCY_TO_APPROX_USD = {
  USD: 1,
  EUR: 1.1,
  GBP: 1.27,
  CHF: 1.13,
  CAD: 0.72,
  AUD: 0.66,
  SEK: 0.105,
  NOK: 0.095,
  DKK: 0.16
};

function parseNumber(raw) {
  const value = String(raw || '').replace(/\s/g, '');
  if (!value) return 0;
  let normalized = value;
  if (value.includes(',') && value.includes('.')) {
    normalized = value.lastIndexOf(',') > value.lastIndexOf('.')
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '');
  } else if ((value.match(/,/g) || []).length === 1 && /,\d{2}$/.test(value)) {
    normalized = value.replace(',', '.');
  } else {
    normalized = value.replace(/,/g, '');
  }
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

export function extractEconomicAmount(text, fallbackAmount = 0) {
  const source = String(text || '');
  const matches = [];
  const patterns = [
    { currency: 'USD', regex: /(?:USD|US\$|\$)\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'EUR', regex: /(?:EUR|€)\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'GBP', regex: /(?:GBP|£)\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'CHF', regex: /CHF\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'CAD', regex: /CAD\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'AUD', regex: /AUD\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'SEK', regex: /(?:SEK|kr)\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'NOK', regex: /NOK\s?([0-9][0-9.,\s]{1,})/gi },
    { currency: 'DKK', regex: /DKK\s?([0-9][0-9.,\s]{1,})/gi }
  ];

  for (const { currency, regex } of patterns) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const amount = parseNumber(match[1]);
      if (amount > 0) matches.push({ currency, amount, approxUsd: amount * CURRENCY_TO_APPROX_USD[currency] });
    }
  }

  if (!matches.length && Number(fallbackAmount) > 0) {
    matches.push({ currency: 'UNKNOWN', amount: Number(fallbackAmount), approxUsd: Number(fallbackAmount) });
  }

  matches.sort((a, b) => b.approxUsd - a.approxUsd);
  return matches[0] || { currency: null, amount: 0, approxUsd: 0 };
}

function signalScore(text, signals, base = 0) {
  let score = base;
  for (const [pattern, points] of signals) if (pattern.test(text)) score += points;
  return clamp(score);
}

export function scoreEconomicCandidate(row) {
  const title = clean(row.source_title, 600);
  const excerpt = clean(row.source_excerpt, 6000);
  const text = `${title}\n${excerpt}`.toLowerCase();
  const evidence = clamp(Number(row.evidence_score || 0));
  const amount = extractEconomicAmount(`${title}\n${excerpt}`, row.amount_signal);

  const platformAck = signalScore(text, [
    [/refund (?:was )?approved|approved refund|refund approval/, 40],
    [/credit note|credit memo|billing credit|credited/, 32],
    [/acknowledg|confirmed|classified|trust\s*&?\s*safety|supervisor|specialist team/, 18],
    [/case id|case #|ticket|support case/, 12],
    [/anomaly alert|cost anomaly|fraud alert/, 16],
    [/compromised key|unauthori[sz]ed usage/, 12]
  ], 8);

  const solvability = signalScore(text, [
    [/refund (?:was )?approved|approved refund|credit note|credit memo/, 30],
    [/invoice|billing|payment|bank|card|charge/, 14],
    [/case id|case #|ticket|support case/, 10],
    [/timeline|log|audit|screenshot|receipt|statement|export/, 12],
    [/anomaly alert|cost anomaly/, 10],
    [/support loop|no response|no human|unresolved|stalled/, 8],
    [/legal action|lawsuit|court|police|criminal complaint/, -14],
    [/credential leaked publicly|shared key|committed secret/, -10]
  ], 28 + Math.round(evidence * 0.18));

  const reachabilityByRoute = {
    PUBLIC_WEBSITE_MAILTO: 88,
    PUBLIC_APP_SUPPORT_EMAIL: 88,
    VERIFIED_PUBLIC_EMAIL: 86,
    PUBLIC_POST_EMAIL: 82,
    GITHUB_PUBLIC_EMAIL: 72,
    GITLAB_PUBLIC_EMAIL: 72
  };
  let reachability = row.contact_email ? (reachabilityByRoute[row.contact_route] || 68) : 0;
  if (row.author_name) reachability += 5;
  if (/@(gmail|outlook|hotmail|yahoo|protonmail|icloud)\./i.test(String(row.contact_email || ''))) reachability -= 8;
  if (/(company|business|ltd|limited|llc|gmbh|ab\b|inc\b|corp|startup|founder|ceo|owner|developer)/i.test(text)) reachability += 8;
  reachability = clamp(reachability);

  const payerProbability = signalScore(text, [
    [/(company|business|ltd|limited|llc|gmbh|ab\b|inc\b|corp|startup)/, 18],
    [/(founder|ceo|owner|director|developer|agency)/, 10],
    [/(bank account|cash flow|card charged|money left|debited|withdrawn)/, 16],
    [/(refund|reimbursement|credit note|credit memo)/, 12],
    [/(urgent|closure|suspend|terminated|collections|payment retry)/, 8],
    [/(student|hobby|personal project)/, -10]
  ], 30 + Math.round(reachability * 0.18));

  let recoverableValue = 0;
  if (amount.approxUsd >= 250000) recoverableValue = 100;
  else if (amount.approxUsd >= 100000) recoverableValue = 94;
  else if (amount.approxUsd >= 50000) recoverableValue = 88;
  else if (amount.approxUsd >= 20000) recoverableValue = 82;
  else if (amount.approxUsd >= 8000) recoverableValue = 75;
  else if (amount.approxUsd >= 5000) recoverableValue = 62;
  else if (amount.approxUsd >= 1000) recoverableValue = 42;
  else if (amount.approxUsd > 0) recoverableValue = 24;

  const effort = signalScore(text, [
    [/multiple accounts|four billing accounts|five support cases|many tickets/, 16],
    [/audit|iam|logs|usage export|forensic/, 10],
    [/lawsuit|court|police|regulator/, 18],
    [/refund (?:was )?approved|approved refund|credit note|credit memo/, -20],
    [/bank statement|payment reference|invoice/, -8]
  ], 38);

  const uncertainty = clamp(66 - Math.round(evidence * 0.28) - Math.round(platformAck * 0.25)
    + (/credential leaked publicly|shared key|committed secret/.test(text) ? 14 : 0)
    + (/unknown charge|does not appear|cannot identify/.test(text) ? 8 : 0));

  const proprietaryDataValue = signalScore(text, [
    [/api key|credential|token|secret/, 14],
    [/gemini|openai|google cloud|gcp|aws|azure|cloudflare/, 12],
    [/anomaly|usage spike|cost spike/, 12],
    [/support case|ticket|appeal|trust\s*&?\s*safety/, 12],
    [/invoice|bank|payment|credit note|refund/, 12],
    [/timeline|audit|iam|log|export/, 12],
    [/multiple accounts|billing accounts/, 8]
  ], 22 + Math.round(evidence * 0.15));

  const referenceValue = signalScore(text, [
    [/(company|business|ltd|limited|llc|gmbh|ab\b|inc\b|corp|startup)/, 18],
    [/google|openai|aws|azure|cloudflare/, 15],
    [/refund (?:was )?approved|credit note|acknowledg|confirmed/, 14],
    [/unauthori[sz]ed|fraud|compromised/, 10]
  ], 20 + Math.round(recoverableValue * 0.18));

  const economicScore = clamp(Math.round(
    solvability * 0.20 +
    payerProbability * 0.13 +
    reachability * 0.12 +
    evidence * 0.12 +
    platformAck * 0.10 +
    recoverableValue * 0.12 +
    proprietaryDataValue * 0.10 +
    referenceValue * 0.07 +
    (100 - effort) * 0.02 +
    (100 - uncertainty) * 0.02
  ));

  const economicallyQualified = economicScore >= MIN_ECONOMIC_SCORE
    && solvability >= 60
    && reachability >= 60
    && evidence >= 50
    && amount.approxUsd >= MIN_APPROX_USD_VALUE;

  return {
    economicScore,
    economicallyQualified,
    solvability,
    payerProbability,
    reachability,
    evidence,
    platformAck,
    recoverableValue,
    effort,
    uncertainty,
    proprietaryDataValue,
    referenceValue,
    amountCurrency: amount.currency,
    amountNative: amount.amount,
    amountApproxUsd: Math.round(amount.approxUsd * 100) / 100,
    scoringVersion: ECONOMIC_SCORING_VERSION
  };
}

export async function ensureEconomicSelectionSchema(env) {
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
      updated_at TEXT NOT NULL,
      FOREIGN KEY (public_case_id) REFERENCES cases(public_case_id)
    )
  `).run();
}

async function persistScore(env, caseId, score, selectedAt = null) {
  await env.CASE_DB.prepare(`
    INSERT INTO case_economic_scores (
      public_case_id, economic_score, economically_qualified, solvability_score,
      payer_probability_score, reachability_score, evidence_score, platform_ack_score,
      recoverable_value_score, effort_score, uncertainty_score, proprietary_data_value_score,
      reference_value_score, amount_currency, amount_native, amount_approx_usd,
      scoring_version, selected_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
    ON CONFLICT(public_case_id) DO UPDATE SET
      economic_score = excluded.economic_score,
      economically_qualified = excluded.economically_qualified,
      solvability_score = excluded.solvability_score,
      payer_probability_score = excluded.payer_probability_score,
      reachability_score = excluded.reachability_score,
      evidence_score = excluded.evidence_score,
      platform_ack_score = excluded.platform_ack_score,
      recoverable_value_score = excluded.recoverable_value_score,
      effort_score = excluded.effort_score,
      uncertainty_score = excluded.uncertainty_score,
      proprietary_data_value_score = excluded.proprietary_data_value_score,
      reference_value_score = excluded.reference_value_score,
      amount_currency = excluded.amount_currency,
      amount_native = excluded.amount_native,
      amount_approx_usd = excluded.amount_approx_usd,
      scoring_version = excluded.scoring_version,
      selected_at = COALESCE(excluded.selected_at, case_economic_scores.selected_at),
      updated_at = excluded.updated_at
  `).bind(
    caseId,
    score.economicScore,
    score.economicallyQualified ? 1 : 0,
    score.solvability,
    score.payerProbability,
    score.reachability,
    score.evidence,
    score.platformAck,
    score.recoverableValue,
    score.effort,
    score.uncertainty,
    score.proprietaryDataValue,
    score.referenceValue,
    score.amountCurrency,
    score.amountNative,
    score.amountApproxUsd,
    score.scoringVersion,
    selectedAt,
    new Date().toISOString()
  ).run();
}

function outreachMessage() {
  return [
    'Hello,',
    '',
    'I came across your public report about a platform or billing problem. I operate a structured case-reconstruction and escalation workflow for situations that have become stuck between support, billing and platform teams.',
    '',
    'If this is still unresolved, I can review the public timeline first and tell you whether the case looks recoverable. No account password or account access is needed for that initial assessment.',
    '',
    'If you do not want to be contacted about this, just ignore this message and I will not follow up.'
  ].join('\n');
}

export async function selectBestEconomicCandidate(env) {
  await ensureEconomicSelectionSchema(env);

  const active = await env.CASE_DB.prepare(`
    SELECT public_case_id, status FROM cases WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1
  `).first();
  if (active && !['PENDING_APPROVAL', ...TERMINAL_CASE_STATUSES].includes(String(active.status))) {
    return { selectedCaseId: active.public_case_id, changed: false, reason: 'ACTIVE_CASE_LOCKED' };
  }

  const rows = await env.CASE_DB.prepare(`
    SELECT r.*, c.public_case_id AS existing_case_id
    FROM radar_candidates r
    LEFT JOIN cases c ON c.public_case_id = r.public_case_id
    WHERE r.contact_email IS NOT NULL
      AND r.case_value_score >= 62
      AND (c.status IS NULL OR c.status NOT IN ('DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED'))
  `).all();

  const scored = [];
  for (const row of rows.results || []) {
    const score = scoreEconomicCandidate(row);
    scored.push({ row, score });
    if (row.existing_case_id) await persistScore(env, row.public_case_id, score);
  }

  scored.sort((a, b) =>
    b.score.economicScore - a.score.economicScore ||
    b.score.solvability - a.score.solvability ||
    b.score.reachability - a.score.reachability ||
    b.score.amountApproxUsd - a.score.amountApproxUsd ||
    Number(b.row.evidence_score || 0) - Number(a.row.evidence_score || 0)
  );

  const fullWinner = scored.find((entry) => entry.score.economicallyQualified) || null;
  const caseCheckWinner = fullWinner ? null : scored.find((entry) => caseCheckEligible(entry.score, env)) || null;
  const winner = fullWinner || caseCheckWinner;
  if (!winner) {
    return {
      selectedCaseId: active?.public_case_id || null,
      changed: false,
      reason: 'NO_ECONOMICALLY_QUALIFIED_CASE',
      evaluated: scored.length
    };
  }

  const caseId = winner.row.public_case_id;
  const now = new Date().toISOString();
  const selectionTier = fullWinner ? 'SUCCESS_FEE' : 'CASE_CHECK_49';
  const recommendation = fullWinner ? 'APPROVE OUTREACH' : 'OFFER CASE CHECK';
  const selectionReason = fullWinner ? 'ECONOMIC_WINNER_SELECTED' : 'ECONOMIC_CASE_CHECK_SELECTED';
  if (active?.public_case_id === caseId) {
    await env.CASE_DB.prepare(`
      UPDATE cases SET case_value_score = ?2, recommendation = ?3, version = version + 1, updated_at = ?4
      WHERE public_case_id = ?1 AND status = 'PENDING_APPROVAL'
    `).bind(caseId, winner.score.economicScore, recommendation, now).run();
    await persistScore(env, caseId, winner.score, now);
    return { selectedCaseId: caseId, changed: false, reason: 'WINNER_ALREADY_ACTIVE', selectionTier, score: winner.score };
  }

  const message = outreachMessage();
  const statements = [];
  if (active?.public_case_id && String(active.status) === 'PENDING_APPROVAL') {
    statements.push(
      env.CASE_DB.prepare(`UPDATE cases SET is_active = 0, version = version + 1, updated_at = ?2 WHERE public_case_id = ?1`).bind(active.public_case_id, now),
      env.CASE_DB.prepare(`UPDATE radar_candidates SET status = 'DISCOVERED' WHERE public_case_id = ?1 AND status = 'PROMOTED'`).bind(active.public_case_id),
      env.CASE_DB.prepare(`
        INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
        VALUES (?1, 'ECONOMIC_SELECTOR_REPLACED', 'PENDING_APPROVAL', 'ECONOMIC_SELECTOR_V1', ?2)
      `).bind(active.public_case_id, now)
    );
  }

  statements.push(
    env.CASE_DB.prepare(`
      INSERT INTO cases (
        public_case_id, case_value_score, outreach_ready, impact_class,
        evidence_quality, recommendation, outreach_message, status,
        version, is_active, updated_at
      ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, 'PENDING_APPROVAL', 1, 1, ?7)
      ON CONFLICT(public_case_id) DO UPDATE SET
        case_value_score = excluded.case_value_score,
        outreach_ready = 1,
        impact_class = excluded.impact_class,
        evidence_quality = excluded.evidence_quality,
        recommendation = excluded.recommendation,
        outreach_message = excluded.outreach_message,
        status = 'PENDING_APPROVAL',
        version = cases.version + 1,
        is_active = 1,
        updated_at = excluded.updated_at
    `).bind(
      caseId,
      winner.score.economicScore,
      winner.row.impact_score >= 82 ? 'KRITISCH' : winner.row.impact_score >= 68 ? 'HOCH' : winner.row.impact_score >= 52 ? 'MITTEL' : 'NIEDRIG',
      winner.row.evidence_score >= 78 ? 'STARK' : winner.row.evidence_score >= 58 ? 'SOLIDE' : winner.row.evidence_score >= 40 ? 'TEILWEISE' : 'SCHWACH',
      recommendation,
      message,
      now
    ),
    env.CASE_DB.prepare(`
      INSERT INTO dispatch_targets (public_case_id, recipient_email, recipient_name, subject, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(public_case_id) DO UPDATE SET
        recipient_email = excluded.recipient_email,
        recipient_name = excluded.recipient_name,
        subject = excluded.subject,
        updated_at = excluded.updated_at
    `).bind(
      caseId,
      winner.row.contact_email,
      winner.row.author_name || winner.row.author_login || null,
      fullWinner ? 'Regarding your public platform/billing report' : 'Platform/Billing Case Check for your public report',
      now
    ),
    env.CASE_DB.prepare(`UPDATE radar_candidates SET status = 'PROMOTED', promoted_at = ?2 WHERE public_case_id = ?1`).bind(caseId, now),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES (?1, ?2, 'PENDING_APPROVAL', 'ECONOMIC_SELECTOR_V1', ?3)
    `).bind(caseId, selectionReason, now)
  );

  await env.CASE_DB.batch(statements);
  await persistScore(env, caseId, winner.score, now);
  return { selectedCaseId: caseId, changed: true, reason: selectionReason, selectionTier, score: winner.score, evaluated: scored.length };
}

export async function economicSelectionStatus(env) {
  await ensureEconomicSelectionSchema(env);
  const row = await env.CASE_DB.prepare(`
    SELECT public_case_id, economic_score, economically_qualified, solvability_score,
           payer_probability_score, reachability_score, evidence_score, platform_ack_score,
           recoverable_value_score, effort_score, uncertainty_score,
           proprietary_data_value_score, reference_value_score,
           amount_currency, amount_native, amount_approx_usd, scoring_version, selected_at, updated_at
      FROM case_economic_scores
     ORDER BY selected_at IS NOT NULL DESC, economic_score DESC, updated_at DESC
     LIMIT 1
  `).first();
  if (!row) return null;
  return {
    caseId: row.public_case_id,
    economicScore: Number(row.economic_score || 0),
    economicallyQualified: Number(row.economically_qualified || 0) === 1,
    solvability: Number(row.solvability_score || 0),
    payerProbability: Number(row.payer_probability_score || 0),
    reachability: Number(row.reachability_score || 0),
    evidence: Number(row.evidence_score || 0),
    platformAck: Number(row.platform_ack_score || 0),
    recoverableValue: Number(row.recoverable_value_score || 0),
    effort: Number(row.effort_score || 0),
    uncertainty: Number(row.uncertainty_score || 0),
    proprietaryDataValue: Number(row.proprietary_data_value_score || 0),
    referenceValue: Number(row.reference_value_score || 0),
    amountCurrency: row.amount_currency || null,
    amountNative: Number(row.amount_native || 0),
    amountApproxUsd: Number(row.amount_approx_usd || 0),
    scoringVersion: row.scoring_version,
    selectedAt: row.selected_at || null
  };
}
