import baseWorker from './worker-v2.js';
import { enrichQualifiedContacts } from './contact-enrichment.js';
import { selectBestEconomicCandidate } from './economic-selector.js';

async function runAutonomySidecar(env) {
  try {
    const contactEnrichment = await enrichQualifiedContacts(env);
    const economicSelection = await selectBestEconomicCandidate(env);
    return { ok: true, contactEnrichment, economicSelection };
  } catch (error) {
    // Autonomy is additive only. A sidecar failure must never break the known-good
    // manual radar / owner-gate / dispatch path.
    return {
      ok: false,
      error: String(error?.message || 'AUTONOMY_SIDECAR_FAILED')
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const response = await baseWorker.fetch(request, env, ctx);
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/v1/radar/run' && response.ok) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.ok) {
        // Preserve yesterday's proven manual flow exactly. Contact enrichment and
        // post-scan economic reselection now run after the response, in the background.
        // They may improve the next owner-state read, but they cannot delay or corrupt
        // the manual radar response itself.
        ctx.waitUntil(runAutonomySidecar(env));
      }
    }

    return response;
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
      await runAutonomySidecar(env);
    })());
  }
};
