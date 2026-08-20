import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerV3 = fs.readFileSync(path.join(here, '..', 'src', 'worker-v3.js'), 'utf8');

test('manual radar response remains the proven base-worker response', () => {
  assert.match(workerV3, /const response = await baseWorker\.fetch\(request, env, ctx\)/);
  assert.match(workerV3, /ctx\.waitUntil\(runAutonomySidecar\(env\)\)/);
  assert.match(workerV3, /return response;/);
  assert.doesNotMatch(workerV3, /return await enrichAfterManualRadar/);
});

test('autonomy sidecar contains its own failure boundary', () => {
  assert.match(workerV3, /async function runAutonomySidecar/);
  assert.match(workerV3, /AUTONOMY_SIDECAR_FAILED/);
  assert.match(workerV3, /A sidecar failure must never break/);
});
