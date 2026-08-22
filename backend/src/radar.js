const GITHUB_API = 'https://api.github.com';
const GITLAB_API = 'https://gitlab.com/api/v4';
const MIN_CASE_SCORE = 62;
const TERMINAL_CASE_STATUSES = new Set(['DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED']);

const GITHUB_QUERIES = [
  'is:issue is:open "unexpected charges" cloud',
  'is:issue is:open "unauthorized charges" billing',
  'is:issue is:open refund billing "google cloud"',
  'is:issue is:open "account suspended" billing api'
];

const GITLAB_QUERIES = [
  'unexpected charges billing',
  'unauthorized charges refund',
  'account suspended billing'
];

const DISCOURSE_SOURCES = [
  {
    key: 'GAI',
    baseUrl: 'https://discuss.ai.google.dev',
    queries: ['billing charged refund', 'account suspended billing']
  },
  {
    key: 'CF',
    baseUrl: 'https://community.cloudflare.com',
    queries: ['billing charged refund', 'support no response billing']
  }
];

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const clean = (value, max = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

function stripHtml(value, max = 6000) {
  return clean(
    String(value || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
    max
  );
}

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
    const raw = match.replace(/[^0-9.,]/g, '');
    let normalized = raw;
    if (raw.includes(',') && raw.includes('.')) {
      normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.')
        ? raw.replace(/\./g, '').replace(',', '.')
        : raw.replace(/,/g, '');
    } else if ((raw.match(/,/g) || []).length === 1 && /,\d{2}$/.test(raw)) {
      normalized = raw.replace(',', '.');
    } else {
      normalized = raw.replace(/,/g, '');
    }
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
    [/unexpected charge|unexpected bill|surprise bill|overcharg/, 16],
    [/unauthori[sz]ed|fraud|stolen|compromised/, 18],
    [/refund|reimbursement|chargeback/, 10],
    [/billing|invoice|charged|cost spike|payout held/, 9],
    [/suspend|disabled|locked|terminated/, 10],
    [/api key|credential|token|secret/, 8],
    [/google cloud|gcp|aws|azure|cloudflare|openai|platform/, 8],
    [/no (human )?reply|support loop|ticket closed|case closed|appeal denied|claim denied|no response/, 12]
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
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      host === 'localhost' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function explicitPublicEmail(text) {
  const source = String(text || '');
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const email = match[0];
    if (!validEmail(email)) continue;
    const left = Math.max(0, match.index - 120);
    const right = Math.min(source.length, match.index + email.length + 120);
    const context = source.slice(left, right).toLowerCase();
    if (/(contact|reach|e-?mail|mail me|write me|write to|contact me|my email|you can reach)/i.test(context)) {
      return email;
    }
  }
  return null;
}

async function publicWebsiteMailto(rawWebsite) {
  const website = safePublicWebsite(rawWebsite);
  if (!website) return null;
  try {
    const response = await fetch(website, {
      redirect: 'follow',
      headers: { 'User-Agent': 'KF-001-Opportunity-Radar/2.0' }
    });
    if (!response.ok) return null;
    const html = (await response.text()).slice(0, 350000);
    const matches = [...html.matchAll(/mailto:([^?"'<>\s]+)/gi)];
    for (const match of matches) {
      const email = decodeURIComponent(match[1] || '').trim();
      if (validEmail(email)) return email;
    }
    return null;
  } catch {
    return null;
  }
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'KF-001-Opportunity-Radar/2.0',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) throw new Error(`GITHUB_${response.status}`);
  return response.json();
}

async function gitlabJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'KF-001-Opportunity-Radar/2.0'
    }
  });
  if (!response.ok) throw new Error(`GITLAB_${response.status}`);
  return response.json();
}

async function discourseJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'KF-001-Opportunity-Radar/2.0'
    }
  });
  if (!response.ok) throw new Error(`DISCOURSE_${response.status}`);
  return response.json();
}

