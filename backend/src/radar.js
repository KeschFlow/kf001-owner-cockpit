const GITHUB_API = 'https://api.github.com';
const MIN_CASE_SCORE = 62;
const TERMINAL_CASE_STATUSES = new Set(['DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED']);

const SEARCH_QUERIES = [
  'is:issue is:open "unexpected charges" cloud',
  'is:issue is:open "unauthorized charges" billing',
  'is:issue is:open refund billing "google cloud"',
  'is:issue is:open "account suspended" billing api'
];

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const clean = (value, max = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function publicCaseId(source, externalId) {
  const hash = await sha256Hex(`${source}:${externalId}`);
  return `PUB-${source}-${hash.slice(0, 12).toUpperCase()}`;
}

function extractLargestAmount(text) {
  const matches = String(text || '').match(/(?:USD|EUR|€|\$)\s?[0-9][0-9.,]{2,}/gi) || [];
  let largest = 0;
  for (const match of matches) {
    const normalized = match.replace(/[^0-9.,]/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
    const amount = Number.parseFloat(normalized);
    if (Number.isFinite(amount)) largest = Math.max(largest, amount);
  }
  return largest;
}

export function scoreCandidate(title, body) {
  const text = `${title || ''}\n${body || ''}`.toLowerCase();
  const amount = extractLargestAmount(text);

  let impact = 18;
  const impactSignals = [
    [/unexpected charge|unexpected bill|surprise bill/, 16],
    [/unauthori[sz]ed|fraud|stolen|compromised/, 18],
    [/refund|reimbursement|chargeback/, 10],
    [/billing|invoice|charged|cost spike/, 9],
    [/suspend|disabled|locked|terminated/, 10],
    [/api key|credential|token|secret/, 8],
    [/google cloud|gcp|aws|azure|cloudflare|openai|platform/, 8]
  ];
  for (const [pattern, points] of impactSignals) if (pattern.test(text)) impact += points;
  if (amount >= 10000) impact += 18;
  else if (amount >= 5000) impact += 14;
  else if (amount >= 1000) impact += 10;
  else if (amount >= 250) impact += 5;

  let evidence = 15;
  if (String(body || '').length >= 1200) evidence += 18;
  else if (String(body || '').length >= 500) evidence += 12;
  else if (String(body || '').length >= 180) evidence += 7;
  if (/https?:\/\//i.test(body || '')) evidence += 10;
  if (/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/.test(text)) evidence += 8;
  if (/error|request id|invoice|receipt|screenshot|log|trace|ticket|case id|support/.test(text)) evidence += 14;
  if (/```|stack trace|response code|http \d{3}/.test(text)) evidence += 8;
  if (amount > 0) evidence += 10;

  impact = clamp(impact);
  evidence = clamp(evidence);
  const combined = clamp(Math.round(impact * 0.6 + evidence * 0.4));
  return { impactScore: impact, evidenceScore: evidence, caseValueScore: combined, amountSignal: amount };
}

function impactClass(score) {
  if (score >= 82) return 'KRITISCH';
  if (score >= 68) return 'HOCH';
  if (score >= 52) return 'MITTEL';
  return 'NIEDRIG';
}

function evidenceQuality(score) {
  if (score >= 78) return 'STARK';
  if (score >= 58) return 'SOLIDE';
  if (score >= 40) return 'TEILWEISE';
  return 'SCHWACH';
}

function safePublicWebsite(raw) {
  if (!raw) return null;
  try {
    const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'KF-001-Opportunity-Radar/1.0',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) throw new Error(`GITHUB_${response.status}`);
  return response.json();
}

async function discoverPublicContact(userUrl) {
  if (!userUrl) return { email: null, name: null, login: null, route: null };
  try {
    const profile = await githubJson(userUrl);
    const directEmail = validEmail(profile.email) ? String(profile.email).trim() : null;
    if (directEmail) {
      return { email: directEmail, name: clean(profile.name || profile.login, 120), login: clean(profile.login, 80), route: 'GITHUB_PUBLIC_EMAIL' };
    }

    const website = safePublicWebsite(profile.blog);
    if (!website) return { email: null, name: clean(profile.name || profile.login, 120), login: clean(profile.login, 80), route: null };
    const response = await fetch(website, { headers: { 'User-Agent': 'KF-001-Opportunity-Radar/1.0' } });
    if (!response.ok) return { email: null, name: clean(profile.name || profile.login, 120), login: clean(profile.login, 80), route: null };
    const html = (await response.text()).slice(0, 350000);
    const mailto = html.match(/mailto:([^?"'<>\s]+)/i)?.[1];
    const email = mailto ? decodeURIComponent(mailto).trim() : null;
    return {
      email: validEmail(email) ? email : null,
      name: clean(profile.name || profile.login, 120),
      login: clean(profile.login, 80),
      route: validEmail(email) ? 'PUBLIC_WEBSITE_MAILTO' : null
    };
  } catch {
    return { email: null, name: null, login: null, route: null };
  }
}

export async function ensureRadarSchema(env) {
  await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS radar_candidates (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        public_case_id TEXT NOT NULL UNIQUE,
        source_url TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_excerpt TEXT NOT NULL,
        author_login TEXT,
        author_name TEXT,
        contact_email TEXT,
        contact_route TEXT,
        impact_score INTEGER NOT NULL,
        evidence_score INTEGER NOT NULL,
        case_value_score INTEGER NOT NULL,
        amount_signal REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'DISCOVERED',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        promoted_at TEXT,
        PRIMARY KEY (source, external_id)
      )
    `),
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS radar_runs (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        source TEXT NOT NULL,
        discovered_count INTEGER NOT NULL DEFAULT 0,
        qualified_count INTEGER NOT NULL DEFAULT 0,
        contactable_count INTEGER NOT NULL DEFAULT 0,
        promoted_case_id TEXT,
        error_code TEXT
      )
    `),
    env.CASE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_radar_candidates_score ON radar_candidates(case_value_score DESC, last_seen_at DESC)'),
    env.CASE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_radar_candidates_status ON radar_candidates(status, contact_email)')
  ]);
}

async function upsertCandidate(env, candidate) {
  const now = new Date().toISOString();
  await env.CASE_DB.prepare(`
    INSERT INTO radar_candidates (
      source, external_id, public_case_id, source_url, source_title, source_excerpt,
      author_login, author_name, contact_email, contact_route,
      impact_score, evidence_score, case_value_score, amount_signal,
      status, first_seen_at, last_seen_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'DISCOVERED', ?15, ?15)
    ON CONFLICT(source, external_id) DO UPDATE SET
      source_url = excluded.source_url,
      source_title = excluded.source_title,
      source_excerpt = excluded.source_excerpt,
      author_login = COALESCE(excluded.author_login, radar_candidates.author_login),
      author_name = COALESCE(excluded.author_name, radar_candidates.author_name),
      contact_email = COALESCE(excluded.contact_email, radar_candidates.contact_email),
      contact_route = COALESCE(excluded.contact_route, radar_candidates.contact_route),
      impact_score = excluded.impact_score,
      evidence_score = excluded.evidence_score,
      case_value_score = excluded.case_value_score,
      amount_signal = excluded.amount_signal,
      last_seen_at = excluded.last_seen_at
  `).bind(
    candidate.source, candidate.externalId, candidate.caseId, candidate.url,
    candidate.title, candidate.excerpt, candidate.authorLogin, candidate.authorName,
    candidate.contactEmail, candidate.contactRoute, candidate.impactScore,
    candidate.evidenceScore, candidate.caseValueScore, candidate.amountSignal, now
  ).run();
}

async function activeCaseAllowsPromotion(env) {
  const row = await env.CASE_DB.prepare(`
    SELECT status FROM cases WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1
  `).first();
  if (!row) return true;
  return TERMINAL_CASE_STATUSES.has(String(row.status));
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

async function promoteBestCandidate(env) {
  if (!(await activeCaseAllowsPromotion(env))) return null;
  const candidate = await env.CASE_DB.prepare(`
    SELECT * FROM radar_candidates
    WHERE contact_email IS NOT NULL
      AND case_value_score >= ?1
      AND status <> 'PROMOTED'
    ORDER BY case_value_score DESC, evidence_score DESC, last_seen_at DESC
    LIMIT 1
  `).bind(MIN_CASE_SCORE).first();
  if (!candidate) return null;

  const now = new Date().toISOString();
  const recommendation = candidate.case_value_score >= 76 ? 'APPROVE OUTREACH' : 'REVIEW OUTREACH';
  const message = outreachMessage();
  await env.CASE_DB.batch([
    env.CASE_DB.prepare('UPDATE cases SET is_active = 0 WHERE is_active = 1'),
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
      candidate.public_case_id,
      candidate.case_value_score,
      impactClass(candidate.impact_score),
      evidenceQuality(candidate.evidence_score),
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
      candidate.public_case_id,
      candidate.contact_email,
      candidate.author_name || candidate.author_login || null,
      'Regarding your public platform/billing report',
      now
    ),
    env.CASE_DB.prepare(`
      UPDATE radar_candidates SET status = 'PROMOTED', promoted_at = ?2 WHERE public_case_id = ?1
    `).bind(candidate.public_case_id, now),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES (?1, 'RADAR_REAL_CASE_PROMOTED', 'PENDING_APPROVAL', 'AUTONOMOUS_RADAR', ?2)
    `).bind(candidate.public_case_id, now)
  ]);
  return candidate.public_case_id;
}

