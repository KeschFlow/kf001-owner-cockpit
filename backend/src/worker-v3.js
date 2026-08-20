import baseWorker from './worker-v2.js';
import { enrichQualifiedContacts } from './contact-enrichment.js';
import { selectBestEconomicCandidate } from './economic-selector.js';
import { revenueAutopilotStatus, runRevenueAutopilot } from './revenue-autopilot.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  }
});

async function runAutonomySidecar(env) {
  try {
    const contactEnrichment = await enrichQualifiedContacts(env);
    const economicSelection = await selectBestEconomicCandidate(env);
    const revenueAutopilot = await runRevenueAutopilot(env);
    return { ok: true, contactEnrichment, economicSelection, revenueAutopilot };
  } catch (error) {
    // Autonomy is additive only. A sidecar failure must never break the known-good
    // radar / scoring / owner-state path. Revenue autopilot has its own idempotency,
    // single-case lock and outbound cap.
    return {
      ok: false,
      error: String(error?.message || 'AUTONOMY_SIDECAR_FAILED')
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/v1/autopilot/status') {
      try {
        return json(await revenueAutopilotStatus(env));
      } catch (error) {
        return json({ enabled: false, stage: 'ERROR', error: String(error?.message || 'AUTOPILOT_STATUS_FAILED') }, 503);
      }
    }

    const response = await baseWorker.fetch(request, env, ctx);

    if (request.method === 'POST' && url.pathname === '/v1/radar/run' && response.ok) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.ok) {
        // Manual scan returns immediately. The autonomous layer then enriches public
        // business contacts, re-ranks the winner and, when the hard economic gate is
        // met, sends exactly one initial outreach without waiting for Owner Gate 1.
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