async function discoverGithubContact(item, body) {
  const explicit = explicitPublicEmail(body);
  if (explicit) {
    return {
      email: explicit,
      name: clean(item.user?.login, 120) || null,
      login: clean(item.user?.login, 80) || null,
      route: 'PUBLIC_POST_EMAIL'
    };
  }

  if (!item.user?.url) return { email: null, name: null, login: null, route: null };
  try {
    const profile = await githubJson(item.user.url);
    const directEmail = validEmail(profile.email) ? String(profile.email).trim() : null;
    if (directEmail) {
      return {
        email: directEmail,
        name: clean(profile.name || profile.login, 120),
        login: clean(profile.login, 80),
        route: 'GITHUB_PUBLIC_EMAIL'
      };
    }
    const websiteEmail = await publicWebsiteMailto(profile.blog);
    return {
      email: websiteEmail,
      name: clean(profile.name || profile.login, 120),
      login: clean(profile.login, 80),
      route: websiteEmail ? 'PUBLIC_WEBSITE_MAILTO' : null
    };
  } catch {
    return { email: null, name: null, login: clean(item.user?.login, 80) || null, route: null };
  }
}

async function discoverGitlabContact(item, body) {
  const explicit = explicitPublicEmail(body);
  const username = clean(item.author?.username, 80) || null;
  const name = clean(item.author?.name || username, 120) || null;
  if (explicit) return { email: explicit, name, login: username, route: 'PUBLIC_POST_EMAIL' };
  if (!username) return { email: null, name, login: username, route: null };

  try {
    const profiles = await gitlabJson(`${GITLAB_API}/users?username=${encodeURIComponent(username)}`);
    const profile = Array.isArray(profiles) ? profiles[0] : null;
    const directEmail = validEmail(profile?.public_email) ? String(profile.public_email).trim() : null;
    if (directEmail) return { email: directEmail, name, login: username, route: 'GITLAB_PUBLIC_EMAIL' };
    const websiteEmail = await publicWebsiteMailto(profile?.website_url);
    return { email: websiteEmail, name, login: username, route: websiteEmail ? 'PUBLIC_WEBSITE_MAILTO' : null };
  } catch {
    return { email: null, name, login: username, route: null };
  }
}

