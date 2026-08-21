import { getGmailThread, gmailConfigured, sendGmail, sendGmailReply } from './gmail.js';
import {
  calculateSuccessFee,
  createCaseCheckCheckoutSession,
  createSuccessFeeCheckoutSession,
  stripeIdempotencyKey,
  stripeCheckoutConfigured,
  successFeeConfig
} from './stripe.js';

const DEFAULT_MIN_SCORE = 72;
const DEFAULT_MIN_VALUE_USD = 8000;
const LOCK_SECONDS = 180;

const OPEN_STAGES = new Set([
  'CONTACT_CLAIMED',
  'OUTREACH_SENT',
  'TERMS_SENT',
  'ENGAGED',
  'EVIDENCE_RECEIVED',
  'RESPONSE_REVIEW',
  'REPLY_MONITOR_BLOCKED',
  'SEND_UNKNOWN',
  'SUCCESS_CONFIRMATION_PENDING',
  'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED',
  'PAYMENT_MESSAGE_SEND_UNKNOWN',
  'PAYMENT_PENDING'
  ,'CASE_CHECK_PAYMENT_PENDING'
  ,'CASE_CHECK_PAID_AWAITING_EVIDENCE'
]);

const CLOSED_STAGES = new Set([
  'CLOSED_NOT_INTERESTED',
  'CLOSED_NO_RESPONSE',
  'CLOSED_OTHER',
  'PAID'
]);

const ROLE_EMAIL = /^(business|info|support|service|contact|hello|office|billing|accounts|admin|sales|founder|ceo|owner|team)@/i;

