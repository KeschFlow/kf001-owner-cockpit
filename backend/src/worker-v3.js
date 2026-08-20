import baseWorker from './worker-v2.js';
import { enrichQualifiedContacts } from './contact-enrichment.js';
import { selectBestEconomicCandidate } from './economic-selector.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  }
});

async function enrichAfterManualRadar(response, env) {
  if (!response.ok) return response;
  const payload = await response.clone().json().catch(() => null);
  if (!payload?.ok) return response;

  const contactEnrichment = await enrichQualifiedContacts(env);
  const postEnrichmentEconomicSelection = await selectBestEconomicCandidate(env);
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() !== 'content-length') headers[key] = value;
  }

  const economicWinner = postEnrichmentEconomicSelection?.score?.economicallyQualified
    ? postEnrichmentEconomicSelection.selectedCaseId || null
    : null;

  return json({
    ...payload,
    contactable: Number(payload.contactable || 0) + Number(contactEnrichment.enriched || 0),
    contactEnrichment,
    postEnrichmentEconomicSelection,
    promotedCaseId: economicWinner || payload.promotedCaseId || null
  }, response.status, headers);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/radar/run') {
      const response = await baseWorker.fetch(request, env, ctx);
      try {
        return await enrichAfterManualRadar(response, env);
      } catch (error) {
        const headers = {};
        for (const [key, value] of response.headers.entries()) {
          if (key.toLowerCase() !== 'content-length') headers[key] = value;
        }
        const payload = await response.clone().json().catch(() => ({}));
        return json({
          ...payload,
          contactEnrichment: { evaluated: 0, enriched: 0, error: String(error.message || 'CONTACT_ENRICHMENT_FAILED') },
          postEnrichmentEconomicSelection: null
        }, response.status, headers);
      }
    }
    return baseWorker.fetch(request, env, ctx);
  },

  scheduled(controller, env, ctx) {
    let basePromise = Promise.resolve();
    const captureCtx = {
      waitUntil(promise) {
        basePromise = Promise.resolve(promise);
      }
    };
    baseWorker.scheduled(controller, env, captureCtx);
    ctx.waitUntil((async () => {
      await basePromise;
      await enrichQualifiedContacts(env);
      await selectBestEconomicCandidate(env);
    })());
  }
};