async function scanGitHub(env) {
  const seen = new Set();
  const candidates = [];
  for (const query of SEARCH_QUERIES) {
    const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=8`;
    let result;
    try {
      result = await githubJson(url);
    } catch {
      continue;
    }
    for (const item of result.items || []) {
      if (item.pull_request || seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      const title = clean(item.title, 300);
      const body = String(item.body || '');
      const scores = scoreCandidate(title, body);
      if (scores.caseValueScore < MIN_CASE_SCORE || scores.impactScore < 50 || scores.evidenceScore < 38) continue;
      candidates.push({ item, title, body, scores });
      if (candidates.length >= 8) break;
    }
    if (candidates.length >= 8) break;
  }

  let contactable = 0;
  for (const entry of candidates) {
    const contact = await discoverPublicContact(entry.item.user?.url);
    if (contact.email) contactable += 1;
    const caseId = await publicCaseId('GH', entry.item.id);
    await upsertCandidate(env, {
      source: 'GH',
      externalId: String(entry.item.id),
      caseId,
      url: String(entry.item.html_url || ''),
      title: entry.title,
      excerpt: clean(entry.body, 1800),
      authorLogin: contact.login || clean(entry.item.user?.login, 80) || null,
      authorName: contact.name || null,
      contactEmail: contact.email,
      contactRoute: contact.route,
      ...entry.scores
    });
  }
  return { discovered: seen.size, qualified: candidates.length, contactable };
}

export async function runRadarScan(env) {
  await ensureRadarSchema(env);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.CASE_DB.prepare(`
    INSERT INTO radar_runs (run_id, started_at, source) VALUES (?1, ?2, 'GITHUB_PUBLIC')
  `).bind(runId, startedAt).run();

  try {
    const result = await scanGitHub(env);
    const promotedCaseId = await promoteBestCandidate(env);
    const completedAt = new Date().toISOString();
    await env.CASE_DB.prepare(`
      UPDATE radar_runs SET completed_at = ?2, discovered_count = ?3, qualified_count = ?4,
        contactable_count = ?5, promoted_case_id = ?6 WHERE run_id = ?1
    `).bind(runId, completedAt, result.discovered, result.qualified, result.contactable, promotedCaseId).run();
    return { ok: true, runId, ...result, promotedCaseId };
  } catch (error) {
    await env.CASE_DB.prepare(`
      UPDATE radar_runs SET completed_at = ?2, error_code = ?3 WHERE run_id = ?1
    `).bind(runId, new Date().toISOString(), String(error.message || 'RADAR_FAILED').slice(0, 120)).run();
    throw error;
  }
}

export async function radarStatus(env) {
  await ensureRadarSchema(env);
  const lastRun = await env.CASE_DB.prepare(`
    SELECT run_id, started_at, completed_at, discovered_count, qualified_count,
           contactable_count, promoted_case_id, error_code
    FROM radar_runs ORDER BY started_at DESC LIMIT 1
  `).first();
  const ready = await env.CASE_DB.prepare(`
    SELECT COUNT(*) AS count FROM radar_candidates
    WHERE contact_email IS NOT NULL AND case_value_score >= ?1 AND status <> 'PROMOTED'
  `).bind(MIN_CASE_SCORE).first();
  return {
    live: true,
    lastRunAt: lastRun?.completed_at || lastRun?.started_at || null,
    lastRunError: lastRun?.error_code || null,
    lastDiscovered: Number(lastRun?.discovered_count || 0),
    lastQualified: Number(lastRun?.qualified_count || 0),
    lastContactable: Number(lastRun?.contactable_count || 0),
    lastPromotedCaseId: lastRun?.promoted_case_id || null,
    readyCandidates: Number(ready?.count || 0)
  };
}

export async function privateCaseDetail(env, caseId) {
  await ensureRadarSchema(env);
  const row = await env.CASE_DB.prepare(`
    SELECT public_case_id, source, source_url, source_title, source_excerpt,
           author_login, author_name, contact_email, contact_route,
           impact_score, evidence_score, case_value_score, amount_signal,
           first_seen_at, last_seen_at, promoted_at
    FROM radar_candidates WHERE public_case_id = ?1
  `).bind(caseId).first();
  if (!row) return null;
  return {
    caseId: row.public_case_id,
    source: row.source,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourceExcerpt: row.source_excerpt,
    authorLogin: row.author_login,
    authorName: row.author_name,
    contactEmail: row.contact_email,
    contactRoute: row.contact_route,
    impactScore: row.impact_score,
    evidenceScore: row.evidence_score,
    caseValueScore: row.case_value_score,
    amountSignal: row.amount_signal,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    promotedAt: row.promoted_at
  };
}