const nowIso = () => new Date().toISOString();
const clean = (value, max = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function enabled(env) {
  return String(env.REVENUE_AUTOPILOT_ENABLED || '').toLowerCase() === 'true';
}

function caseCheckEnabled(env) {
  return String(env.CASE_CHECK_ENABLED || '').toLowerCase() === 'true';
}

function numericEnv(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function header(message, name) {
  const headers = message?.payload?.headers || [];
  const found = headers.find((item) => String(item.name || '').toLowerCase() === String(name).toLowerCase());
  return clean(found?.value, 1000) || null;
}

function decodeBase64urlUtf8(value) {
  if (!value) return '';
  try {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function payloadText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64urlUtf8(payload.body.data);
  for (const part of payload.parts || []) {
    const text = payloadText(part);
    if (text) return text;
  }
  if (payload.body?.data) return decodeBase64urlUtf8(payload.body.data);
  return '';
}

function attachmentNames(payload, output = []) {
  if (!payload) return output;
  if (payload.filename) output.push(clean(payload.filename, 300));
  for (const part of payload.parts || []) attachmentNames(part, output);
  return output.filter(Boolean);
}

function inboundMessages(thread, recipientEmail, afterIso) {
  const email = String(recipientEmail || '').toLowerCase();
  const afterMs = Date.parse(afterIso || '') || 0;
  return (thread?.messages || [])
    .filter((message) => {
      const from = String(header(message, 'From') || '').toLowerCase();
      const when = Number(message.internalDate || 0);
      return from.includes(email) && when >= afterMs;
    })
    .map((message) => ({
      id: String(message.id || ''),
      internalDate: Number(message.internalDate || 0),
      messageIdHeader: header(message, 'Message-ID'),
      references: header(message, 'References'),
      subject: header(message, 'Subject'),
      text: clean(payloadText(message.payload) || message.snippet || '', 12000),
      attachments: attachmentNames(message.payload)
    }))
    .sort((a, b) => a.internalDate - b.internalDate);
}

function extractApproxUsd(text) {
  const source = String(text || '');
  const matches = [];
  const patterns = [
    { rate: 1, regex: /(?:USD|US\$|\$)\s?([0-9][0-9.,\s]{1,})/gi },
    { rate: 1.1, regex: /(?:EUR|€)\s?([0-9][0-9.,\s]{1,})/gi },
    { rate: 1.27, regex: /(?:GBP|£)\s?([0-9][0-9.,\s]{1,})/gi },
    { rate: 0.105, regex: /(?:SEK|kr)\s?([0-9][0-9.,\s]{1,})/gi }
  ];
  for (const { rate, regex } of patterns) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const raw = String(match[1] || '').replace(/\s/g, '');
      let normalized = raw;
      if (raw.includes(',') && raw.includes('.')) {
        normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.')
          ? raw.replace(/\./g, '').replace(',', '.')
          : raw.replace(/,/g, '');
      } else if ((raw.match(/,/g) || []).length === 1 && /,\d{2}$/.test(raw)) {
        normalized = raw.replace(',', '.');
      } else {
        normalized = raw.replace(/,/g, '');
      }
      const amount = Number.parseFloat(normalized);
      if (Number.isFinite(amount) && amount > 0) matches.push(amount * rate);
    }
  }
  return matches.length ? Math.max(...matches) : 0;
}

function classifyReply(text, attachments, stage) {
  const source = String(text || '').toLowerCase();
  if (/\b(stop|unsubscribe|remove me|not interested|no thanks|do not contact|don't contact|resolved already|already resolved)\b/.test(source)) {
    return 'NEGATIVE';
  }
  if (stage === 'ENGAGED' || stage === 'EVIDENCE_RECEIVED' || stage === 'SUCCESS_CONFIRMATION_PENDING') {
    if (/(refund(?:ed)?|credit(?:ed)?|waiv(?:ed|er)|money back|recovered|reimbursement|cancel(?:led|ed)|voided)/.test(source)
      && /(received|approved|completed|landed|paid back|back in|resolved|successful|cancel(?:led|ed)|voided)/.test(source)) {
      return 'SUCCESS';
    }
  }
  if (stage === 'TERMS_SENT' && /\b(i agree|agreed|i accept|accepted|accept the terms|agree to the terms)\b/.test(source)) {
    return 'ACCEPT';
  }
  if ((attachments || []).length > 0 || /\b(attached|attachment|invoice|statement|screenshot|support case|case id|ticket|timeline|logs?)\b/.test(source)) {
    return 'EVIDENCE';
  }
  if (/\b(yes|interested|please proceed|go ahead|sounds good|still unresolved|still open|help me|send the checklist|let's proceed|lets proceed)\b/.test(source)) {
    return 'POSITIVE';
  }
  return 'AMBIGUOUS';
}

function initialMessage(row, env) {
  const pricing = successFeeConfig(env);
  const name = clean(row.recipient_name, 120);
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const amount = Number(row.amount_approx_usd || 0);
  const amountLine = amount >= DEFAULT_MIN_VALUE_USD
    ? `The public record appears to involve roughly USD ${Math.round(amount).toLocaleString('en-US')} in disputed or recoverable value.`
    : 'The public record appears to involve a material disputed or recoverable amount.';
  return [
    greeting,
    '',
    `I found your public report: “${clean(row.source_title, 240)}”.`,
    amountLine,
    '',
    'I run KeschFlow, a structured case-reconstruction workflow for stalled platform and billing disputes. I can first reconstruct the public timeline, identify the strongest evidence gaps and build the escalation path. I do not need your password, API keys or account access.',
    '',
    `Commercial model: no upfront fee. The success fee is ${pricing.feePercent}% of the documented amount recovered, credited or cancelled, with a minimum of EUR ${pricing.feeMinEur.toFixed(2)} and a maximum of EUR ${pricing.feeMaxEur.toFixed(2)}. No fee is due without a documented successful outcome of at least USD ${pricing.minRecoveredUsd.toLocaleString('en-US')} equivalent.`,
    '',
    'If this is still unresolved and you want me to proceed, reply YES. I will then send the short engagement confirmation and evidence checklist.',
    '',
    'If it is resolved or you do not want to be contacted, reply NO and I will close the case. I will not send unsolicited follow-ups if you do not reply.',
    '',
    'KeschFlow'
  ].join('\n');
}

function caseCheckMessage(row, checkoutUrl, amountEur) {
  const name = clean(row.recipient_name, 120);
  return [
    name ? `Hello ${name},` : 'Hello,',
    '',
    `I found your public platform/billing report: “${clean(row.source_title, 240)}”.`,
    '',
    `I can turn the available material into a focused Platform/Billing Case Check for EUR ${amountEur.toFixed(2)}. It includes:`,
    '1. reconstructed timeline and strongest provable facts,',
    '2. missing evidence and weak points,',
    '3. the smallest credible escalation route,',
    '4. a ready-to-send escalation letter.',
    '',
    'No passwords, API keys or account access are required. This is structured case and escalation support, not legal representation, and no outcome is guaranteed.',
    '',
    `Individual Stripe Checkout: ${checkoutUrl}`,
    '',
    'After payment, reply to this email with the invoices, support case IDs, key messages, important dates and desired outcome. Do not send credentials.',
    '',
    'If this is resolved or not relevant, reply NO and I will close the case. No unsolicited follow-up will be sent.',
    '',
    'KeschFlow'
  ].join('\n');
}

function termsMessage(env) {
  const pricing = successFeeConfig(env);
  return [
    'Thanks for replying.',
    '',
    `Engagement terms: no upfront fee. The success fee is ${pricing.feePercent}% of the documented amount recovered, credited or cancelled, with a minimum of EUR ${pricing.feeMinEur.toFixed(2)} and a maximum of EUR ${pricing.feeMaxEur.toFixed(2)}. No success fee is due unless the documented successful outcome reaches at least USD ${pricing.minRecoveredUsd.toLocaleString('en-US')} equivalent.`,
    '',
    'The service is evidence reconstruction and escalation support, not legal representation, and no outcome is guaranteed. You remain in control of any account action, settlement or legal decision.',
    '',
    'If you accept these terms, reply exactly: I AGREE',
    '',
    'After acceptance I will send the evidence checklist. Do not send passwords, API secrets, recovery codes or other credentials.'
  ].join('\n');
}

function evidenceChecklistMessage() {
  return [
    'Engagement confirmed.',
    '',
    'Please reply with the following, as available:',
    '1. Current disputed amount and what has actually left the bank/card.',
    '2. Invoices, credit notes or refund confirmations.',
    '3. Support case IDs and the key support messages.',
    '4. The 5–10 most important dates: first anomaly, containment, support contacts, credits/refunds and current status.',
    '5. Usage/anomaly exports, bank/payment references and screenshots that prove the chronology.',
    '6. Your desired outcome.',
    '',
    'Attachments are fine. Do not send passwords, API keys, recovery codes or live credentials.',
    '',
    'I will keep the case focused on provable facts, platform statements and the smallest credible escalation path.'
  ].join('\n');
}

function successAmountQuestion(env) {
  const pricing = successFeeConfig(env);
  return [
    'That sounds like a successful outcome. Before I close the case, please confirm the total amount that was actually recovered, credited or cancelled.',
    '',
    `Under the accepted terms, the success fee is ${pricing.feePercent}% of the documented successful amount, minimum EUR ${pricing.feeMinEur.toFixed(2)} and maximum EUR ${pricing.feeMaxEur.toFixed(2)}, and is due only when the documented amount reaches at least USD ${pricing.minRecoveredUsd.toLocaleString('en-US')} equivalent.`
  ].join('\n');
}

function paymentMessage(recoveredUsd, pricing, checkoutUrl) {
  const limitLine = pricing.minimumApplied
    ? `The minimum fee of EUR ${pricing.feeMinEur.toFixed(2)} applies.`
    : pricing.maximumApplied
      ? `The maximum fee of EUR ${pricing.feeMaxEur.toFixed(2)} applies.`
      : 'Neither the minimum nor maximum fee limit applies.';
  return [
    'Great result — thank you for confirming the outcome.',
    '',
    `Confirmed recovered/credited/cancelled value: USD ${recoveredUsd.toFixed(2)}.`,
    `Conversion used: USD→EUR ${pricing.eurUsdRate.toFixed(4)}; converted value: EUR ${pricing.recoveredEur.toFixed(2)}.`,
    `${pricing.feePercent}% calculation before limits: EUR ${pricing.uncappedFeeAmountEur.toFixed(2)}. ${limitLine}`,
    `Final success fee: EUR ${pricing.feeAmountEur.toFixed(2)}.`,
    '',
    `Individual Stripe Checkout: ${checkoutUrl}`,
    '',
    'Once payment is received, the case is closed and the outcome remains recorded in the KeschFlow case history.'
  ].join('\n');
}

async function persistPaymentSetupFailure(env, record, recovered, pricing, successEventKey, errorCode, at) {
  return env.CASE_DB.prepare(`
    UPDATE revenue_autopilot
       SET stage = 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED', success_confirmed_at = COALESCE(success_confirmed_at, ?2),
           recovered_approx_usd = ?3, success_fee_percent = ?4, success_fee_min_eur = ?5,
           success_fee_max_eur = ?6, success_min_recovered_usd = ?7,
           usd_to_eur_rate = ?8, success_fee_eur_usd_rate = ?8,
           calculated_fee_eur = ?9, calculated_fee_minor = ?10, success_fee_amount_cents = ?10,
           success_fee_currency = 'EUR', pricing_version = ?11, success_event_key = ?12,
           error_code = ?13, updated_at = ?2
     WHERE public_case_id = ?1 AND stripe_checkout_session_id IS NULL
       AND (success_event_key IS NULL OR success_event_key = ?12)
       AND stage <> 'PAID'
  `).bind(
    record.public_case_id, at, recovered, pricing.feePercent, pricing.feeMinEur,
    pricing.feeMaxEur, pricing.minRecoveredUsd, pricing.eurUsdRate, pricing.feeAmountEur,
    pricing.feeAmountCents, pricing.pricingVersion, successEventKey, errorCode
  ).run();
}

function pricingFromStoredRecord(stored) {
  const recoveredUsd = Number(stored?.recovered_approx_usd);
  const config = {
    feePercent: Number(stored?.success_fee_percent),
    feeMinEur: Number(stored?.success_fee_min_eur),
    feeMaxEur: Number(stored?.success_fee_max_eur),
    minRecoveredUsd: Number(stored?.success_min_recovered_usd || 8000),
    usdToEurRate: Number(stored?.usd_to_eur_rate ?? stored?.success_fee_eur_usd_rate)
  };
  return { recoveredUsd, config, pricing: calculateSuccessFee(recoveredUsd, config.usdToEurRate, config) };
}

async function ensureDynamicCheckout(env, record, recovered, at = nowIso()) {
  let stored = await env.CASE_DB.prepare(`
    SELECT recovered_approx_usd, success_fee_percent, success_fee_min_eur,
           success_fee_max_eur, success_min_recovered_usd, usd_to_eur_rate, success_fee_eur_usd_rate,
           calculated_fee_minor, success_fee_amount_cents, success_fee_currency,
           pricing_version, success_event_key, stripe_checkout_session_id,
           stripe_checkout_url, checkout_creation_attempted_at, checkout_expires_at
      FROM revenue_autopilot WHERE public_case_id = ?1
  `).bind(record.public_case_id).first();

  let config;
  let pricing;
  let lockedRecovered = Number(recovered);
  let successEventKey;
  if (stored?.success_event_key) {
    const snapshot = pricingFromStoredRecord(stored);
    lockedRecovered = snapshot.recoveredUsd;
    config = snapshot.config;
    pricing = snapshot.pricing;
    successEventKey = String(stored.success_event_key);
    if (Number(recovered).toFixed(2) !== lockedRecovered.toFixed(2)) {
      return { ok: false, error: 'SUCCESS_FEE_ALREADY_LOCKED', pricing };
    }
  } else {
    config = successFeeConfig(env);
    pricing = calculateSuccessFee(lockedRecovered, config.usdToEurRate, config);
    successEventKey = stripeIdempotencyKey(record.public_case_id, lockedRecovered);
    const claim = await persistPaymentSetupFailure(
      env, record, lockedRecovered, pricing, successEventKey, 'STRIPE_CHECKOUT_PENDING', at
    );
    if (Number(claim.meta?.changes || 0) !== 1) {
      return { ok: false, error: 'SUCCESS_FEE_STATE_CONFLICT', pricing };
    }
    stored = { ...stored, success_event_key: successEventKey };
  }

  let checkout = stored?.stripe_checkout_session_id && stored?.stripe_checkout_url ? {
    id: stored.stripe_checkout_session_id,
    url: stored.stripe_checkout_url,
    expiresAt: stored.checkout_expires_at,
    pricing
  } : null;

  if (checkout) return { ok: true, checkout, pricing };

  if (!stripeCheckoutConfigured(env)) {
    const errorCode = !env.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY_NOT_CONFIGURED' : 'STRIPE_CHECKOUT_URLS_NOT_CONFIGURED';
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stage = 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED', error_code = ?2, updated_at = ?3
       WHERE public_case_id = ?1 AND success_event_key = ?4 AND stripe_checkout_session_id IS NULL
    `).bind(record.public_case_id, errorCode, at, successEventKey).run();
    return { ok: false, error: errorCode, pricing };
  }

  if (stored?.checkout_creation_attempted_at) {
    return { ok: false, error: 'STRIPE_CHECKOUT_RECONCILIATION_REQUIRED', pricing };
  }

  const attemptAt = nowIso();
  const attempt = await env.CASE_DB.prepare(`
    UPDATE revenue_autopilot
       SET checkout_creation_attempted_at = ?2, updated_at = ?2
     WHERE public_case_id = ?1 AND success_event_key = ?3
       AND stripe_checkout_session_id IS NULL AND checkout_creation_attempted_at IS NULL
  `).bind(record.public_case_id, attemptAt, successEventKey).run();
  if (Number(attempt.meta?.changes || 0) !== 1) {
    return { ok: false, error: 'STRIPE_CHECKOUT_RECONCILIATION_REQUIRED', pricing };
  }

  try {
    checkout = await createSuccessFeeCheckoutSession(env, {
      publicCaseId: record.public_case_id,
      recoveredAmountUsd: lockedRecovered,
      customerEmail: record.recipient_email
    }, config);
      const checkoutAt = nowIso();
      const saved = await env.CASE_DB.prepare(`
        UPDATE revenue_autopilot
           SET stripe_checkout_session_id = ?2, stripe_checkout_url = ?3,
               checkout_created_at = ?4, stripe_checkout_created_at = ?4,
               checkout_expires_at = ?5,
               error_code = NULL, updated_at = ?4
         WHERE public_case_id = ?1 AND stripe_checkout_session_id IS NULL AND success_event_key = ?6
      `).bind(
        record.public_case_id, checkout.id, checkout.url, checkoutAt,
        checkout.expiresAt, successEventKey
      ).run();
      if (Number(saved.meta?.changes || 0) !== 1) {
        const winner = await env.CASE_DB.prepare(`
          SELECT stripe_checkout_session_id, stripe_checkout_url, checkout_expires_at
            FROM revenue_autopilot WHERE public_case_id = ?1
        `).bind(record.public_case_id).first();
        if (!winner?.stripe_checkout_session_id || !winner?.stripe_checkout_url) {
          throw new Error('STRIPE_CHECKOUT_STATE_CONFLICT');
        }
        checkout = {
          ...checkout,
          id: winner.stripe_checkout_session_id,
          url: winner.stripe_checkout_url,
          expiresAt: winner.checkout_expires_at
        };
      }
  } catch (error) {
    const errorCode = clean(error.message || 'STRIPE_CHECKOUT_CREATE_FAILED', 120);
    if (/^STRIPE_CHECKOUT_CREATE_4\d\d$/.test(errorCode)) {
      await env.CASE_DB.prepare(`
        UPDATE revenue_autopilot SET checkout_creation_attempted_at = NULL, updated_at = ?2
         WHERE public_case_id = ?1 AND success_event_key = ?3 AND stripe_checkout_session_id IS NULL
      `).bind(record.public_case_id, nowIso(), successEventKey).run();
    }
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stage = 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED', error_code = ?2, updated_at = ?3
       WHERE public_case_id = ?1 AND success_event_key = ?4 AND stripe_checkout_session_id IS NULL
    `).bind(record.public_case_id, errorCode, nowIso(), successEventKey).run();
    return { ok: false, error: errorCode, pricing };
  }

  return { ok: true, checkout, pricing };
}

async function requestDynamicPayment(env, record, message, recovered, at = nowIso()) {
  const prepared = await ensureDynamicCheckout(env, record, recovered, at);
  if (!prepared.ok) {
    return {
      ok: prepared.error === 'STRIPE_SECRET_KEY_NOT_CONFIGURED' || prepared.error === 'STRIPE_CHECKOUT_URLS_NOT_CONFIGURED',
      action: 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED',
      caseId: record.public_case_id,
      recoveredApproxUsd: recovered,
      error: prepared.error
    };
  }
  const { checkout, pricing } = prepared;

  let sent;
  try {
    sent = await sendThreadReply(env, record, message, paymentMessage(recovered, pricing, checkout.url));
  } catch (error) {
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stage = 'PAYMENT_MESSAGE_SEND_UNKNOWN', error_code = ?2, updated_at = ?3
       WHERE public_case_id = ?1
    `).bind(record.public_case_id, clean(error.message || 'GMAIL_SEND_FAILED', 120), nowIso()).run();
    return { ok: false, action: 'PAYMENT_MESSAGE_SEND_UNKNOWN', caseId: record.public_case_id };
  }

  const requestedAt = nowIso();
  const paymentState = await env.CASE_DB.prepare(`
    UPDATE revenue_autopilot
       SET stage = 'PAYMENT_PENDING', payment_requested_at = ?2,
           payment_status = 'REQUESTED', error_code = NULL, updated_at = ?2
     WHERE public_case_id = ?1 AND stripe_checkout_session_id = ?3
  `).bind(record.public_case_id, requestedAt, checkout.id).run();
  if (Number(paymentState.meta?.changes || 0) !== 1) {
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stage = 'PAYMENT_MESSAGE_SEND_UNKNOWN', error_code = 'PAYMENT_STATE_CONFLICT', updated_at = ?2
       WHERE public_case_id = ?1
    `).bind(record.public_case_id, nowIso()).run();
    return { ok: false, action: 'PAYMENT_MESSAGE_SEND_UNKNOWN', caseId: record.public_case_id };
  }
  return {
    ok: true,
    action: 'PAYMENT_REQUESTED',
    caseId: record.public_case_id,
    recoveredApproxUsd: recovered,
    feeAmountCents: pricing.feeAmountCents,
    messageId: sent.id
  };
}

export async function ensureRevenueAutopilotSchema(env) {
  await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS revenue_autopilot (
        public_case_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        economic_score INTEGER NOT NULL DEFAULT 0,
        amount_approx_usd REAL NOT NULL DEFAULT 0,
        recipient_email TEXT NOT NULL,
        recipient_name TEXT,
        subject TEXT,
        initial_message_id TEXT,
        gmail_thread_id TEXT,
        initial_sent_at TEXT,
        last_inbound_message_id TEXT,
        last_inbound_at TEXT,
        last_reply_class TEXT,
        terms_sent_at TEXT,
        engagement_accepted_at TEXT,
        evidence_received_at TEXT,
        success_confirmed_at TEXT,
        recovered_approx_usd REAL NOT NULL DEFAULT 0,
        payment_requested_at TEXT,
        payment_status TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (public_case_id) REFERENCES cases(public_case_id)
      )
    `),
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS revenue_autopilot_quota (
        quota_day TEXT PRIMARY KEY,
        sent_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `),
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS revenue_autopilot_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        lock_token TEXT,
        locked_until TEXT,
        updated_at TEXT NOT NULL
      )
    `),
    env.CASE_DB.prepare(`
      INSERT OR IGNORE INTO revenue_autopilot_lock (id, lock_token, locked_until, updated_at)
      VALUES (1, NULL, NULL, CURRENT_TIMESTAMP)
    `),
    env.CASE_DB.prepare('CREATE INDEX IF NOT EXISTS idx_revenue_autopilot_stage ON revenue_autopilot(stage, updated_at)')
  ]);
}

async function acquireLock(env) {
  const token = crypto.randomUUID();
  const now = nowIso();
  const until = new Date(Date.now() + LOCK_SECONDS * 1000).toISOString();
  const result = await env.CASE_DB.prepare(`
    UPDATE revenue_autopilot_lock
       SET lock_token = ?1, locked_until = ?2, updated_at = ?3
     WHERE id = 1
       AND (locked_until IS NULL OR locked_until < ?3)
  `).bind(token, until, now).run();
  return Number(result.meta?.changes || 0) === 1 ? token : null;
}

async function releaseLock(env, token) {
  await env.CASE_DB.prepare(`
    UPDATE revenue_autopilot_lock SET lock_token = NULL, locked_until = NULL, updated_at = ?2
    WHERE id = 1 AND lock_token = ?1
  `).bind(token, nowIso()).run();
}

async function openAutopilotCase(env) {
  const row = await env.CASE_DB.prepare(`
    SELECT * FROM revenue_autopilot
    ORDER BY updated_at DESC
    LIMIT 20
  `).all();
  return (row.results || []).find((item) => OPEN_STAGES.has(String(item.stage))) || null;
}

async function currentWinner(env) {
  const minScore = numericEnv(env, 'AUTOPILOT_MIN_ECONOMIC_SCORE', DEFAULT_MIN_SCORE);
  const minValue = numericEnv(env, 'AUTOPILOT_MIN_VALUE_USD', DEFAULT_MIN_VALUE_USD);
  const rows = await env.CASE_DB.prepare(`
    SELECT c.public_case_id, c.status, c.is_active,
           e.economic_score, e.amount_approx_usd, e.economically_qualified,
           e.solvability_score, e.reachability_score, e.evidence_score,
           e.effort_score, e.uncertainty_score,
           d.recipient_email, d.recipient_name, d.subject,
           r.source_title, r.contact_route
      FROM cases c
      JOIN case_economic_scores e ON e.public_case_id = c.public_case_id
      JOIN dispatch_targets d ON d.public_case_id = c.public_case_id
      JOIN radar_candidates r ON r.public_case_id = c.public_case_id
     WHERE c.is_active = 1
       AND c.status = 'PENDING_APPROVAL'
       AND e.economically_qualified = 1
       AND e.economic_score >= ?1
       AND e.amount_approx_usd >= ?2
       AND e.solvability_score >= 65
       AND e.reachability_score >= 65
       AND e.evidence_score >= 55
       AND e.effort_score <= 70
       AND e.uncertainty_score <= 55
       AND e.selected_at IS NOT NULL
     ORDER BY e.economic_score DESC, e.solvability_score DESC,
              e.reachability_score DESC, e.amount_approx_usd DESC, e.selected_at DESC
     LIMIT 20
  `).bind(minScore, minValue).all();

  return (rows.results || []).find(autoContactAllowed) || null;
}

async function currentCaseCheckCandidate(env) {
  if (!caseCheckEnabled(env)) return null;
  const minScore = numericEnv(env, 'CASE_CHECK_MIN_ECONOMIC_SCORE', 58);
  const minValue = numericEnv(env, 'CASE_CHECK_MIN_VALUE_USD', 500);
  const rows = await env.CASE_DB.prepare(`
    SELECT c.public_case_id, c.status, c.is_active,
           e.economic_score, e.amount_approx_usd, e.solvability_score,
           e.reachability_score, e.evidence_score, e.effort_score, e.uncertainty_score,
           d.recipient_email, d.recipient_name, d.subject,
           r.source_title, r.contact_route
      FROM cases c
      JOIN case_economic_scores e ON e.public_case_id = c.public_case_id
      JOIN dispatch_targets d ON d.public_case_id = c.public_case_id
      JOIN radar_candidates r ON r.public_case_id = c.public_case_id
     WHERE c.is_active = 1 AND c.status = 'PENDING_APPROVAL'
       AND e.economic_score >= ?1 AND e.amount_approx_usd >= ?2
       AND e.solvability_score >= 50 AND e.reachability_score >= 60
       AND e.evidence_score >= 45 AND e.effort_score <= 75 AND e.uncertainty_score <= 60
       AND NOT EXISTS (
         SELECT 1 FROM revenue_autopilot a WHERE a.public_case_id = c.public_case_id
       )
     ORDER BY e.economic_score DESC, e.reachability_score DESC,
              e.evidence_score DESC, e.amount_approx_usd DESC
     LIMIT 20
  `).bind(minScore, minValue).all();
  return (rows.results || []).find(autoContactAllowed) || null;
}

function autoContactAllowed(row) {
  const email = String(row?.recipient_email || '').trim();
  if (!email) return false;
  if (ROLE_EMAIL.test(email)) return true;
  return ['PUBLIC_WEBSITE_BUSINESS_EMAIL', 'PUBLIC_WEBSITE_MAILTO', 'GITHUB_PUBLIC_EMAIL', 'GITLAB_PUBLIC_EMAIL', 'PUBLIC_POST_EMAIL']
    .includes(String(row?.contact_route || ''));
}

async function claimDailyQuota(env) {
  const max = Math.max(1, Math.floor(numericEnv(env, 'AUTOPILOT_MAX_NEW_OUTREACH_PER_DAY', 1)));
  const day = nowIso().slice(0, 10);
  await env.CASE_DB.prepare(`
    INSERT OR IGNORE INTO revenue_autopilot_quota (quota_day, sent_count, updated_at)
    VALUES (?1, 0, ?2)
  `).bind(day, nowIso()).run();
  const result = await env.CASE_DB.prepare(`
    UPDATE revenue_autopilot_quota
       SET sent_count = sent_count + 1, updated_at = ?3
     WHERE quota_day = ?1 AND sent_count < ?2
  `).bind(day, max, nowIso()).run();
  return Number(result.meta?.changes || 0) === 1;
}

async function sendInitialOutreach(env, row) {
  if (!gmailConfigured(env)) return { ok: false, reason: 'GMAIL_NOT_CONFIGURED' };
  if (!autoContactAllowed(row)) return { ok: false, reason: 'AUTO_CONTACT_NOT_VERIFIED_PUBLIC' };
  if (!(await claimDailyQuota(env))) return { ok: false, reason: 'DAILY_OUTREACH_CAP_REACHED' };

  const subject = clean(row.subject || 'Regarding your public platform/billing report', 300);
  const claimedAt = nowIso();
  try {
    await env.CASE_DB.prepare(`
      INSERT INTO revenue_autopilot (
        public_case_id, stage, economic_score, amount_approx_usd,
        recipient_email, recipient_name, subject, updated_at
      ) VALUES (?1, 'CONTACT_CLAIMED', ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(
      row.public_case_id,
      Number(row.economic_score || 0),
      Number(row.amount_approx_usd || 0),
      row.recipient_email,
      row.recipient_name || null,
      subject,
      claimedAt
    ).run();
  } catch {
    return { ok: false, reason: 'ALREADY_CLAIMED' };
  }

  const body = initialMessage(row, env);
  let sent;
  try {
    sent = await sendGmail(env, { to: row.recipient_email, subject, text: body });
  } catch (error) {
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot SET stage = 'SEND_UNKNOWN', error_code = ?2, updated_at = ?3
      WHERE public_case_id = ?1
    `).bind(row.public_case_id, clean(error.message || 'GMAIL_SEND_FAILED', 120), nowIso()).run();
    return { ok: false, reason: 'SEND_UNKNOWN', error: error.message };
  }

  const sentAt = nowIso();
  await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stage = 'OUTREACH_SENT', initial_message_id = ?2, gmail_thread_id = ?3,
             initial_sent_at = ?4, error_code = NULL, updated_at = ?4
       WHERE public_case_id = ?1
    `).bind(row.public_case_id, sent.id, sent.threadId, sentAt),
    env.CASE_DB.prepare(`
      UPDATE cases
         SET outreach_message = ?2, status = 'DISPATCHED', version = version + 1, updated_at = ?3
       WHERE public_case_id = ?1
    `).bind(row.public_case_id, body, sentAt),
    env.CASE_DB.prepare(`
      INSERT OR IGNORE INTO dispatch_log (public_case_id, provider, provider_message_id, recipient_email, status, error_code, created_at)
      VALUES (?1, 'GMAIL_AUTOPILOT', ?2, ?3, 'SENT', NULL, ?4)
    `).bind(row.public_case_id, sent.id, row.recipient_email, sentAt),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES (?1, 'AUTOPILOT_OUTREACH_SENT', 'DISPATCHED', 'REVENUE_AUTOPILOT', ?2)
    `).bind(row.public_case_id, sentAt)
  ]);

  return { ok: true, action: 'OUTREACH_SENT', caseId: row.public_case_id, messageId: sent.id, threadId: sent.threadId };
}

async function sendCaseCheckOffer(env, row) {
  if (!gmailConfigured(env)) return { ok: false, reason: 'GMAIL_NOT_CONFIGURED' };
  if (!stripeCheckoutConfigured(env)) return { ok: false, reason: 'STRIPE_NOT_CONFIGURED' };
  if (!autoContactAllowed(row)) return { ok: false, reason: 'AUTO_CONTACT_NOT_VERIFIED_PUBLIC' };
  if (!(await claimDailyQuota(env))) return { ok: false, reason: 'DAILY_OUTREACH_CAP_REACHED' };

  const subject = clean(row.subject || 'Platform/Billing Case Check for your public report', 300);
  const claimedAt = nowIso();
  try {
    await env.CASE_DB.prepare(`
      INSERT INTO revenue_autopilot (
        public_case_id, stage, economic_score, amount_approx_usd,
        recipient_email, recipient_name, subject, offer_type, updated_at
      ) VALUES (?1, 'CONTACT_CLAIMED', ?2, ?3, ?4, ?5, ?6, 'CASE_CHECK_49', ?7)
    `).bind(row.public_case_id, Number(row.economic_score || 0), Number(row.amount_approx_usd || 0),
      row.recipient_email, row.recipient_name || null, subject, claimedAt).run();
  } catch {
    return { ok: false, reason: 'ALREADY_CLAIMED' };
  }

  let checkout;
  try {
    checkout = await createCaseCheckCheckoutSession(env, {
      publicCaseId: row.public_case_id,
      customerEmail: row.recipient_email
    });
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stripe_checkout_session_id = ?2, stripe_checkout_url = ?3,
             checkout_created_at = ?4, checkout_expires_at = ?5,
             fixed_offer_amount_cents = ?6, success_fee_currency = 'EUR', updated_at = ?4
       WHERE public_case_id = ?1 AND offer_type = 'CASE_CHECK_49'
    `).bind(row.public_case_id, checkout.id, checkout.url, nowIso(), checkout.expiresAt, checkout.amountCents).run();
  } catch (error) {
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot SET stage = 'CLOSED_OTHER', error_code = ?2, updated_at = ?3
       WHERE public_case_id = ?1
    `).bind(row.public_case_id, clean(error.message, 120), nowIso()).run();
    return { ok: false, reason: 'CASE_CHECK_CHECKOUT_FAILED', error: clean(error.message, 120) };
  }

  const body = caseCheckMessage(row, checkout.url, checkout.amountCents / 100);
  let sent;
  try {
    sent = await sendGmail(env, { to: row.recipient_email, subject, text: body });
  } catch (error) {
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot SET stage = 'SEND_UNKNOWN', error_code = ?2, updated_at = ?3
       WHERE public_case_id = ?1
    `).bind(row.public_case_id, clean(error.message || 'GMAIL_SEND_FAILED', 120), nowIso()).run();
    return { ok: false, reason: 'SEND_UNKNOWN' };
  }

  const sentAt = nowIso();
  await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      UPDATE revenue_autopilot
         SET stage = 'CASE_CHECK_PAYMENT_PENDING', initial_message_id = ?2, gmail_thread_id = ?3,
             initial_sent_at = ?4, payment_requested_at = ?4, payment_status = 'REQUESTED', error_code = NULL, updated_at = ?4
       WHERE public_case_id = ?1
    `).bind(row.public_case_id, sent.id, sent.threadId, sentAt),
    env.CASE_DB.prepare(`
      UPDATE cases SET outreach_message = ?2, status = 'DISPATCHED', version = version + 1, updated_at = ?3
       WHERE public_case_id = ?1
    `).bind(row.public_case_id, body, sentAt),
    env.CASE_DB.prepare(`
      INSERT OR IGNORE INTO dispatch_log (public_case_id, provider, provider_message_id, recipient_email, status, error_code, created_at)
      VALUES (?1, 'GMAIL_AUTOPILOT', ?2, ?3, 'SENT', NULL, ?4)
    `).bind(row.public_case_id, sent.id, row.recipient_email, sentAt),
    env.CASE_DB.prepare(`
      INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
      VALUES (?1, 'CASE_CHECK_OFFER_SENT', 'PAYMENT_PENDING', 'REVENUE_AUTOPILOT', ?2)
    `).bind(row.public_case_id, sentAt)
  ]);
  return { ok: true, action: 'CASE_CHECK_OFFER_SENT', caseId: row.public_case_id, amountCents: checkout.amountCents };
}

async function updateInbound(env, record, message, classification) {
  await env.CASE_DB.prepare(`
    UPDATE revenue_autopilot
       SET last_inbound_message_id = ?2, last_inbound_at = ?3, last_reply_class = ?4, updated_at = ?3
     WHERE public_case_id = ?1
  `).bind(record.public_case_id, message.id, new Date(message.internalDate).toISOString(), classification).run();
}

async function sendThreadReply(env, record, message, text) {
  return sendGmailReply(env, {
    to: record.recipient_email,
    subject: message.subject || record.subject || 'Re: your platform/billing case',
    text,
    threadId: record.gmail_thread_id,
    inReplyTo: message.messageIdHeader,
    references: message.references || message.messageIdHeader
  });
}

async function handleInbound(env, record, message) {
  const classification = classifyReply(message.text, message.attachments, record.stage);
  await updateInbound(env, record, message, classification);
  const at = nowIso();

  if (classification === 'NEGATIVE') {
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot SET stage = 'CLOSED_NOT_INTERESTED', updated_at = ?2 WHERE public_case_id = ?1
    `).bind(record.public_case_id, at).run();
    return { ok: true, action: 'CLOSED_NOT_INTERESTED', caseId: record.public_case_id };
  }

  if (record.stage === 'OUTREACH_SENT' && classification === 'POSITIVE') {
    const sent = await sendThreadReply(env, record, message, termsMessage(env));
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot SET stage = 'TERMS_SENT', terms_sent_at = ?2, updated_at = ?2
      WHERE public_case_id = ?1
    `).bind(record.public_case_id, at).run();
    return { ok: true, action: 'TERMS_SENT', caseId: record.public_case_id, messageId: sent.id };
  }

  if (record.stage === 'TERMS_SENT' && classification === 'ACCEPT') {
    const sent = await sendThreadReply(env, record, message, evidenceChecklistMessage());
    await env.CASE_DB.batch([
      env.CASE_DB.prepare(`
        UPDATE revenue_autopilot
           SET stage = 'ENGAGED', engagement_accepted_at = ?2, updated_at = ?2
         WHERE public_case_id = ?1
      `).bind(record.public_case_id, at),
      env.CASE_DB.prepare(`
        INSERT INTO state_events (public_case_id, event_type, state, source, created_at)
        VALUES (?1, 'CUSTOMER_ENGAGED', 'RESPONSE_RECEIVED', 'REVENUE_AUTOPILOT', ?2)
      `).bind(record.public_case_id, at)
    ]);
    return { ok: true, action: 'ENGAGED', caseId: record.public_case_id, messageId: sent.id };
  }

  if ((record.stage === 'ENGAGED' || record.stage === 'EVIDENCE_RECEIVED' || record.stage === 'CASE_CHECK_PAID_AWAITING_EVIDENCE')
    && classification === 'EVIDENCE') {
    if (record.stage !== 'EVIDENCE_RECEIVED') {
      await env.CASE_DB.prepare(`
        UPDATE revenue_autopilot SET stage = 'EVIDENCE_RECEIVED', evidence_received_at = ?2, updated_at = ?2
        WHERE public_case_id = ?1
      `).bind(record.public_case_id, at).run();
    }
    return { ok: true, action: 'EVIDENCE_RECEIVED', caseId: record.public_case_id, attachments: message.attachments.length };
  }

  if ((record.stage === 'ENGAGED' || record.stage === 'EVIDENCE_RECEIVED' || record.stage === 'SUCCESS_CONFIRMATION_PENDING')
    && classification === 'SUCCESS') {
    const recovered = extractApproxUsd(message.text);
    const minValue = successFeeConfig(env).minRecoveredUsd;
    if (recovered < minValue) {
      const sent = await sendThreadReply(env, record, message, successAmountQuestion(env));
      await env.CASE_DB.prepare(`
        UPDATE revenue_autopilot
           SET stage = 'SUCCESS_CONFIRMATION_PENDING', success_confirmed_at = ?2,
               recovered_approx_usd = ?3, updated_at = ?2
         WHERE public_case_id = ?1
      `).bind(record.public_case_id, at, recovered).run();
      return { ok: true, action: 'SUCCESS_AMOUNT_CONFIRMATION_REQUESTED', caseId: record.public_case_id, messageId: sent.id };
    }
    return requestDynamicPayment(env, record, message, recovered, at);
  }

  if (classification === 'AMBIGUOUS') {
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot SET stage = 'RESPONSE_REVIEW', updated_at = ?2 WHERE public_case_id = ?1
    `).bind(record.public_case_id, at).run();
    return { ok: true, action: 'RESPONSE_REVIEW', caseId: record.public_case_id };
  }

  return { ok: true, action: 'REPLY_RECORDED', caseId: record.public_case_id, classification };
}

