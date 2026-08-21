const DEFAULT_SUCCESS_FEE_PERCENT = 10;
const DEFAULT_SUCCESS_FEE_MIN_EUR = 750;
const DEFAULT_SUCCESS_FEE_MAX_EUR = 5000;
const DEFAULT_SUCCESS_MIN_RECOVERED_USD = 8000;
const DEFAULT_USD_TO_EUR_RATE = 0.90;
const PRICING_VERSION = 'DYNAMIC_SUCCESS_FEE_V1';
const STRIPE_CHECKOUT_URL = 'https://api.stripe.com/v1/checkout/sessions';
const CHECKOUT_TTL_SECONDS = 23 * 60 * 60;

function finitePositive(value, errorCode) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(errorCode);
  return number;
}

function envNumber(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return finitePositive(raw, `INVALID_${key}`);
}

function configuredUrl(value, errorCode) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(errorCode); }
  if (parsed.protocol !== 'https:') throw new Error(errorCode);
  return parsed.toString();
}

function validCaseId(value) {
  const caseId = String(value || '');
  if (!/^PUB-[A-Z0-9-]{3,40}$/.test(caseId)) throw new Error('INVALID_CASE_ID');
  return caseId;
}

function validCustomerEmail(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('VERIFIED_CUSTOMER_EMAIL_REQUIRED');
  }
  return email;
}

export function successFeeConfig(env = {}) {
  const primaryRate = env?.SUCCESS_FEE_EUR_USD_RATE;
  const aliasRate = env?.USD_TO_EUR_RATE;
  if (primaryRate !== undefined && aliasRate !== undefined && Number(primaryRate) !== Number(aliasRate)) {
    throw new Error('USD_TO_EUR_RATE_CONFIG_CONFLICT');
  }
  return Object.freeze({
    feePercent: envNumber(env, 'SUCCESS_FEE_PERCENT', DEFAULT_SUCCESS_FEE_PERCENT),
    feeMinEur: envNumber(env, 'SUCCESS_FEE_MIN_EUR', DEFAULT_SUCCESS_FEE_MIN_EUR),
    feeMaxEur: envNumber(env, 'SUCCESS_FEE_MAX_EUR', DEFAULT_SUCCESS_FEE_MAX_EUR),
    minRecoveredUsd: envNumber(env, 'SUCCESS_MIN_RECOVERED_USD', DEFAULT_SUCCESS_MIN_RECOVERED_USD),
    usdToEurRate: primaryRate !== undefined
      ? envNumber(env, 'SUCCESS_FEE_EUR_USD_RATE', DEFAULT_USD_TO_EUR_RATE)
      : envNumber(env, 'USD_TO_EUR_RATE', DEFAULT_USD_TO_EUR_RATE),
    pricingVersion: PRICING_VERSION
  });
}

export function calculateSuccessFee(recoveredApproxUsd, usdToEurRate, overrides = {}) {
  const recoveredUsd = finitePositive(recoveredApproxUsd, 'INVALID_RECOVERED_AMOUNT_USD');
  const eurUsdRate = finitePositive(usdToEurRate, 'INVALID_USD_TO_EUR_RATE');
  const feePercent = finitePositive(overrides.feePercent ?? DEFAULT_SUCCESS_FEE_PERCENT, 'INVALID_SUCCESS_FEE_PERCENT');
  const feeMinEur = finitePositive(overrides.feeMinEur ?? DEFAULT_SUCCESS_FEE_MIN_EUR, 'INVALID_SUCCESS_FEE_MIN_EUR');
  const feeMaxEur = finitePositive(overrides.feeMaxEur ?? DEFAULT_SUCCESS_FEE_MAX_EUR, 'INVALID_SUCCESS_FEE_MAX_EUR');
  const minRecoveredUsd = finitePositive(
    overrides.minRecoveredUsd ?? DEFAULT_SUCCESS_MIN_RECOVERED_USD,
    'INVALID_SUCCESS_MIN_RECOVERED_USD'
  );
  if (feeMinEur > feeMaxEur) throw new Error('INVALID_SUCCESS_FEE_LIMITS');
  if (recoveredUsd < minRecoveredUsd) throw new Error('RECOVERED_AMOUNT_BELOW_MINIMUM');

  const recoveredEurMinor = Math.round(recoveredUsd * eurUsdRate * 100);
  const rawFeeMinor = Math.round(recoveredUsd * eurUsdRate * (feePercent / 100) * 100);
  const minimumMinor = Math.round(feeMinEur * 100);
  const maximumMinor = Math.round(feeMaxEur * 100);
  const feeAmountCents = Math.min(maximumMinor, Math.max(minimumMinor, rawFeeMinor));

  return Object.freeze({
    recoveredUsd,
    eurUsdRate,
    recoveredEur: recoveredEurMinor / 100,
    feePercent,
    feeMinEur,
    feeMaxEur,
    minRecoveredUsd,
    uncappedFeeAmountCents: rawFeeMinor,
    uncappedFeeAmountEur: rawFeeMinor / 100,
    feeAmountCents,
    feeAmountEur: feeAmountCents / 100,
    minimumApplied: rawFeeMinor < minimumMinor,
    maximumApplied: rawFeeMinor > maximumMinor,
    pricingVersion: PRICING_VERSION
  });
}

