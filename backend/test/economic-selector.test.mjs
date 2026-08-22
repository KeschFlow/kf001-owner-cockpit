import test from 'node:test';
import assert from 'node:assert/strict';
import { caseCheckEligible, extractEconomicAmount, scoreEconomicCandidate } from '../src/economic-selector.js';

test('extractEconomicAmount recognizes SEK and normalizes it conservatively for ranking', () => {
  const amount = extractEconomicAmount('Unauthorized Gemini usage exceeded SEK 200,000 and 47,836 SEK left the bank account.');
  assert.equal(amount.currency, 'SEK');
  assert.equal(amount.amount, 200000);
  assert.ok(amount.approxUsd >= 20000);
});

test('approved credits plus bank mismatch rank as a strong economic case', () => {
  const score = scoreEconomicCandidate({
    source_title: 'Company still missing cash after Google Gemini billing incident',
    source_excerpt: 'Flexibel AB reports SEK 200,000 unauthorized Gemini API usage. Five support cases exist. Google issued credit notes of about SEK 191,000 and an approved refund, but money has not reached the company bank account. Cost anomaly alert, invoices, bank statements, support case IDs and Trust & Safety classification are available. The founder says the case remains unresolved.',
    contact_email: 'info@example-company.se',
    contact_route: 'PUBLIC_WEBSITE_MAILTO',
    author_name: 'Company Founder',
    evidence_score: 92,
    impact_score: 96,
    amount_signal: 0
  });

  assert.equal(score.economicallyQualified, true);
  assert.ok(score.economicScore >= 72);
  assert.ok(score.solvability >= 60);
  assert.ok(score.platformAck >= 60);
  assert.ok(score.proprietaryDataValue >= 60);
  assert.ok(score.amountApproxUsd >= 8000);
});

test('large but weakly evidenced anonymous complaint does not qualify automatically', () => {
  const score = scoreEconomicCandidate({
    source_title: 'Huge unexpected bill',
    source_excerpt: 'I got charged USD 500,000. Please help.',
    contact_email: 'person@gmail.com',
    contact_route: 'GITHUB_PUBLIC_EMAIL',
    author_name: null,
    evidence_score: 25,
    impact_score: 80,
    amount_signal: 500000
  });

  assert.equal(score.economicallyQualified, false);
});

test('economic score rewards acknowledged recoverability over raw damage alone', () => {
  const acknowledged = scoreEconomicCandidate({
    source_title: 'Business refund approved but not settled',
    source_excerpt: 'Company LLC has USD 18,000 disputed billing. Support case ID exists, refund approved, credit memo issued, invoices and bank statement available, but settlement is still unresolved.',
    contact_email: 'finance@company.example',
    contact_route: 'PUBLIC_WEBSITE_MAILTO',
    author_name: 'Owner',
    evidence_score: 88,
    impact_score: 80,
    amount_signal: 18000
  });

  const spectacular = scoreEconomicCandidate({
    source_title: 'Unexpected charge',
    source_excerpt: 'USD 1,000,000 unexpected platform charge. No documents, no ticket and no response details are provided.',
    contact_email: 'user@gmail.com',
    contact_route: 'GITHUB_PUBLIC_EMAIL',
    author_name: null,
    evidence_score: 32,
    impact_score: 95,
    amount_signal: 1000000
  });

  assert.ok(acknowledged.economicScore > spectacular.economicScore);
  assert.equal(acknowledged.economicallyQualified, true);
  assert.equal(spectacular.economicallyQualified, false);
});

test('existing case-check thresholds accept a smaller documented case without calling it success-fee qualified', () => {
  const score = scoreEconomicCandidate({
    source_title: 'Business account has unresolved platform auto-charge discrepancy',
    source_excerpt: 'A company developer documents USD 860 in disputed auto-charges and an unexplained balance. The public report includes invoices, screenshots, transaction dates, a support case and a timeline, and remains unresolved after billing support contact.',
    contact_email: 'billing@company.example',
    contact_route: 'PUBLIC_POST_EMAIL',
    author_name: 'Business account owner',
    evidence_score: 75,
    impact_score: 80,
    amount_signal: 860
  });

  const env = { CASE_CHECK_ENABLED: 'true', CASE_CHECK_MIN_ECONOMIC_SCORE: '58', CASE_CHECK_MIN_VALUE_USD: '500' };
  assert.equal(score.economicallyQualified, false);
  assert.equal(caseCheckEligible(score, env), true);
  assert.equal(caseCheckEligible(score, { ...env, CASE_CHECK_ENABLED: 'false' }), false);
});
