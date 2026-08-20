import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const enrichment = fs.readFileSync(path.join(here, '..', 'src', 'contact-enrichment.js'), 'utf8');
const workerV3 = fs.readFileSync(path.join(here, '..', 'src', 'worker-v3.js'), 'utf8');
const wrangler = fs.readFileSync(path.join(here, '..', 'wrangler.toml'), 'utf8');

test('qualified cases without contacts are enriched from public business websites', () => {
  assert.match(enrichment, /contact_email IS NULL/);
  assert.match(enrichment, /PUBLIC_WEBSITE_BUSINESS_EMAIL/);
  assert.match(enrichment, /ROLE_LOCALPARTS/);
  assert.match(enrichment, /contact|support|impressum|imprint/);
});

test('autonomy sidecar enriches contacts and then re-runs economic selection without blocking manual radar', () => {
  assert.match(workerV3, /async function runAutonomySidecar/);
  assert.match(workerV3, /enrichQualifiedContacts\(env\)/);
  assert.match(workerV3, /selectBestEconomicCandidate\(env\)/);
  assert.match(workerV3, /ctx\.waitUntil\(runAutonomySidecar\(env\)\)/);
  assert.match(workerV3, /return response;/);
  assert.doesNotMatch(workerV3, /postEnrichmentEconomicSelection/);
  assert.doesNotMatch(workerV3, /return await enrichAfterManualRadar/);
});

test('production entrypoint uses worker v3', () => {
  assert.match(wrangler, /main = "src\/worker-v3\.js"/);
});