export function calculateSuccessFeeEur(recoveredAmountUsd, usdToEurRate) {
  return calculateSuccessFee(recoveredAmountUsd, usdToEurRate).feeAmountCents;
}

export function stripeCheckoutConfigured(env) {
  if (!env?.STRIPE_SECRET_KEY) return false;
  try {
    configuredUrl(env.STRIPE_SUCCESS_URL, 'STRIPE_SUCCESS_URL_NOT_CONFIGURED');
    configuredUrl(env.STRIPE_CANCEL_URL, 'STRIPE_CANCEL_URL_NOT_CONFIGURED');
    return true;
  } catch {
    return false;
  }
}

export function stripeIdempotencyKey(caseId, recoveredUsd) {
  const normalizedCaseId = validCaseId(caseId);
  const normalizedAmount = finitePositive(recoveredUsd, 'INVALID_RECOVERED_AMOUNT_USD').toFixed(2);
  return `kf001-success-fee-${normalizedCaseId}-${normalizedAmount}`;
}

export async function createSuccessFeeCheckoutSession(env, payload, storedPricingConfig = null) {
  if (!env?.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY_NOT_CONFIGURED');
  const caseId = validCaseId(payload?.publicCaseId);
  const customerEmail = validCustomerEmail(payload?.customerEmail);
  const config = storedPricingConfig ? {
    feePercent: finitePositive(storedPricingConfig.feePercent, 'INVALID_STORED_SUCCESS_FEE_PERCENT'),
    feeMinEur: finitePositive(storedPricingConfig.feeMinEur, 'INVALID_STORED_SUCCESS_FEE_MIN_EUR'),
    feeMaxEur: finitePositive(storedPricingConfig.feeMaxEur, 'INVALID_STORED_SUCCESS_FEE_MAX_EUR'),
    minRecoveredUsd: finitePositive(storedPricingConfig.minRecoveredUsd, 'INVALID_STORED_SUCCESS_MIN_RECOVERED_USD'),
    usdToEurRate: finitePositive(storedPricingConfig.usdToEurRate, 'INVALID_STORED_USD_TO_EUR_RATE')
  } : successFeeConfig(env);
  const pricing = calculateSuccessFee(payload?.recoveredAmountUsd, config.usdToEurRate, config);
  const successUrl = configuredUrl(env.STRIPE_SUCCESS_URL, 'STRIPE_SUCCESS_URL_NOT_CONFIGURED');
  const cancelUrl = configuredUrl(env.STRIPE_CANCEL_URL, 'STRIPE_CANCEL_URL_NOT_CONFIGURED');
  const idempotencyKey = stripeIdempotencyKey(caseId, pricing.recoveredUsd);
  const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS;
  const formula = `${pricing.feePercent}% of documented USD ${pricing.recoveredUsd.toFixed(2)} at USD→EUR ${pricing.eurUsdRate.toFixed(4)}, min EUR ${pricing.feeMinEur.toFixed(2)}, max EUR ${pricing.feeMaxEur.toFixed(2)}`;
  const body = new URLSearchParams({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: caseId,
    customer_email: customerEmail,
    expires_at: String(expiresAt),
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': String(pricing.feeAmountCents),
    'line_items[0][price_data][product_data][name]': 'KESCHFLOW Erfolgshonorar',
    'line_items[0][price_data][product_data][description]': `${caseId}: ${formula}`,
    'line_items[0][quantity]': '1',
    'metadata[case_id]': caseId,
    'metadata[public_case_id]': caseId,
    'metadata[recovered_amount_usd]': pricing.recoveredUsd.toFixed(2),
    'metadata[recovered_approx_usd]': pricing.recoveredUsd.toFixed(2),
    'metadata[recovered_approx_eur]': pricing.recoveredEur.toFixed(2),
    'metadata[success_fee_eur]': pricing.feeAmountEur.toFixed(2),
    'metadata[success_fee_percent]': String(pricing.feePercent),
    'metadata[success_fee_amount_cents]': String(pricing.feeAmountCents),
    'metadata[eur_usd_rate]': String(pricing.eurUsdRate),
    'metadata[pricing_model]': 'PERCENT_10_MIN_750_MAX_5000',
    'metadata[pricing_version]': pricing.pricingVersion
  });

  const response = await fetch(STRIPE_CHECKOUT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey
    },
    body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id || !result.url) throw new Error(`STRIPE_CHECKOUT_CREATE_${response.status}`);
  if (Number(result.amount_total) !== pricing.feeAmountCents || String(result.currency || '').toLowerCase() !== 'eur') {
    throw new Error('STRIPE_CHECKOUT_RESPONSE_MISMATCH');
  }
  let checkoutUrl;
  try { checkoutUrl = new URL(String(result.url)); } catch { throw new Error('STRIPE_CHECKOUT_URL_INVALID'); }
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com') {
    throw new Error('STRIPE_CHECKOUT_URL_INVALID');
  }
  return Object.freeze({
    id: String(result.id),
    url: checkoutUrl.toString(),
    expiresAt: result.expires_at ? new Date(Number(result.expires_at) * 1000).toISOString() : new Date(expiresAt * 1000).toISOString(),
    idempotencyKey,
    pricing
  });
}

