import { gmailConfigured } from './gmail.js';
import { stripeCheckoutConfigured } from './stripe.js';

const ALLOWED_CONTACT_ROUTES = new Set([
  'PUBLIC_WEBSITE_BUSINESS_EMAIL',
  'PUBLIC_WEBSITE_MAILTO',
  'PUBLIC_APP_SUPPORT_EMAIL',
  'VERIFIED_PUBLIC_EMAIL',
  'GITHUB_PUBLIC_EMAIL',
  'GITLAB_PUBLIC_EMAIL',
  'PUBLIC_POST_EMAIL'
]);

const ROLE_EMAIL = /^(business|info|support|service|contact|hello|office|billing|accounts|admin|sales|founder|ceo|owner|team)@/i;
const HARD_EXCLUSION = /\b(do not contact|don't contact|not interested|already resolved|resolved already|fully refunded|refund received and (?:the )?case (?:is )?closed)\b/i;
const OPT_OUT = /\b(reply\s+(?:NO|STOP)|unsubscribe|do not contact|don't contact|opt[ -]?out)\b/i;

const nowIso = () => new Date().toISOString();
const clean = (value, max = 4000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const validEmail = (value) => {
  const email = String(value || '').trim();
  return email.length > 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

function numberEnv(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function addMissingColumn(env, table, column, definition) {
  const info = await env.CASE_DB.prepare(`PRAGMA table_info(${table})`).all();
  const names = new Set((info.results || []).map((row) => String(row.name || '')));
  if (!names.has(column)) {
    await env.CASE_DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

export async function ensureAutonomyControlSchema(env) {
  if (!env.CASE_DB) throw new Error('D1_NOT_CONFIGURED');
  await env.CASE_DB.batch([
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS autonomy_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        outreach_enabled INTEGER NOT NULL DEFAULT 1 CHECK (outreach_enabled IN (0, 1)),
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.CASE_DB.prepare(`
      INSERT OR IGNORE INTO autonomy_control (id, outreach_enabled, updated_by, updated_at)
      VALUES (1, 1, 'SYSTEM_BOOTSTRAP', CURRENT_TIMESTAMP)
    `),
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS outreach_suppression (
        email_normalized TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        public_case_id TEXT,
        created_at TEXT NOT NULL
      )
    `),
    env.CASE_DB.prepare(`
      CREATE TABLE IF NOT EXISTS autonomy_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_case_id TEXT,
        event_type TEXT NOT NULL,
        decision TEXT,
        message_hash TEXT,
        recipient_hash TEXT,
        provider_message_id TEXT,
        context_json TEXT,
        created_at TEXT NOT NULL
      )
    `),
    env.CASE_DB.prepare(`
      CREATE TRIGGER IF NOT EXISTS trg_autonomy_audit_no_update
      BEFORE UPDATE ON autonomy_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'AUTONOMY_AUDIT_IMMUTABLE');
      END
    `),
    env.CASE_DB.prepare(`
      CREATE TRIGGER IF NOT EXISTS trg_autonomy_audit_no_delete
      BEFORE DELETE ON autonomy_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'AUTONOMY_AUDIT_IMMUTABLE');
      END
    `)
  ]);

  await addMissingColumn(env, 'revenue_autopilot', 'outbound_contact_count', 'INTEGER NOT NULL DEFAULT 0');
  await addMissingColumn(env, 'revenue_autopilot', 'follow_up_sent_at', 'TEXT');
  await addMissingColumn(env, 'revenue_autopilot', 'next_follow_up_at', 'TEXT');
  await addMissingColumn(env, 'revenue_autopilot', 'owner_attention_reason', 'TEXT');
  await addMissingColumn(env, 'revenue_autopilot', 'auto_decision', 'TEXT');
  await addMissingColumn(env, 'revenue_autopilot', 'checkout_public_token', 'TEXT');
  await addMissingColumn(env, 'revenue_autopilot', 'checkout_view_count', 'INTEGER NOT NULL DEFAULT 0');
  await addMissingColumn(env, 'revenue_autopilot', 'checkout_first_view_at', 'TEXT');
  await addMissingColumn(env, 'revenue_autopilot', 'checkout_last_view_at', 'TEXT');

  await env.CASE_DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_checkout_public_token
    ON revenue_autopilot(checkout_public_token)
    WHERE checkout_public_token IS NOT NULL
  `).run();
}

export async function appendAutonomyAudit(env, {
  caseId = null,
  eventType,
  decision = null,
  message = null,
  recipientEmail = null,
  providerMessageId = null,
  context = null
}) {
  await ensureAutonomyControlSchema(env);
  const messageHash = message ? await sha256Hex(message) : null;
  const recipientHash = recipientEmail ? await sha256Hex(String(recipientEmail).trim().toLowerCase()) : null;
  const contextJson = context ? JSON.stringify(context).slice(0, 8000) : null;
  await env.CASE_DB.prepare(`
    INSERT INTO autonomy_audit_log (
      public_case_id, event_type, decision, message_hash, recipient_hash,
      provider_message_id, context_json, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).bind(
    caseId, clean(eventType, 120), decision ? clean(decision, 120) : null,
    messageHash, recipientHash, providerMessageId ? clean(providerMessageId, 300) : null,
    contextJson, nowIso()
  ).run();
}

export async function autonomyControlStatus(env) {
  await ensureAutonomyControlSchema(env);
  const row = await env.CASE_DB.prepare(`
    SELECT outreach_enabled, updated_by, updated_at FROM autonomy_control WHERE id = 1
  `).first();
  return {
    outreachEnabled: Number(row?.outreach_enabled ?? 1) === 1,
    updatedBy: row?.updated_by || null,
    updatedAt: row?.updated_at || null
  };
}

export async function setOutreachEnabled(env, enabled, actor = 'OWNER_PASSKEY') {
  await ensureAutonomyControlSchema(env);
  const at = nowIso();
  await env.CASE_DB.prepare(`
    UPDATE autonomy_control SET outreach_enabled = ?1, updated_by = ?2, updated_at = ?3 WHERE id = 1
  `).bind(enabled ? 1 : 0, clean(actor, 120), at).run();
  await appendAutonomyAudit(env, {
    eventType: enabled ? 'GLOBAL_OUTREACH_ENABLED' : 'GLOBAL_OUTREACH_KILLED',
    decision: enabled ? 'ENABLED' : 'KILLED',
    context: { actor: clean(actor, 120) }
  });
  return { outreachEnabled: Boolean(enabled), updatedAt: at };
}

export async function suppressRecipient(env, email, reason, caseId = null, source = 'REVENUE_AUTOPILOT') {
  const normalized = String(email || '').trim().toLowerCase();
  if (!validEmail(normalized)) return false;
  await ensureAutonomyControlSchema(env);
  await env.CASE_DB.prepare(`
    INSERT OR IGNORE INTO outreach_suppression (
      email_normalized, reason, source, public_case_id, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(normalized, clean(reason, 120), clean(source, 120), caseId, nowIso()).run();
  await appendAutonomyAudit(env, {
    caseId,
    eventType: 'RECIPIENT_SUPPRESSED',
    decision: clean(reason, 120),
    recipientEmail: normalized
  });
  return true;
}

export async function isRecipientSuppressed(env, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!validEmail(normalized)) return true;
  await ensureAutonomyControlSchema(env);
  const row = await env.CASE_DB.prepare(`
    SELECT 1 AS suppressed FROM outreach_suppression WHERE email_normalized = ?1 LIMIT 1
  `).bind(normalized).first();
  return Boolean(row);
}

export function hardAutoApproveRules(row, env = {}) {
  const reasons = [];
  const minScore = numberEnv(env, 'AUTOPILOT_MIN_ECONOMIC_SCORE', 72);
  const minValue = numberEnv(env, 'AUTOPILOT_MIN_VALUE_USD', 8000);
  const email = String(row?.recipient_email || '').trim();
  const sender = String(env.GMAIL_FROM || '').trim();
  const route = String(row?.contact_route || '');
  const titleAndExcerpt = `${row?.source_title || ''}\n${row?.source_excerpt || ''}`;

  if (String(env.REVENUE_AUTOPILOT_ENABLED || '').toLowerCase() !== 'true') reasons.push('AUTOPILOT_DISABLED');
  if (Number(row?.economically_qualified || 0) !== 1) reasons.push('ECONOMICALLY_NOT_QUALIFIED');
  if (Number(row?.economic_score || 0) < minScore) reasons.push('ECONOMIC_SCORE_BELOW_MINIMUM');
  if (Number(row?.amount_approx_usd || 0) < minValue) reasons.push('ECONOMIC_VALUE_BELOW_MINIMUM');
  if (Number(row?.solvability_score || 0) < 65) reasons.push('SOLVABILITY_BELOW_MINIMUM');
  if (Number(row?.reachability_score || 0) < 65) reasons.push('REACHABILITY_BELOW_MINIMUM');
  if (Number(row?.evidence_score || 0) < 55) reasons.push('EVIDENCE_BELOW_MINIMUM');
  if (Number(row?.effort_score ?? 100) > 70) reasons.push('EFFORT_TOO_HIGH');
  if (Number(row?.uncertainty_score ?? 100) > 55) reasons.push('UNCERTAINTY_TOO_HIGH');
  if (!row?.selected_at) reasons.push('NOT_ECONOMIC_WINNER');
  if (!validEmail(email)) reasons.push('RECIPIENT_INVALID');
  if (!validEmail(sender)) reasons.push('SENDER_INVALID');
  if (email && sender && email.toLowerCase() === sender.toLowerCase()) reasons.push('SENDER_EQUALS_RECIPIENT');
  if (!ROLE_EMAIL.test(email) && !ALLOWED_CONTACT_ROUTES.has(route)) reasons.push('CONTACT_ROUTE_NOT_VERIFIED_PUBLIC');
  if (HARD_EXCLUSION.test(titleAndExcerpt)) reasons.push('EXCLUSION_SIGNAL');
  if (!gmailConfigured(env)) reasons.push('GMAIL_NOT_CONFIGURED');
  if (!stripeCheckoutConfigured(env)) reasons.push('STRIPE_NOT_CONFIGURED');
  if (!/^https:\/\//i.test(String(env.PUBLIC_WORKER_URL || ''))) reasons.push('PUBLIC_WORKER_URL_NOT_CONFIGURED');

  return {
    approved: reasons.length === 0,
    reasons,
    thresholds: {
      minEconomicScore: minScore,
      minValueUsd: minValue,
      minSolvability: 65,
      minReachability: 65,
      minEvidence: 55,
      maxEffort: 70,
      maxUncertainty: 55
    }
  };
}

export async function safeOutreachPreflight(env, row, {
  message,
  checkoutUrl,
  requireReplyMonitoring = true,
  replyMonitoringAvailable = false
} = {}) {
  await ensureAutonomyControlSchema(env);
  const decision = hardAutoApproveRules(row, env);
  const reasons = [...decision.reasons];
  const control = await autonomyControlStatus(env);
  const recipient = String(row?.recipient_email || '').trim();

  if (!control.outreachEnabled) reasons.push('GLOBAL_KILL_SWITCH');
  if (await isRecipientSuppressed(env, recipient)) reasons.push('RECIPIENT_SUPPRESSED');
  if (!message || !OPT_OUT.test(String(message))) reasons.push('OPT_OUT_MISSING');
  if (requireReplyMonitoring && !replyMonitoringAvailable) reasons.push('REPLY_MONITOR_UNAVAILABLE');

  if (checkoutUrl) {
    try {
      const url = new URL(String(checkoutUrl));
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') reasons.push('CHECKOUT_URL_INVALID');
    } catch {
      reasons.push('CHECKOUT_URL_INVALID');
    }
  } else {
    reasons.push('CHECKOUT_URL_MISSING');
  }

  const duplicate = await env.CASE_DB.prepare(`
    SELECT 1 AS duplicate
      FROM dispatch_log
     WHERE public_case_id = ?1
       AND recipient_email = ?2
       AND status = 'SENT'
     LIMIT 1
  `).bind(row.public_case_id, recipient).first();
  if (duplicate) reasons.push('ALREADY_SENT');

  return {
    approved: reasons.length === 0,
    reasons: [...new Set(reasons)],
    control,
    rules: decision.thresholds
  };
}

export async function classifyPendingCase(env, row) {
  await ensureAutonomyControlSchema(env);
  const reasons = [];
  const email = String(row?.recipient_email || '').trim();
  const text = `${row?.source_title || ''}\n${row?.source_excerpt || ''}`;

  if (!validEmail(email)) reasons.push('MISSING_OR_INVALID_CONTACT');
  if (Number(row?.evidence_score || 0) < 45) reasons.push('WEAK_EVIDENCE');
  if (Number(row?.amount_approx_usd || 0) <= 0) reasons.push('UNCLEAR_ECONOMIC_VALUE');
  if (HARD_EXCLUSION.test(text)) reasons.push('EXCLUSION_SIGNAL');

  const duplicate = await env.CASE_DB.prepare(`
    SELECT 1 AS duplicate
      FROM radar_candidates r2
     WHERE r2.public_case_id <> ?1
       AND (
         r2.source_url = ?2
         OR (
           lower(COALESCE(r2.contact_email, '')) = lower(?3)
           AND lower(trim(COALESCE(r2.source_title, ''))) = lower(trim(?4))
         )
       )
     LIMIT 1
  `).bind(row.public_case_id, row.source_url || '', email, row.source_title || '').first();
  if (duplicate) reasons.push('DUPLICATE');

  return { reject: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export async function enforcePendingCaseSafety(env) {
  await ensureAutonomyControlSchema(env);
  const rows = await env.CASE_DB.prepare(`
    SELECT c.public_case_id, c.status,
           r.source_url, r.source_title, r.source_excerpt, r.contact_email, r.evidence_score,
           e.amount_approx_usd
      FROM cases c
      JOIN radar_candidates r ON r.public_case_id = c.public_case_id
      LEFT JOIN case_economic_scores e ON e.public_case_id = c.public_case_id
     WHERE c.status = 'PENDING_APPROVAL'
  `).all();

  const rejected = [];
  for (const row of rows.results || []) {
    const classification = await classifyPendingCase(env, row);
    if (!classification.reject) continue;
    const at = nowIso();
    await env.CASE_DB.batch([
      env.CASE_DB.prepare(`
        UPDATE cases
           SET status = 'REJECTED', is_active = 0, version = version + 1, updated_at = ?2
         WHERE public_case_id = ?1 AND status = 'PENDING_APPROVAL'
      `).bind(row.public_case_id, at),
      env.CASE_DB.prepare(`
        UPDATE radar_candidates SET status = 'REJECTED' WHERE public_case_id = ?1
      `).bind(row.public_case_id),
      env.CASE_DB.prepare(`
        INSERT INTO state_events (
          public_case_id, event_type, state, source,
          previous_state, actor_ref, request_key, created_at
        ) VALUES (?1, 'AUTONOMY_HARD_REJECT', 'REJECTED', 'AUTONOMY_CONTROL_V1',
                  'PENDING_APPROVAL', 'AUTONOMY_CONTROL_V1', ?2, ?3)
      `).bind(row.public_case_id, classification.reasons.join(','), at)
    ]);
    await appendAutonomyAudit(env, {
      caseId: row.public_case_id,
      eventType: 'AUTO_REJECTED',
      decision: classification.reasons.join(','),
      recipientEmail: row.contact_email,
      context: { reasons: classification.reasons }
    });
    rejected.push({ caseId: row.public_case_id, reasons: classification.reasons });
  }
  return { rejectedCount: rejected.length, rejected };
}

export function publicCheckoutTrackingUrl(env, token) {
  const base = String(env.PUBLIC_WORKER_URL || '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(base) || !token) throw new Error('PUBLIC_CHECKOUT_TRACKING_NOT_CONFIGURED');
  return `${base}/v1/checkout?t=${encodeURIComponent(token)}`;
}

export async function resolveCheckoutRedirect(env, token) {
  await ensureAutonomyControlSchema(env);
  const normalized = String(token || '').trim();
  if (!/^[a-f0-9-]{32,64}$/i.test(normalized)) return null;
  const row = await env.CASE_DB.prepare(`
    SELECT public_case_id, stripe_checkout_url
      FROM revenue_autopilot
     WHERE checkout_public_token = ?1
     LIMIT 1
  `).bind(normalized).first();
  if (!row?.stripe_checkout_url) return null;

  let target;
  try {
    target = new URL(String(row.stripe_checkout_url));
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com') return null;

  const at = nowIso();
  await env.CASE_DB.prepare(`
    UPDATE revenue_autopilot
       SET checkout_view_count = checkout_view_count + 1,
           checkout_first_view_at = COALESCE(checkout_first_view_at, ?2),
           checkout_last_view_at = ?2,
           updated_at = ?2
     WHERE public_case_id = ?1 AND checkout_public_token = ?3
  `).bind(row.public_case_id, at, normalized).run();
  await appendAutonomyAudit(env, {
    caseId: row.public_case_id,
    eventType: 'CHECKOUT_VIEWED',
    context: { tracked: true }
  });
  return target.toString();
}

export async function revenueMoneyMetrics(env) {
  await ensureAutonomyControlSchema(env);
  const [contacts, checkouts, payments, open, attention] = await Promise.all([
    env.CASE_DB.prepare(`
      SELECT COUNT(*) AS count
        FROM dispatch_log
       WHERE provider = 'GMAIL_AUTOPILOT' AND status = 'SENT'
    `).first(),
    env.CASE_DB.prepare(`
      SELECT COUNT(*) AS created,
             COALESCE(SUM(checkout_view_count), 0) AS views
        FROM revenue_autopilot
       WHERE stripe_checkout_session_id IS NOT NULL
    `).first(),
    env.CASE_DB.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(CASE WHEN upper(currency) = 'EUR' THEN amount_minor ELSE 0 END), 0) AS realized_minor
        FROM stripe_payments
    `).first(),
    env.CASE_DB.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN payment_status = 'REQUESTED' AND offer_type = 'CASE_CHECK_49'
            THEN COALESCE(fixed_offer_amount_cents, 0)
          WHEN payment_status = 'REQUESTED'
            THEN COALESCE(calculated_fee_minor, success_fee_amount_cents, 0)
          ELSE 0
        END
      ), 0) AS open_minor
      FROM revenue_autopilot
    `).first(),
    env.CASE_DB.prepare(`
      SELECT COUNT(*) AS count
        FROM revenue_autopilot
       WHERE owner_attention_reason IS NOT NULL
    `).first()
  ]);

  return {
    contactsSent: Number(contacts?.count || 0),
    checkoutCreated: Number(checkouts?.created || 0),
    checkoutViews: Number(checkouts?.views || 0),
    paymentsReceived: Number(payments?.count || 0),
    openAmountEur: Number(open?.open_minor || 0) / 100,
    realizedRevenueEur: Number(payments?.realized_minor || 0) / 100,
    ownerAttentionCount: Number(attention?.count || 0)
  };
}

export const AUTONOMY_CONTROL_INTERNALS = Object.freeze({
  ALLOWED_CONTACT_ROUTES,
  validEmail,
  HARD_EXCLUSION,
  OPT_OUT
});
