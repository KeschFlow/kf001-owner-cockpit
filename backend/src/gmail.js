function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8Base64(value) {
  return base64url(new TextEncoder().encode(String(value)));
}

function cleanHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function encodedSubject(value) {
  const raw = String(value || '').trim();
  if (/^[\x20-\x7E]*$/.test(raw)) return cleanHeader(raw);
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

export function gmailConfigured(env) {
  return Boolean(
    env.GMAIL_CLIENT_ID &&
    env.GMAIL_CLIENT_SECRET &&
    env.GMAIL_REFRESH_TOKEN &&
    env.GMAIL_FROM
  );
}

async function accessToken(env) {
  if (!gmailConfigured(env)) throw new Error('GMAIL_NOT_CONFIGURED');
  const body = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET,
    refresh_token: env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`GMAIL_TOKEN_${response.status}`);
  }
  return json.access_token;
}

export async function sendGmail(env, { to, subject, text }) {
  const token = await accessToken(env);
  const from = cleanHeader(env.GMAIL_FROM);
  const recipient = cleanHeader(to);
  if (!recipient) throw new Error('GMAIL_RECIPIENT_MISSING');

  const message = [
    `From: ${from}`,
    `To: ${recipient}`,
    `Subject: ${encodedSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(text || '')
  ].join('\r\n');

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: utf8Base64(message) })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.id) {
    throw new Error(`GMAIL_SEND_${response.status}`);
  }
  return { id: json.id, threadId: json.threadId || null };
}
