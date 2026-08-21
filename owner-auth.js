(function initializeOwnerAuth(global) {
  const config = () => global.KF001_CONFIG || {};

  function endpoint(path) {
    const base = String(config().apiBaseUrl || '').replace(/\/$/, '');
    return base ? `${base}${path}` : '';
  }

  function decodeBase64url(value) {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function encodeBase64url(value) {
    if (value === null || value === undefined) return null;
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function parseJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `OWNER_AUTH_HTTP_${response.status}`);
    return body;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('OWNER_AUTH_TIMEOUT')), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function creationOptions(options) {
    return {
      ...options,
      challenge: decodeBase64url(options.challenge),
      user: { ...options.user, id: decodeBase64url(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
        ...credential,
        id: decodeBase64url(credential.id)
      }))
    };
  }

  function requestOptions(options) {
    return {
      ...options,
      challenge: decodeBase64url(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((credential) => ({
        ...credential,
        id: decodeBase64url(credential.id)
      }))
    };
  }

  function registrationResponse(credential) {
    const response = credential.response;
    return {
      id: credential.id,
      rawId: encodeBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        attestationObject: encodeBase64url(response.attestationObject),
        transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
        publicKeyAlgorithm: typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : undefined,
        publicKey: typeof response.getPublicKey === 'function' ? encodeBase64url(response.getPublicKey()) : undefined,
        authenticatorData: typeof response.getAuthenticatorData === 'function'
          ? encodeBase64url(response.getAuthenticatorData())
          : undefined
      }
    };
  }

  function authenticationResponse(credential) {
    const response = credential.response;
    return {
      id: credential.id,
      rawId: encodeBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
        authenticatorData: encodeBase64url(response.authenticatorData),
        signature: encodeBase64url(response.signature),
        userHandle: encodeBase64url(response.userHandle)
      }
    };
  }

  class OwnerAuthAdapter {
    constructor() {
      this.enrollmentTicket = globalThis.KF001_BOOTSTRAP_STATE?.enrollmentTicket || null;
      this.verified = false;
    }

    get connected() {
      return Boolean(config().apiBaseUrl && config().ownerAuthConnected && global.PublicKeyCredential);
    }

    async status() {
      if (!this.connected) return { enrolled: false, credentialCount: 0, verified: false };
      const response = await fetchWithTimeout(endpoint(config().ownerAuthStatusPath || '/v1/auth/status'), {
        credentials: 'omit',
        headers: { Accept: 'application/json' }
      });
      return { ...(await parseJson(response)), verified: this.verified };
    }

    async register() {
      if (!this.enrollmentTicket) throw new Error('ENROLLMENT_TICKET_NOT_AVAILABLE');
      if (!this.connected) throw new Error('OWNER_AUTH_NOT_CONNECTED');
      const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.enrollmentTicket}`,
        'Content-Type': 'application/json'
      };
      const optionsResponse = await fetch(endpoint(config().ownerRegistrationOptionsPath || '/v1/auth/register/options'), {
        method: 'POST', credentials: 'omit', headers, body: '{}'
      });
      const { challengeId, options } = await parseJson(optionsResponse);
      const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
      if (!credential) throw new Error('PASSKEY_CREATION_CANCELLED');
      const verifyResponse = await fetch(endpoint(config().ownerRegistrationVerifyPath || '/v1/auth/register/verify'), {
        method: 'POST',
        credentials: 'omit',
        headers,
        body: JSON.stringify({ challengeId, response: registrationResponse(credential) })
      });
      const result = await parseJson(verifyResponse);
      this.enrollmentTicket = null;
      return result;
    }

    async createAssertion(purpose, payload) {
      if (!this.connected) throw new Error('OWNER_AUTH_NOT_CONNECTED');
      const optionsResponse = await fetch(endpoint(config().ownerAuthenticationOptionsPath || '/v1/auth/options'), {
        method: 'POST',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, payload })
      });
      const { challengeId, options } = await parseJson(optionsResponse);
      const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
      if (!credential) throw new Error('PASSKEY_AUTHENTICATION_CANCELLED');
      return { challengeId, response: authenticationResponse(credential) };
    }

    async verify() {
      const auth = await this.createAssertion('OWNER_VERIFY', null);
      const response = await fetch(endpoint(config().ownerAuthenticationVerifyPath || '/v1/auth/verify'), {
        method: 'POST',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth })
      });
      const result = await parseJson(response);
      this.verified = result.verified === true;
      return result;
    }
  }

  global.KF001_OWNER_AUTH = Object.freeze({ OwnerAuthAdapter });
})(globalThis);