async function monitorOpenCase(env, record) {
  if (!record.gmail_thread_id || !record.initial_sent_at) return { ok: false, reason: 'THREAD_NOT_READY' };
  let thread;
  try {
    thread = await getGmailThread(env, record.gmail_thread_id);
  } catch (error) {
    const code = clean(error.message || 'GMAIL_THREAD_FAILED', 120);
    await env.CASE_DB.prepare(`
      UPDATE revenue_autopilot SET stage = 'REPLY_MONITOR_BLOCKED', error_code = ?2, updated_at = ?3
      WHERE public_case_id = ?1 AND stage NOT IN ('PAYMENT_PENDING')
    `).bind(record.public_case_id, code, nowIso()).run();
    return { ok: false, reason: code, caseId: record.public_case_id };
  }

  const messages = inboundMessages(thread, record.recipient_email, record.initial_sent_at);
  if (record.stage === 'SUCCESS_CONFIRMED_PAYMENT_SETUP_REQUIRED') {
    const successMessage = messages.find((message) => message.id === record.last_inbound_message_id);
    if (!successMessage || Number(record.recovered_approx_usd || 0) < successFeeConfig(env).minRecoveredUsd) {
      return { ok: false, reason: 'CONFIRMED_SUCCESS_MESSAGE_NOT_AVAILABLE', caseId: record.public_case_id };
    }
    return requestDynamicPayment(env, record, successMessage, Number(record.recovered_approx_usd));
  }
  const next = messages.find((message) => message.id && message.id !== record.last_inbound_message_id
    && message.internalDate > (Date.parse(record.last_inbound_at || '') || 0));
  if (next) return handleInbound(env, record, next);

  if (record.stage === 'OUTREACH_SENT') {
    const ageDays = (Date.now() - Date.parse(record.initial_sent_at || '')) / 86400000;
    if (Number.isFinite(ageDays) && ageDays >= 7) {
      await env.CASE_DB.prepare(`
        UPDATE revenue_autopilot SET stage = 'CLOSED_NO_RESPONSE', updated_at = ?2 WHERE public_case_id = ?1
      `).bind(record.public_case_id, nowIso()).run();
      return { ok: true, action: 'CLOSED_NO_RESPONSE', caseId: record.public_case_id };
    }
  }

  if (record.stage === 'CASE_CHECK_PAYMENT_PENDING') {
    const expiresAt = Date.parse(record.checkout_expires_at || '');
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      await env.CASE_DB.prepare(`
        UPDATE revenue_autopilot SET stage = 'CLOSED_NO_RESPONSE', updated_at = ?2
         WHERE public_case_id = ?1 AND stage = 'CASE_CHECK_PAYMENT_PENDING'
      `).bind(record.public_case_id, nowIso()).run();
      return { ok: true, action: 'CASE_CHECK_EXPIRED', caseId: record.public_case_id };
    }
  }

  return { ok: true, action: 'WAITING_FOR_REPLY', caseId: record.public_case_id, stage: record.stage };
}

