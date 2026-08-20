const GITHUB_API = 'https://api.github.com';
const MIN_CASE_SCORE = 62;
const MAX_CANDIDATES_PER_RUN = 12;
const MAX_SITE_PAGES = 4;

const SOURCE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'gitlab.com',
  'discuss.ai.google.dev',
  'community.cloudflare.com'
]);

const ROLE_LOCALPARTS = [
  'business', 'info', 'contact', 'support', 'service', 'help', 'billing',
  'sales', 'office', 'hello', 'admin', 'team', 'customerservice', 'customer.service'
];

const clean = (value, max = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const validEmail = (value) => {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email);
};

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function safePublicUrl(raw) {
  if (!raw) return null;
  try {
    const prepared = /^https?:\/\//i.test(String(raw)) ? String(raw) : `https://${String(raw)}`;
    const url = new URL(prepared);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function registrableHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function isLikelyBusinessSite(url) {
  if (!url) return false;
  const host = registrableHost(url.hostname);
  if (!host || SOURCE_HOSTS.has(host)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|json|xml|txt)$/i.test(url.pathname)) return false;
  return true;
}

function extractUrls(text) {
  const source = String(text || '');
  const values = new Set();
  for (const match of source.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const value = String(match[0] || '').replace(/[.,;:!?]+$/, '');
    const url = safePublicUrl(value);
    if (isLikelyBusinessSite(url)) values.add(url.href);
  }
  for (const match of source.matchAll(/\b(?:www\.)?([a-z0-9][a-z0-9.-]+\.[a-z]{2,})(?:\/[^\s<>"')\]]*)?/gi)) {
    const value = String(match[0] || '').replace(/[.,;:!?]+$/, '');
    if (value.includes('@')) continue;
    const url = safePublicUrl(value);
    if (isLikelyBusinessSite(url)) values.add(url.href);
  }
  return [...values].slice(0, 8);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function scoreEmail(email, siteHost) {
  if (!validEmail(email)) return -1;
  const normalized = String(email).toLowerCase();
  const [local, domain] = normalized.split('@');
  let score = 0;
  if (ROLE_LOCALPARTS.includes(local)) score += 80;
  if (/^(business|info|contact|support|service|help|billing|sales|office|hello|team)[._-]/.test(local)) score += 55;
  if (registrableHost(domain) === registrableHost(siteHost)) score += 35;
  if (/(noreply|no-reply|donotreply|do-not-reply|privacy|abuse|security)/.test(local)) score -= 70;
  if (/(gmail\.com|outlook\.com|hotmail\.com|yahoo\.com|icloud\.com|proton\.me|protonmail\.com)$/.test(domain)) score -= 20;
  return score;
}

function extractEmails(html, siteHost) {
  const source = decodeHtmlEntities(html);
  const found = new Map();
  const add = (candidate, bonus = 0) => {
    const email = String(candidate || '').trim().replace(/^mailto:/i, '').split('?')[0];
    if (!validEmail(email)) return;
    const key = email.toLowerCase();
    const score = scoreEmail(key, siteHost) + bonus;
    if (score < 0) return;
    if (!found.has(key) || found.get(key).score < score) found.set(key, { email, score });
  };

  for (const match of source.matchAll(/mailto:([^?"'<>\s]+)/gi)) add(decodeURIComponent(match[1] || ''), 20);
  for (const match of source.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) add(match[0], 0);

  return [...found.values()].sort((a, b) => b.score - a.score);
}

function extractContactLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = clean(match[1], 1200);
    const label = clean(match[2].replace(/<[^>]+>/g, ' '), 300).toLowerCase();
    if (!/(contact|support|help|customer|service|about|impressum|imprint|legal|company|team)/i.test(`${href} ${label}`)) continue;
    try {
      const url = new URL(href, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || isPrivateHost(url.hostname)) continue;
      if (registrableHost(url.hostname) !== registrableHost(new URL(baseUrl).hostname)) continue;
      url.hash = '';
      const key = url.href;
      if (!seen.has(key)) {
        seen.add(key);
        links.push(key);
      }
    } catch {}
    if (links.length >= MAX_SITE_PAGES - 1) break;
  }
  return links;
}

async function fetchPublicPage(rawUrl) {
  const url = safePublicUrl(rawUrl);
  if (!isLikelyBusinessSite(url)) return null;
  try {
    const response = await fetch(url.href, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.6',
        'User-Agent': 'KF-001-Opportunity-Radar/3.0'
      }
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) return null;
    const finalUrl = safePublicUrl(response.url || url.href);
    if (!isLikelyBusinessSite(finalUrl)) return null;
    const html = (await response.text()).slice(0, 450000);
    return { url: finalUrl.href, host: finalUrl.hostname, html };
  } catch {
    return null;
  }
}

async function findBusinessEmailOnSite(rawUrl) {
  const first = await fetchPublicPage(rawUrl);
  if (!first) return null;
  const queue = [first, ...extractContactLinks(first.html, first.url).map((url) => ({ url }))];
  const visited = new Set();
  let best = null;

  for (let i = 0; i < queue.length && visited.size < MAX_SITE_PAGES; i += 1) {
    const item = queue[i];
    const page = item.html ? item : await fetchPublicPage(item.url);
    if (!page || visited.has(page.url)) continue;
    visited.add(page.url);
    const emails = extractEmails(page.html, page.host);
    if (emails[0] && (!best || emails[0].score > best.score)) {
      best = { ...emails[0], website: page.url };
      if (best.score >= 100) break;
    }
  }
  return best;
}

async function githubProfileWebsite(login) {
  if (!login) return null;
  try {
    const response = await fetch(`${GITHUB_API}/users/${encodeURIComponent(login)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'KF-001-Opportunity-Radar/3.0',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) return null;
    const profile = await response.json();
    if (validEmail(profile.email)) {
      return { email: String(profile.email).trim(), route: 'GITHUB_PUBLIC_EMAIL', website: null };
    }
    const site = safePublicUrl(profile.blog);
    if (isLikelyBusinessSite(site)) {
      const found = await findBusinessEmailOnSite(site.href);
      if (found) return { email: found.email, route: 'PUBLIC_WEBSITE_BUSINESS_EMAIL', website: found.website };
    }
  } catch {}
  return null;
}

async function githubRepositoryWebsite(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (registrableHost(url.hostname) !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    const response = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'KF-001-Opportunity-Radar/3.0',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) return null;
    const metadata = await response.json();
    const homepage = safePublicUrl(metadata.homepage);
    return isLikelyBusinessSite(homepage) ? homepage.href : null;
  } catch {
    return null;
  }
}

async function enrichCandidate(row) {
  if (row.source === 'GH' && row.author_login) {
    const profile = await githubProfileWebsite(row.author_login);
    if (profile?.email) return profile;
  }

  const sites = extractUrls(`${row.source_title || ''}\n${row.source_excerpt || ''}`);
  if (row.source === 'GH') {
    const repoWebsite = await githubRepositoryWebsite(row.source_url);
    if (repoWebsite) sites.unshift(repoWebsite);
  }

  const uniqueSites = [...new Set(sites)].slice(0, 6);
  for (const site of uniqueSites) {
    const found = await findBusinessEmailOnSite(site);
    if (found?.email) {
      return { email: found.email, route: 'PUBLIC_WEBSITE_BUSINESS_EMAIL', website: found.website };
    }
  }
  return null;
}

export async function enrichQualifiedContacts(env) {
  const rows = await env.CASE_DB.prepare(`
    SELECT public_case_id, source, source_url, source_title, source_excerpt,
           author_login, author_name, case_value_score, evidence_score
      FROM radar_candidates
     WHERE contact_email IS NULL
       AND case_value_score >= ?1
     ORDER BY case_value_score DESC, evidence_score DESC, last_seen_at DESC
     LIMIT ?2
  `).bind(MIN_CASE_SCORE, MAX_CANDIDATES_PER_RUN).all();

  let evaluated = 0;
  let enriched = 0;
  const enrichedCaseIds = [];
  for (const row of rows.results || []) {
    evaluated += 1;
    const contact = await enrichCandidate(row);
    if (!contact?.email || !validEmail(contact.email)) continue;
    await env.CASE_DB.prepare(`
      UPDATE radar_candidates
         SET contact_email = ?2,
             contact_route = ?3,
             last_seen_at = ?4
       WHERE public_case_id = ?1
         AND contact_email IS NULL
    `).bind(row.public_case_id, contact.email, contact.route, new Date().toISOString()).run();
    enriched += 1;
    enrichedCaseIds.push(row.public_case_id);
  }

  return { evaluated, enriched, enrichedCaseIds };
}