async function discoverDiscourseContact(baseUrl, username, body) {
  const explicit = explicitPublicEmail(body);
  if (explicit) return { email: explicit, name: clean(username, 120), login: clean(username, 80), route: 'PUBLIC_POST_EMAIL' };
  if (!username) return { email: null, name: null, login: null, route: null };

  try {
    const profilePayload = await discourseJson(baseUrl, `/u/${encodeURIComponent(username)}.json`);
    const user = profilePayload?.user || {};
    const displayName = clean(user.name || username, 120);
    const website = user.website || user.user_profile?.website || user.profile?.website || null;
    const websiteEmail = await publicWebsiteMailto(website);
    return {
      email: websiteEmail,
      name: displayName,
      login: clean(user.username || username, 80),
      route: websiteEmail ? 'PUBLIC_WEBSITE_MAILTO' : null
    };
  } catch {
    return { email: null, name: clean(username, 120), login: clean(username, 80), route: null };
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
        published_at TEXT,
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
      status, first_seen_at, last_seen_at, published_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'DISCOVERED', ?15, ?15, ?16)
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
      published_at = COALESCE(excluded.published_at, radar_candidates.published_at),
      last_seen_at = excluded.last_seen_at
  `).bind(
    candidate.source, candidate.externalId, candidate.caseId, candidate.url,
    candidate.title, candidate.excerpt, candidate.authorLogin, candidate.authorName,
    candidate.contactEmail, candidate.contactRoute, candidate.impactScore,
    candidate.evidenceScore, candidate.caseValueScore, candidate.amountSignal, now,
    candidate.publishedAt || null
  ).run();
}

export async function ingestVerifiedRadarCandidate(env, input) {
  await ensureRadarSchema(env);

  const source = clean(input.source, 12).toUpperCase();
  const externalId = clean(input.externalId, 180);
  const title = clean(input.title, 300);
  const targetEntity = clean(input.targetEntity, 160);
  const excerpt = clean(`${targetEntity ? `Target entity: ${targetEntity}. ` : ''}${input.rawDescription}`, 6000);
  const claimAmountUsd = Number(input.claimAmountUsd || 0);
  const caseId = await publicCaseId(source, externalId);
  const existing = await env.CASE_DB.prepare(`
    SELECT public_case_id, status FROM radar_candidates
    WHERE source = ?1 AND external_id = ?2
  `).bind(source, externalId).first();

  const scoringText = `${excerpt}\nVerified claim amount: USD ${claimAmountUsd.toFixed(2)}`;
  const scores = scoreCandidate(title, scoringText);
  scores.amountSignal = claimAmountUsd;

  const candidate = {
    source,
    externalId,
    caseId,
    url: clean(input.sourceUrl, 1200),
    title,
    excerpt,
    authorLogin: clean(input.authorLogin, 80) || null,
    authorName: clean(input.authorName, 120) || null,
    contactEmail: clean(input.contactEmail, 254) || null,
    contactRoute: clean(input.contactRoute, 80) || null,
    publishedAt: input.publishedAt || null,
    duplicate: Boolean(existing),
    ...scores
  };

  await upsertCandidate(env, candidate);
  return candidate;
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

  for (const query of GITHUB_QUERIES) {
    let result;
    try {
      result = await githubJson(`${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=8`);
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
      if (candidates.length >= 5) break;
    }
    if (candidates.length >= 5) break;
  }

  let contactable = 0;
  for (const entry of candidates) {
    const contact = await discoverGithubContact(entry.item, entry.body);
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
      publishedAt: entry.item.created_at || null,
      ...entry.scores
    });
  }

  return { source: 'GH', discovered: seen.size, qualified: candidates.length, contactable };
}

async function scanGitLab(env) {
  const seen = new Set();
  const candidates = [];

  for (const query of GITLAB_QUERIES) {
    const url = `${GITLAB_API}/issues?scope=all&state=opened&confidential=false&search=${encodeURIComponent(query)}&in=title,description&order_by=updated_at&sort=desc&per_page=8`;
    let result;
    try {
      result = await gitlabJson(url);
    } catch {
      continue;
    }

    for (const item of Array.isArray(result) ? result : []) {
      if (!item?.id || seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      const title = clean(item.title, 300);
      const body = String(item.description || '');
      const scores = scoreCandidate(title, body);
      if (scores.caseValueScore < MIN_CASE_SCORE || scores.impactScore < 50 || scores.evidenceScore < 38) continue;
      candidates.push({ item, title, body, scores });
      if (candidates.length >= 4) break;
    }
    if (candidates.length >= 4) break;
  }

  let contactable = 0;
  for (const entry of candidates) {
    const contact = await discoverGitlabContact(entry.item, entry.body);
    if (contact.email) contactable += 1;
    const caseId = await publicCaseId('GL', entry.item.id);
    await upsertCandidate(env, {
      source: 'GL',
      externalId: String(entry.item.id),
      caseId,
      url: String(entry.item.web_url || ''),
      title: entry.title,
      excerpt: clean(entry.body, 1800),
      authorLogin: contact.login || clean(entry.item.author?.username, 80) || null,
      authorName: contact.name || clean(entry.item.author?.name, 120) || null,
      contactEmail: contact.email,
      contactRoute: contact.route,
      publishedAt: entry.item.created_at || null,
      ...entry.scores
    });
  }

  return { source: 'GL', discovered: seen.size, qualified: candidates.length, contactable };
}

async function discoursePostBody(baseUrl, topicId, postNumber, fallback) {
  try {
    const topic = await discourseJson(baseUrl, `/t/${encodeURIComponent(topicId)}.json`);
    const posts = topic?.post_stream?.posts || [];
    const post = posts.find((value) => Number(value.post_number) === Number(postNumber)) || posts[0];
    return stripHtml(post?.raw || post?.cooked || fallback, 6000);
  } catch {
    return stripHtml(fallback, 6000);
  }
}

async function scanDiscourseSource(env, source) {
  const seen = new Set();
  const candidates = [];

  for (const query of source.queries) {
    let result;
    try {
      result = await discourseJson(source.baseUrl, `/search.json?q=${encodeURIComponent(query)}`);
    } catch {
      continue;
    }

    const topics = new Map((result.topics || []).map((topic) => [Number(topic.id), topic]));
    for (const post of (result.posts || []).slice(0, 10)) {
      const externalId = `${post.topic_id}:${post.post_number || 1}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      const topic = topics.get(Number(post.topic_id)) || {};
      const title = clean(topic.title || post.topic_title || `Topic ${post.topic_id}`, 300);
      let body = stripHtml(post.blurb || post.excerpt || '', 1800);
      let scores = scoreCandidate(title, body);
      if (scores.caseValueScore < MIN_CASE_SCORE || scores.impactScore < 50 || scores.evidenceScore < 38) continue;

      body = await discoursePostBody(source.baseUrl, post.topic_id, post.post_number || 1, body);
      scores = scoreCandidate(title, body);
      if (scores.caseValueScore < MIN_CASE_SCORE || scores.impactScore < 50 || scores.evidenceScore < 38) continue;

      candidates.push({ post, topic, externalId, title, body, scores });
      if (candidates.length >= 3) break;
    }
    if (candidates.length >= 3) break;
  }

  let contactable = 0;
  for (const entry of candidates) {
    const username = clean(entry.post.username, 80) || null;
    const contact = await discoverDiscourseContact(source.baseUrl, username, entry.body);
    if (contact.email) contactable += 1;
    const caseId = await publicCaseId(source.key, entry.externalId);
    const slug = clean(entry.topic.slug, 200);
    const postNumber = Number(entry.post.post_number || 1);
    const url = slug
      ? `${source.baseUrl}/t/${encodeURIComponent(slug)}/${entry.post.topic_id}/${postNumber}`
      : `${source.baseUrl}/t/${entry.post.topic_id}/${postNumber}`;

    await upsertCandidate(env, {
      source: source.key,
      externalId: entry.externalId,
      caseId,
      url,
      title: entry.title,
      excerpt: clean(entry.body, 1800),
      authorLogin: contact.login || username,
      authorName: contact.name || null,
      contactEmail: contact.email,
      contactRoute: contact.route,
      publishedAt: entry.post.created_at || entry.topic.created_at || null,
      ...entry.scores
    });
  }

  return { source: source.key, discovered: seen.size, qualified: candidates.length, contactable };
}