export async function revenueAutopilotStatus(env) {
  await ensureRevenueAutopilotSchema(env);
  const current = await openAutopilotCase(env);
  const latest = current || await env.CASE_DB.prepare(`
    SELECT * FROM revenue_autopilot ORDER BY updated_at DESC LIMIT 1
  `).first();
  const pricing = successFeeConfig(env);
  return latest ? {
    enabled: enabled(env),
    stage: latest.stage,
    pricingModel: 'DYNAMIC_SUCCESS_FEE',
    feePercent: pricing.feePercent,
    feeMinEur: pricing.feeMinEur,
    feeMaxEur: pricing.feeMaxEur,
    stripeCheckoutReady: stripeCheckoutConfigured(env),
    caseCheckEnabled: caseCheckEnabled(env),
    caseCheckPriceEur: numericEnv(env, 'CASE_CHECK_PRICE_EUR', 49),
    paymentStatus: latest.payment_status || null
  } : {
    enabled: enabled(env),
    stage: 'IDLE',
    pricingModel: 'DYNAMIC_SUCCESS_FEE',
    feePercent: pricing.feePercent,
    feeMinEur: pricing.feeMinEur,
    feeMaxEur: pricing.feeMaxEur,
    stripeCheckoutReady: stripeCheckoutConfigured(env),
    caseCheckEnabled: caseCheckEnabled(env),
    caseCheckPriceEur: numericEnv(env, 'CASE_CHECK_PRICE_EUR', 49),
    paymentStatus: null
  };
}

export async function runRevenueAutopilot(env) {
  await ensureRevenueAutopilotSchema(env);
  if (!enabled(env)) return { ok: true, enabled: false, action: 'DISABLED' };

  const token = await acquireLock(env);
  if (!token) return { ok: true, enabled: true, action: 'BUSY' };
  try {
    const open = await openAutopilotCase(env);
    if (open) return await monitorOpenCase(env, open);

    const winner = await currentWinner(env);
    if (winner) return await sendInitialOutreach(env, winner);
    const caseCheckCandidate = await currentCaseCheckCandidate(env);
    if (caseCheckCandidate) return await sendCaseCheckOffer(env, caseCheckCandidate);
    return { ok: true, enabled: true, action: 'NO_WINNER' };
  } finally {
    await releaseLock(env, token).catch(() => {});
  }
}

export const REVENUE_AUTOPILOT_INTERNALS = Object.freeze({
  OPEN_STAGES,
  CLOSED_STAGES,
  classifyReply,
  ensureDynamicCheckout,
  extractApproxUsd,
  paymentMessage,
  requestDynamicPayment
  ,caseCheckMessage,
  currentCaseCheckCandidate
});
