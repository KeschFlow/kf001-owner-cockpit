import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(here, '..', 'migrations', '0011_dynamic_success_fee_checkout.sql'),
  'utf8'
);

test('dynamic pricing migration is additive and persists the complete pricing and payment audit', () => {
  const requiredColumns = [
    'success_fee_percent',
    'success_fee_min_eur',
    'success_fee_max_eur',
    'success_min_recovered_usd',
    'usd_to_eur_rate',
    'calculated_fee_eur',
    'calculated_fee_minor',
    'stripe_checkout_session_id',
    'stripe_checkout_url',
    'stripe_payment_intent_id',
    'stripe_payment_event_id',
    'checkout_creation_attempted_at',
    'checkout_created_at',
    'checkout_expires_at',
    'payment_confirmed_at'
  ];
  for (const column of requiredColumns) assert.match(migration, new RegExp(`ADD COLUMN ${column}\\b`));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS stripe_webhook_events/);
  assert.match(migration, /event_id TEXT PRIMARY KEY/);
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
});