function aggregateSourceResults(results) {
  return results.reduce((total, item) => ({
    discovered: total.discovered + Number(item?.discovered || 0),
    qualified: total.qualified + Number(item?.qualified || 0),
    contactable: total.contactable + Number(item?.contactable || 0)
  }), { discovered: 0, qualified: 0, contactable: 0 });
}

export async function runRadarScan(env) {
  await ensureRadarSchema(env);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.CASE_DB.prepare(`
    INSERT INTO radar_runs (run_id, started_at, source) VALUES (?1, ?2, 'MULTI_PUBLIC')
  `).bind(runId, startedAt).run();

  try {
    const sourceResults = [];
    sourceResults.push(await scanGitHub(env));
    sourceResults.push(await scanGitLab(env));
    for (const source of DISCOURSE_SOURCES) {
      sourceResults.push(await scanDiscourseSource(env, source));
    }

    const result = aggregateSourceResults(sourceResults);
    const promotedCaseId = await promoteBestCandidate(env);
    const completedAt = new Date().toISOString();
    await env.CASE_DB.prepare(`
      UPDATE radar_runs SET completed_at = ?2, discovered_count = ?3, qualified_count = ?4,
        contactable_count = ?5, promoted_case_id = ?6 WHERE run_id = ?1
    `).bind(runId, completedAt, result.discovered, result.qualified, result.contactable, promotedCaseId).run();

    return { ok: true, runId, ...result, promotedCaseId, sources: sourceResults };
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
           first_seen_at, last_seen_at, promoted_at, published_at
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
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    promotedAt: row.promoted_at
  };
}
