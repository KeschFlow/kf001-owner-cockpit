// Mount in an existing Worker at /api/delivery; requires a PRIVATE R2 binding.
const BASE = '/api/delivery';
const TTL = 300; // Reusable for five minutes, with Stripe revalidation on every download.
const headers = {'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff'};
const DIAGNOSTIC_CODES = new Set([
  'CONFIG_INVALID', 'REQUEST_INVALID', 'ORIGIN_REJECTED', 'PRODUCT_MISMATCH',
  'STRIPE_SESSION_FAILED', 'SESSION_MISMATCH', 'STRIPE_LINE_ITEMS_FAILED',
  'LINE_ITEM_MISMATCH', 'PAYMENT_INTENT_FAILED', 'PAYMENT_INTENT_MISMATCH',
  'CHARGE_FAILED', 'CHARGE_MISMATCH', 'R2_FILE_MISSING', 'R2_ACCESS_FAILED',
  'TOKEN_INVALID', 'INTERNAL_ERROR'
]);
function reply(status, message, code) {
  const body = code ? {message, code} : {message};
  return new Response(JSON.stringify(body), {status, headers:{...headers,'Content-Type':'application/json'}});
}
function reject(code='INTERNAL_ERROR') { const error = new Error('denied'); error.deliveryCode = code; throw error; }
function settings(env) {
  if (!env.DELIVERY_STRIPE_TEST_SECRET?.startsWith('sk_test_') || env.DELIVERY_MODE !== 'test' ||
      !env.DELIVERY_DOWNLOAD_SIGNING_KEY || env.DELIVERY_DOWNLOAD_SIGNING_KEY.length < 32 ||
      typeof env.PRODUCTS_BUCKET?.head !== 'function' || typeof env.PRODUCTS_BUCKET?.get !== 'function') reject('CONFIG_INVALID');
  let products;
  try { products = JSON.parse(env.DELIVERY_PRODUCTS || '{}'); } catch { reject('CONFIG_INVALID'); }
  if (!products || typeof products !== 'object' || Array.isArray(products) || !products.calendar ||
      Object.keys(products).some(id => !['tracker', 'calendar'].includes(id))) reject('CONFIG_INVALID');
  for (const id of Object.keys(products)) {
    const product = products[id];
    if (!product || !/^price_\w+$/.test(product.price) || !/^prod_\w+$/.test(product.product) ||
        !Number.isSafeInteger(product.amount) || product.amount !== 490 || product.currency !== 'eur' ||
        typeof product.key !== 'string' || !product.key || product.key.includes('..')) reject('CONFIG_INVALID');
  }
  if (products.calendar.key !== 'Mit-Eddie-durchs-Jahr-2027-26-Seiten-A4-quer.pdf') reject('CONFIG_INVALID');
  if (products.tracker && (products.tracker.price === products.calendar.price || products.tracker.product === products.calendar.product ||
      products.tracker.key === products.calendar.key)) reject('CONFIG_INVALID');
  return products;
}
async function stripe(path, env, fetcher, failureCode) {
  try {
    const response = await fetcher('https://api.stripe.com/v1/' + path, {
      headers:{Authorization:'Bearer ' + env.DELIVERY_STRIPE_TEST_SECRET, 'Stripe-Version':'2024-06-20'},
      signal:AbortSignal.timeout(10000), redirect:'error'
    });
    if (!response.ok) reject(failureCode);
    return await response.json();
  } catch (error) {
    if (error?.deliveryCode) throw error;
    reject(failureCode);
  }
}
async function verify(sessionId, product, env, fetcher) {
  if (!/^cs_test_[A-Za-z0-9_]{8,240}$/.test(sessionId || '')) reject('SESSION_MISMATCH');
  const session = await stripe('checkout/sessions/' + encodeURIComponent(sessionId), env, fetcher, 'STRIPE_SESSION_FAILED');
  if (session.id !== sessionId || session.livemode !== false || session.mode !== 'payment' ||
      session.status !== 'complete' || session.payment_status !== 'paid' ||
      session.amount_total !== product.amount || session.currency !== product.currency ||
      typeof session.payment_intent !== 'string') reject('SESSION_MISMATCH');
  const items = await stripe('checkout/sessions/' + encodeURIComponent(sessionId) + '/line_items?limit=2', env, fetcher, 'STRIPE_LINE_ITEMS_FAILED');
  const item = items.data?.[0];
  if (items.has_more !== false || items.data?.length !== 1 || item.quantity !== 1 ||
      item.price?.id !== product.price || item.price?.product !== product.product ||
      item.price?.unit_amount !== product.amount || item.price?.currency !== product.currency ||
      item.price?.type !== 'one_time' || item.amount_total !== product.amount) reject('LINE_ITEM_MISMATCH');
  const intent = await stripe('payment_intents/' + encodeURIComponent(session.payment_intent), env, fetcher, 'PAYMENT_INTENT_FAILED');
  if (intent.id !== session.payment_intent || intent.livemode !== false || intent.status !== 'succeeded' ||
      intent.amount !== product.amount || intent.amount_received !== product.amount ||
      intent.currency !== product.currency || typeof intent.latest_charge !== 'string') reject('PAYMENT_INTENT_MISMATCH');
  const charge = await stripe('charges/' + encodeURIComponent(intent.latest_charge), env, fetcher, 'CHARGE_FAILED');
  if (charge.id !== intent.latest_charge || charge.payment_intent !== intent.id || charge.livemode !== false ||
      charge.status !== 'succeeded' || charge.paid !== true || charge.captured !== true ||
      charge.amount !== product.amount || charge.amount_captured !== product.amount ||
      charge.currency !== product.currency || charge.refunded !== false ||
      charge.amount_refunded !== 0 || charge.disputed !== false) reject('CHARGE_MISMATCH');
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
function unb64(s) { if (!/^[A-Za-z0-9_-]+$/.test(s)) reject(); return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/') + '='.repeat((4-s.length%4)%4)), c=>c.charCodeAt(0)); }
async function key(secret) { return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }
async function issue(session, product, env, now) {
  const payload = b64(new TextEncoder().encode(JSON.stringify({v:1,session,product,exp:now+TTL,nonce:crypto.randomUUID()})));
  const signature = await crypto.subtle.sign('HMAC', await key(env.DELIVERY_DOWNLOAD_SIGNING_KEY), new TextEncoder().encode(payload));
  return payload + '.' + b64(new Uint8Array(signature));
}
async function read(token, env, now) {
  try {
    if (typeof token !== 'string' || token.length > 2048) reject('TOKEN_INVALID');
    const parts = token.split('.'); if (parts.length !== 2) reject('TOKEN_INVALID');
    if (!await crypto.subtle.verify('HMAC', await key(env.DELIVERY_DOWNLOAD_SIGNING_KEY), unb64(parts[1]), new TextEncoder().encode(parts[0]))) reject('TOKEN_INVALID');
    const data = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    if (data.v !== 1 || !Number.isSafeInteger(data.exp) || data.exp <= now || data.exp > now+TTL || typeof data.nonce !== 'string') reject('TOKEN_INVALID');
    return data;
  } catch (error) {
    if (error?.deliveryCode) throw error;
    reject('TOKEN_INVALID');
  }
}
export function createHandler({fetcher=fetch, now=()=>Math.floor(Date.now()/1000)}={}) {
  return async function(request, env) {
    const url = new URL(request.url);
    if (![BASE+'/authorize', BASE+'/download'].includes(url.pathname)) return reply(404,'Nicht gefunden.');
    const origin = request.headers.get('Origin');
    const allowed = origin === url.origin || (env.DELIVERY_APP_ORIGIN && origin === env.DELIVERY_APP_ORIGIN);
    const cors = allowed ? {'Access-Control-Allow-Origin':origin, Vary:'Origin'} : {};
    const safeCode = code => env?.DELIVERY_MODE === 'test' && DIAGNOSTIC_CODES.has(code) ? code : undefined;
    if (request.method === 'OPTIONS') {
      if (!allowed || request.headers.get('Access-Control-Request-Method') !== 'POST' ||
          (request.headers.get('Access-Control-Request-Headers') || '').split(',').some(h => h.trim() && h.trim().toLowerCase() !== 'content-type'))
        return reply(403,'Nicht freigegeben.',safeCode('ORIGIN_REJECTED'));
      return new Response(null,{status:204,headers:{...headers,...cors,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'}});
    }
    const respond = (status,message,code) => { const response = reply(status,message,safeCode(code)); for(const [k,v] of Object.entries(cors)) response.headers.set(k,v); return response; };
    if (request.method !== 'POST') return new Response(null,{status:405,headers:{...headers,...cors,Allow:'POST'}});
    // Exact shop origin only; never reuse the KF-001 cockpit origin configuration.
    if (!allowed || url.search ||
        request.headers.get('Content-Type')?.split(';')[0] !== 'application/json')
      return respond(403,'Nicht freigegeben.',allowed ? 'REQUEST_INVALID' : 'ORIGIN_REJECTED');
    try {
      const bodyText = await request.text(); if (bodyText.length > 4096) reject('REQUEST_INVALID');
      let body;
      try { body = JSON.parse(bodyText); } catch { reject('REQUEST_INVALID'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) reject('REQUEST_INVALID');
      const products = settings(env);
      const authorized = url.pathname.endsWith('/authorize');
      const data = authorized ? body : await read(body.token,env,now());
      if (!data || !Object.hasOwn(products,data.product) || !['tracker','calendar'].includes(data.product)) reject('PRODUCT_MISMATCH');
      const product = products[data.product];
      await verify(data.session,product,env,fetcher);
      if (authorized) {
        // Do not issue a token when the private file is missing.
        let object;
        try { object = await env.PRODUCTS_BUCKET.head(product.key); } catch { reject('R2_ACCESS_FAILED'); }
        if (!object) reject('R2_FILE_MISSING');
        const token = await issue(data.session,data.product,env,now());
        return new Response(JSON.stringify({token,expiresIn:TTL}),{headers:{...headers,...cors,'Content-Type':'application/json'}});
      }
      let file;
      try { file = await env.PRODUCTS_BUCKET.get(product.key); } catch { reject('R2_ACCESS_FAILED'); }
      if (!file) reject('R2_FILE_MISSING');
      return new Response(file.body,{headers:{...headers,...cors,'Content-Type':'application/pdf',
        'Content-Disposition':`attachment; filename="${data.product}.pdf"`}});
    } catch (error) { return respond(403,'Download nicht freigegeben. Zahlung und Konfiguration prüfen.',error?.deliveryCode || 'INTERNAL_ERROR'); }
  };
}
export const handleDeliveryRequest = (request, env) => createHandler()(request, env);
