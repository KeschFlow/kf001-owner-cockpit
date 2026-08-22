import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker-v3.js';
import { handleRadarIntakeRequest, validateRadarIntakePayload } from '../src/radar-intake.js';

const QUALIFIED = Object.freeze({
  externalId: 'EXT-QUALIFIED-001',
  platform: 'reddit',
  sourceUrl: 'https://www.reddit.com/r/example/comments/verified-case/',
  title: 'Business reports an unresolved cloud billing anomaly and compromised API key',
  rawDescription: 'On 15/04/2026 the cloud platform sent a cost anomaly alert for unauthorized Gemini API usage. The company developer reports a compromised API key, an unresolved support case ID, repeated specialist team routing and no billing adjustment. Evidence includes the anomaly email, billing export, screenshots, audit logs, request metrics, invoice and a documented support timeline. The public report states a disputed recoverable amount of USD 18,596.35 and remains unresolved.',
  claimAmountUsd: 18596.35,
  targetEntity: 'Cloud platform billing',
  authorName: 'Public App Developer',
  contactEmail: 'support@example.test',
  contactRoute: 'PUBLIC_APP_SUPPORT_EMAIL'
});

const NOT_QUALIFIED = Object.freeze({
  externalId: 'EXT-WEAK-001',
  platform: 'verified_manual',
  sourceUrl: 'https://example.test/public-report',
  title: 'Small unexplained account charge',
  rawDescription: 'A public report says a small USD 25 charge appeared and asks whether it might be a routine billing item. No support case, invoice, timeline, platform acknowledgement, anomaly alert, logs or other evidence is available yet.',
  claimAmountUsd: 25,
  contactEmail: 'support@example.test',
  contactRoute: 'VERIFIED_PUBLIC_EMAIL'
});

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

class MemoryD1 {
  constructor() {
    this.candidates = new Map();
    this.cases = new Map();
    this.scores = new Map();
    this.dispatchTargets = new Map();
    this.events = [];
  }