export async function createCaseCheckCheckoutSession(env, payload) {
  if (!env?.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY_NOT_CONFIGURED');
  const caseId = validCaseId(payload?.publicCaseId);
  const customerEmail = validCustomerEmail(payload?.customerEmail);
  const amountCents = Math.round(envNumber(env, 'CASE_CHECK_PRICE_EUR', 49) * 100);
  const successUrl = configuredUrl(env.STRIPE_SUCCESS_URL, 'STRIPE_SUCCESS_URL_NOT_CONFIGURED');
  const cancelUrl = configuredUrl(env.STRIPE_CANCEL_URL, 'STRIPE_CANCEL_URL_NOT_CONFIGURED');
  const idempotencyKey = `kf001-case-check-${caseId}-v1`;
  const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS;
  const body = new URLSearchParams({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: caseId,
    customer_email: customerEmail,
    expires_at: String(expiresAt),
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': 'KESCHFLOW Platform/Billing Case Check',
    'line_items[0][price_data][product_data][description]': `${caseId}: Fallanalyse, Beweislücken, Eskalationsweg und versandfertiges Schreiben`,
    'line_items[0][quantity]': '1',
    'metadata[case_id]': caseId,
    'metadata[public_case_id]': caseId,
    'metadata[product_type]': 'CASE_CHECK_49',
    'metadata[expected_amount_cents]': String(amountCents),
    'metadata[pricing_version]': 'CASE_CHECK_V1'
  });
  const response = await fetch(STRIPE_CHECKOUT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey
    },
    body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id || !result.url) throw new Error(`STRIPE_CHECKOUT_CREATE_${response.status}`);
  if (Number(result.amount_total) !== amountCents || String(result.currency || '').toLowerCase() !== 'eur') {
    throw new Error('STRIPE_CHECKOUT_RESPONSE_MISMATCH');
  }
  const checkoutUrl = new URL(String(result.url));
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com') {
    throw new Error('STRIPE_CHECKOUT_URL_INVALID');
  }
  return Object.freeze({
    id: String(result.id), url: checkoutUrl.toString(), amountCents, idempotencyKey,
    expiresAt: result.expires_at ? new Date(Number(result.expires_at) * 1000).toISOString() : new Date(expiresAt * 1000).toISOString()
  });
}

export const SUCCESS_FEE_PRICING_VERSION = PRICING_VERSION;
