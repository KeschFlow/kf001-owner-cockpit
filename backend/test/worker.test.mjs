import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const row = {
  public_case_id: 'PUB-001',
  case_value_score: null,
  outreach_ready: 1,
  impact_class: 'HOCH',
  evidence_quality: 'PRIVATE / NOT EXPOSED',
  recommendation: 'APPROVE OUTREACH',
  outreach_message: 'Öffentlich abstrahierte Nachricht.',
  status: 'PENDING_APPROVAL',
  version: 1,
  updated_at: '2026-08-17T00:00:00.000Z'
};

function env() {
  return {
    PUBLIC_APP_ORIGIN: 'https://keschflow.github.io',
    RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY',
    CASE_DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() { return sql.includes('FROM cases') ? row : { ok: 1 }; }
        };
      },
      async batch() { return []; }
    }
  };
}

test('health truthfully reports D1 live and push/dispatch not live', async () => {
  const response = await worker.fetch(new Request('https://worker.test/health'), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'kf001-owner-backend',
    centralState: 'LIVE',
    d1SourceOfTruth: 'LIVE',
    realPush: 'NOT_LIVE',
    realOutreachDispatch: 'NOT_LIVE'
  });
});

test('owner state comes from D1 and allows only the public PWA origin', async () => {
  const response = await worker.fetch(new Request('https://worker.test/v1/owner-state', {
    headers: { Origin: 'https://keschflow.github.io' }
  }), env());
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://keschflow.github.io');
  const body = await response.json();
  assert.equal(body.stateSource, 'D1');
  assert.equal(body.isSourceOfTruth, true);
  assert.equal(body.caseId, 'PUB-001');
  assert.equal(body.caseValueScore, 'PRIVATE / NOT EXPOSED');
});

test('radar writes require the Worker secret', async () => {
  const response = await worker.fetch(new Request('https://worker.test/v1/radar/cases', {
    method: 'POST',
    body: '{}'
  }), env());
  assert.equal(response.status, 401);
});

test('approval and push stay explicitly not live', async () => {
  const approval = await worker.fetch(new Request('https://worker.test/v1/approval-intents', { method: 'POST' }), env());
  const push = await worker.fetch(new Request('https://worker.test/v1/push/subscriptions', { method: 'POST' }), env());
  assert.equal(approval.status, 503);
  assert.equal((await approval.json()).dispatchExecuted, false);
  assert.equal(push.status, 503);
});