  prepare(sql) {
    const db = this;
    return {
      sql,
      args: [],
      bind(...args) { this.args = args; return this; },
      async run() { return db.run(sql, this.args); },
      async first() { return db.first(sql, this.args); },
      async all() { return db.all(sql, this.args); }
    };
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async run(sql, args) {
    const statement = normalize(sql);
    if (/^(CREATE TABLE|CREATE INDEX)/.test(statement)) return { meta: { changes: 0 } };

    if (statement.startsWith('INSERT INTO radar_candidates')) {
      const key = `${args[0]}:${args[1]}`;
      const previous = this.candidates.get(key);
      this.candidates.set(key, {
        source: args[0], external_id: args[1], public_case_id: args[2], source_url: args[3],
        source_title: args[4], source_excerpt: args[5], author_login: args[6] ?? previous?.author_login ?? null,
        author_name: args[7] ?? previous?.author_name ?? null,
        contact_email: args[8] ?? previous?.contact_email ?? null,
        contact_route: args[9] ?? previous?.contact_route ?? null,
        impact_score: args[10], evidence_score: args[11], case_value_score: args[12], amount_signal: args[13],
        status: previous?.status || 'DISCOVERED', first_seen_at: previous?.first_seen_at || args[14],
        last_seen_at: args[14], promoted_at: previous?.promoted_at || null,
        published_at: args[15] ?? previous?.published_at ?? null
      });
      return { meta: { changes: 1 } };
    }

    if (statement.startsWith('INSERT INTO case_economic_scores')) {
      if (!this.cases.has(args[0])) throw new Error('FOREIGN KEY constraint failed: case_economic_scores');
      const previous = this.scores.get(args[0]);
      this.scores.set(args[0], {
        public_case_id: args[0], economic_score: args[1], economically_qualified: args[2],
        solvability_score: args[3], payer_probability_score: args[4], reachability_score: args[5],
        evidence_score: args[6], platform_ack_score: args[7], recoverable_value_score: args[8],
        effort_score: args[9], uncertainty_score: args[10], proprietary_data_value_score: args[11],
        reference_value_score: args[12], amount_currency: args[13], amount_native: args[14],
        amount_approx_usd: args[15], scoring_version: args[16], selected_at: args[17] || previous?.selected_at || null,
        updated_at: args[18]
      });
      return { meta: { changes: 1 } };
    }

    if (statement.startsWith('INSERT INTO cases')) {
      const previous = this.cases.get(args[0]);
      this.cases.set(args[0], {
        public_case_id: args[0], case_value_score: args[1], outreach_ready: 1,
        impact_class: args[2], evidence_quality: args[3], recommendation: 'APPROVE OUTREACH',
        outreach_message: args[4], status: 'PENDING_APPROVAL', version: (previous?.version || 0) + 1,
        is_active: 1, updated_at: args[5]
      });
      return { meta: { changes: 1 } };
    }

    if (statement.startsWith('INSERT INTO dispatch_targets')) {
      this.dispatchTargets.set(args[0], { public_case_id: args[0], recipient_email: args[1], recipient_name: args[2] });
      return { meta: { changes: 1 } };
    }

    if (statement.startsWith('INSERT INTO state_events')) {
      this.events.push({ public_case_id: args[0], created_at: args.at(-1), sql: statement });
      return { meta: { changes: 1 } };
    }

    if (statement.startsWith('UPDATE cases SET case_value_score')) {
      const row = this.cases.get(args[0]);
      if (row?.status === 'PENDING_APPROVAL') Object.assign(row, { case_value_score: args[1], version: row.version + 1, updated_at: args[2] });
      return { meta: { changes: row ? 1 : 0 } };
    }

    if (statement.startsWith('UPDATE cases SET is_active = 0')) {
      const row = this.cases.get(args[0]);
      if (row) Object.assign(row, { is_active: 0, version: row.version + 1, updated_at: args[1] });
      return { meta: { changes: row ? 1 : 0 } };
    }

    if (statement.startsWith('UPDATE radar_candidates SET status')) {
      const row = [...this.candidates.values()].find((candidate) => candidate.public_case_id === args[0]);
      if (row) {
        row.status = statement.includes("status = 'PROMOTED'") ? 'PROMOTED' : 'DISCOVERED';
        if (row.status === 'PROMOTED') row.promoted_at = args[1];
      }
      return { meta: { changes: row ? 1 : 0 } };
    }

    throw new Error(`Unhandled D1 run statement: ${statement}`);
  }

  async first(sql, args) {
    const statement = normalize(sql);
    if (statement.includes('FROM radar_candidates') && statement.includes('WHERE source = ?1 AND external_id = ?2')) {
      const row = this.candidates.get(`${args[0]}:${args[1]}`);
      return row ? { public_case_id: row.public_case_id, status: row.status } : null;
    }
    if (statement.includes('FROM cases WHERE is_active = 1')) {
      return [...this.cases.values()].filter((row) => row.is_active === 1).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] || null;
    }
    throw new Error(`Unhandled D1 first statement: ${statement}`);
  }

  async all(sql) {
    const statement = normalize(sql);
    if (statement.includes('FROM radar_candidates r') && statement.includes('LEFT JOIN cases c')) {
      const results = [...this.candidates.values()]
        .filter((row) => row.contact_email && row.case_value_score >= 62)
        .filter((row) => !['DISPATCHED', 'RESPONSE_RECEIVED', 'REJECTED'].includes(this.cases.get(row.public_case_id)?.status))
        .map((row) => ({ ...row, existing_case_id: this.cases.has(row.public_case_id) ? row.public_case_id : null }));
      return { results };
    }
    throw new Error(`Unhandled D1 all statement: ${statement}`);
  }
}

function request(payload, token = 'UNIT_TEST_ONLY') {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request('https://worker.test/v1/radar/intake', {
    method: 'POST', headers, body: JSON.stringify(payload)
  });
}

