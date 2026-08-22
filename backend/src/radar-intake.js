import { ingestVerifiedRadarCandidate } from './radar.js';
import { scoreEconomicCandidate, selectBestEconomicCandidate } from './economic-selector.js';

const PLATFORM_TO_SOURCE = Object.freeze({
  reddit: 'RDT',
  github: 'GH',
  gitlab: 'GL',
  google_ai_forum: 'GAI',
  cloudflare_forum: 'CF',
  verified_manual: 'MAN'
});

const CONTACT_ROUTES = new Set([
  'PUBLIC_WEBSITE_MAILTO',
  'PUBLIC_APP_SUPPORT_EMAIL',
  'VERIFIED_PUBLIC_EMAIL',
  'PUBLIC_POST_EMAIL',
  'GITHUB_PUBLIC_EMAIL',
  'GITLAB_PUBLIC_EMAIL'
]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});

const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function validEmail(value) {
  const email = clean(value, 254);
  return email.length > 3 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAuthorized(request, env) {
  if (!env.RADAR_INGEST_TOKEN) return false;
  return request.headers.get('Authorization') === `Bearer ${env.RADAR_INGEST_TOKEN}`;
}

function normalizeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function validateRadarIntakePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_BODY');

  const platform = clean(body.platform, 40).toLowerCase();
  const source = PLATFORM_TO_SOURCE[platform];
  if (!source) throw new Error('INVALID_PLATFORM');

  const externalId = clean(body.externalId, 180);
  if (externalId.length < 3) throw new Error('INVALID_EXTERNAL_ID');

  const sourceUrl = normalizeHttpsUrl(body.sourceUrl);
  if (!sourceUrl) throw new Error('INVALID_SOURCE_URL');

  const title = clean(body.title, 300);
  if (title.length < 8) throw new Error('INVALID_TITLE');

  const rawDescription = clean(body.rawDescription, 6000);
  if (rawDescription.length < 120) throw new Error('EVIDENCE_TOO_SHORT');

  const claimAmountUsd = Number(body.claimAmountUsd);
  if (!Number.isFinite(claimAmountUsd) || claimAmountUsd <= 0 || claimAmountUsd > 1_000_000_000) {
    throw new Error('INVALID_CLAIM_AMOUNT_USD');
  }

  if (!validEmail(body.contactEmail)) throw new Error('VERIFIED_CONTACT_EMAIL_REQUIRED');
  const contactRoute = clean(body.contactRoute, 80).toUpperCase();
  if (!CONTACT_ROUTES.has(contactRoute)) throw new Error('INVALID_CONTACT_ROUTE');

  const publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;
  if (publishedAt && Number.isNaN(publishedAt.getTime())) throw new Error('INVALID_PUBLISHED_AT');

  return {
    source,
    platform,
    externalId,
    sourceUrl,
    title,
    rawDescription,
    claimAmountUsd: Math.round(claimAmountUsd * 100) / 100,
    targetEntity: clean(body.targetEntity, 160) || null,
    authorLogin: clean(body.authorLogin, 80) || null,
    authorName: clean(body.authorName, 120) || null,
    contactEmail: clean(body.contactEmail, 254),
    contactRoute,
    publishedAt: publishedAt ? publishedAt.toISOString() : null
  };
}

export async function handleRadarIntakeRequest(request, env) {
  if (!isAuthorized(request, env)) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  if (!env.CASE_DB) return json({ ok: false, error: 'D1_NOT_CONFIGURED' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  let input;
  try {
    input = validateRadarIntakePayload(body);
  } catch (error) {
    return json({ ok: false, error: String(error?.message || 'INVALID_INTAKE_PAYLOAD') }, 400);
  }

  try {
    const candidate = await ingestVerifiedRadarCandidate(env, input);
    const economicEvaluation = scoreEconomicCandidate({
      source_title: candidate.title,
      source_excerpt: candidate.excerpt,
      evidence_score: candidate.evidenceScore,
      impact_score: candidate.impactScore,
      amount_signal: candidate.amountSignal,
      contact_email: candidate.contactEmail,
      contact_route: candidate.contactRoute,
      author_name: candidate.authorName,
      author_login: candidate.authorLogin
    });
    const economicSelection = await selectBestEconomicCandidate(env);

    return json({
      ok: true,
      duplicate: candidate.duplicate,
      intake: {
        publicCaseId: candidate.caseId,
        source: candidate.source,
        externalId: candidate.externalId,
        caseValueScore: candidate.caseValueScore,
        impactScore: candidate.impactScore,
        evidenceScore: candidate.evidenceScore,
        amountSignalUsd: candidate.amountSignal,
        contactReady: Boolean(candidate.contactEmail),
        contactRoute: candidate.contactRoute
      },
      economicEvaluation,
      economicSelection
    }, candidate.duplicate ? 200 : 201);
  } catch {
    return json({ ok: false, error: 'RADAR_INTAKE_FAILED' }, 500);
  }
}