test('intake without a token is rejected', async () => {
  const response = await handleRadarIntakeRequest(request(QUALIFIED, null), { RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY', CASE_DB: new MemoryD1() });
  assert.equal(response.status, 401);
});

test('intake auth requires an exact bearer token match', async () => {
  const env = { RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY', CASE_DB: new MemoryD1() };
  assert.equal((await handleRadarIntakeRequest(request(QUALIFIED, 'WRONG'), env)).status, 401);
  assert.equal((await handleRadarIntakeRequest(request(QUALIFIED, 'UNIT_TEST_ONLY-extra'), env)).status, 401);
});

test('verified intake reaches the real ECON_V1 selector and Owner Gate', async () => {
  const db = new MemoryD1();
  const response = await handleRadarIntakeRequest(request(QUALIFIED), { RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY', CASE_DB: db });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, false);
  assert.equal(body.economicEvaluation.scoringVersion, 'ECON_V1');
  assert.equal(body.economicEvaluation.economicallyQualified, true);
  assert.equal(body.economicSelection.reason, 'ECONOMIC_WINNER_SELECTED');
  assert.equal(body.economicSelection.selectedCaseId, body.intake.publicCaseId);
  assert.equal(db.candidates.size, 1);
  assert.equal(db.cases.get(body.intake.publicCaseId)?.status, 'PENDING_APPROVAL');
  assert.equal(db.cases.get(body.intake.publicCaseId)?.is_active, 1);
  assert.equal(db.scores.get(body.intake.publicCaseId)?.scoring_version, 'ECON_V1');
  assert.equal(db.scores.get(body.intake.publicCaseId)?.economically_qualified, 1);
  assert.equal(db.dispatchTargets.get(body.intake.publicCaseId)?.recipient_email, QUALIFIED.contactEmail);
  assert.equal([...db.candidates.values()][0].contact_route, 'PUBLIC_APP_SUPPORT_EMAIL');
});

test('duplicate intake is idempotent and does not create a second candidate or gate', async () => {
  const db = new MemoryD1();
  const env = { RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY', CASE_DB: db };
  const first = await handleRadarIntakeRequest(request(QUALIFIED), env);
  const firstBody = await first.json();
  const firstSeenAt = [...db.candidates.values()][0].first_seen_at;
  const second = await handleRadarIntakeRequest(request(QUALIFIED), env);
  const secondBody = await second.json();

  assert.equal(second.status, 200);
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.intake.publicCaseId, firstBody.intake.publicCaseId);
  assert.equal(db.candidates.size, 1);
  assert.equal(db.cases.size, 1);
  assert.equal([...db.candidates.values()][0].first_seen_at, firstSeenAt);
});

test('caller score hints cannot manipulate radar or ECON_V1 scoring', async () => {
  const db = new MemoryD1();
  const hinted = { ...QUALIFIED, caseValueScore: 100, impactScore: 100, evidenceScore: 100, economicScore: 100, economicallyQualified: false };
  const normalized = validateRadarIntakePayload(hinted);
  assert.equal('caseValueScore' in normalized, false);
  assert.equal('economicScore' in normalized, false);

  const response = await handleRadarIntakeRequest(request(hinted), { RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY', CASE_DB: db });
  const body = await response.json();
  assert.notEqual(body.intake.caseValueScore, hinted.caseValueScore);
  assert.notEqual(body.economicEvaluation.economicScore, hinted.economicScore);
  assert.equal(body.economicEvaluation.economicallyQualified, true);
});

test('non-qualified intake remains discovered and is not promoted to Owner Gate', async () => {
  const db = new MemoryD1();
  const response = await handleRadarIntakeRequest(request(NOT_QUALIFIED), { RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY', CASE_DB: db });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.economicEvaluation.economicallyQualified, false);
  assert.equal(body.economicSelection.reason, 'NO_ECONOMICALLY_QUALIFIED_CASE');
  assert.equal(db.cases.size, 0);
  assert.equal([...db.candidates.values()][0].status, 'DISCOVERED');
});

test('production worker v3 exposes the protected intake route', async () => {
  const response = await worker.fetch(request({}, null), { RADAR_INGEST_TOKEN: 'UNIT_TEST_ONLY', CASE_DB: {} }, { waitUntil() {} });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'UNAUTHORIZED');
});
