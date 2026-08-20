const CACHE_KEY = 'kf001-owner-cache-v3';

const CASE_STATUSES = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED_PENDING_DISPATCH: 'APPROVED_PENDING_DISPATCH',
  DISPATCHED: 'DISPATCHED',
  RESPONSE_RECEIVED: 'RESPONSE_RECEIVED',
  REJECTED: 'REJECTED'
});

const TERMINAL_CASE_STATUSES = new Set([
  CASE_STATUSES.DISPATCHED,
  CASE_STATUSES.RESPONSE_RECEIVED,
  CASE_STATUSES.REJECTED
]);

const PUBLIC_FALLBACK = Object.freeze({
  caseId: 'PUB-001',
  caseValueScore: 'PRIVATE / NOT EXPOSED',
  outreachReady: false,
  impactClass: '—',
  evidenceQuality: '—',
  recommendation: 'NO QUALIFIED ECONOMIC WINNER',
  outreachMessage: 'Kein wirtschaftlich qualifizierter Fall im Owner Gate.',
  status: CASE_STATUSES.REJECTED,
  version: 1
});

function config() {
  return globalThis.KF001_CONFIG || {};
}

function endpoint(path) {
  const base = String(config().apiBaseUrl || '').replace(/\/$/, '');
  return base ? `${base}${path}` : '';
}

function safeCacheRecord(record) {
  return {
    caseId: String(record.caseId || PUBLIC_FALLBACK.caseId),
    status: Object.values(CASE_STATUSES).includes(record.status) ? record.status : CASE_STATUSES.REJECTED,
    version: Number(record.version || 1),
    cachedAt: new Date().toISOString()
  };
}

function noActiveCaseState() {
  return {
    ...PUBLIC_FALLBACK,
    caseId: null,
    status: null,
    version: 0,
    noActiveCase: true,
    stateSource: 'CENTRAL_BACKEND',
    isSourceOfTruth: true
  };
}

class CaseStoreAdapter {
  constructor(ownerAuth = null) {
    this.ownerAuth = ownerAuth;
  }

  get centralBackendConnected() {
    return Boolean(config().apiBaseUrl && config().centralStateReadConnected);
  }

  readCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return cached && cached.caseId ? cached : null;
    } catch {
      return null;
    }
  }

  writeCache(record) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(safeCacheRecord(record)));
    } catch {
      // Cache failure must never block the public owner UI.
    }
  }

  clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch {}
  }

  usableCache() {
    const cached = this.readCache();
    if (cached && TERMINAL_CASE_STATUSES.has(cached.status)) {
      this.clearCache();
      return null;
    }
    return cached;
  }

  async loadOwnerState() {
    const url = endpoint(config().ownerStatePath || '/v1/owner-state');
    if (url && this.centralBackendConnected) {
      try {
        const response = await fetch(url, {
          credentials: config().ownerStateCredentials || 'omit',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 404 && payload.error === 'NO_ACTIVE_CASE') {
          this.clearCache();
          return noActiveCaseState();
        }
        if (!response.ok) throw new Error(payload.error || `Owner state HTTP ${response.status}`);

        // Terminal cases are history. Even if a stale server row still says is_active=1,
        // the client must never render DISPATCHED/REJECTED/RESPONSE_RECEIVED as Owner Gate 1.
        if (TERMINAL_CASE_STATUSES.has(payload.status)) {
          this.clearCache();
          return noActiveCaseState();
        }

        this.writeCache(payload);
        return { ...PUBLIC_FALLBACK, ...payload, stateSource: 'CENTRAL_BACKEND', isSourceOfTruth: true };
      } catch (error) {
        const cached = this.usableCache();
        return {
          ...PUBLIC_FALLBACK,
          ...(cached || {}),
          stateSource: cached ? 'LOCAL_CACHE_FALLBACK' : 'PUBLIC_FALLBACK',
          isSourceOfTruth: false,
          backendError: error.message
        };
      }
    }

    const cached = this.usableCache();
    return {
      ...PUBLIC_FALLBACK,
      ...(cached || {}),
      stateSource: cached ? 'LOCAL_CACHE_FALLBACK' : 'PUBLIC_FALLBACK',
      isSourceOfTruth: false
    };
  }

  async submitDecision({ caseId, decision, version }) {
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('Ungültige Owner-Entscheidung');
    if (!caseId) throw new Error('NO_ACTIVE_CASE');

    const localStatus = decision === 'APPROVE'
      ? CASE_STATUSES.APPROVED_PENDING_DISPATCH
      : CASE_STATUSES.REJECTED;
    const intent = { caseId, decision, expectedVersion: version, requestedAt: new Date().toISOString() };
    const url = config().approvalIntentConnected
      ? endpoint(config().approvalIntentPath || '/v1/approval-intents')
      : '';

    if (url) {
      if (!this.ownerAuth?.connected) throw new Error('OWNER_AUTH_NOT_CONNECTED');
      const auth = await this.ownerAuth.createAssertion('APPROVAL_INTENT', intent);
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ intent, auth })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Approval intent HTTP ${response.status}`);
      this.writeCache(result);
      return { ...result, centralState: true, stateSource: 'CENTRAL_BACKEND' };
    }

    const result = {
      ...intent,
      status: localStatus,
      version: Number(version || 1) + 1,
      centralState: false,
      stateSource: 'LOCAL_CACHE_ONLY',
      syncState: 'NOT_SYNCED',
      dispatchExecuted: false
    };
    this.writeCache(result);
    return result;
  }
}

class NotificationAdapter {
  get pushBackendConnected() {
    return Boolean(config().apiBaseUrl && config().pushPublicKey);
  }

  permission() {
    return 'Notification' in globalThis ? Notification.permission : 'unsupported';
  }

  async requestPermission() {
    if (!('Notification' in globalThis)) return 'unsupported';
    return Notification.requestPermission();
  }

  async subscribe() {
    if (!this.pushBackendConnected) throw new Error('PUSH_BACKEND_CONNECTED = NO');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.#urlBase64ToUint8Array(config().pushPublicKey)
    });
    const url = endpoint(config().pushSubscriptionPath || '/v1/push/subscriptions');
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    });
    if (!response.ok) throw new Error(`Push subscription HTTP ${response.status}`);
    return subscription;
  }

  async showLocalTest() {
    const permission = await this.requestPermission();
    if (permission !== 'granted') throw new Error(`Notification Permission = ${permission}`);
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification('[TEST] KF-001 Owner Notification', {
      body: '[TEST ONLY] Lokal ausgelöst. Kein externer Radar-Event und keine echte Case-Aktivität.',
      icon: './app-icon.svg',
      badge: './app-icon.svg',
      tag: 'kf001-local-test',
      data: { url: './', testOnly: true }
    });
  }

  #urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...new Uint8Array([...raw].map((char) => char.charCodeAt(0)))].map((byte) => byte));
  }
}

class OutreachAdapter {
  constructor(caseStore) {
    this.caseStore = caseStore;
    this.dispatchLive = false;
    this.lastHealth = null;
  }

  get realDispatchConnected() {
    return this.dispatchLive === true;
  }

  async refreshStatus() {
    const url = endpoint('/health');
    if (!url) {
      this.dispatchLive = false;
      this.lastHealth = null;
      return false;
    }
    const response = await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    const health = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(health.error || `Health HTTP ${response.status}`);
    this.lastHealth = health;
    this.dispatchLive = health.realOutreachDispatch === 'LIVE';
    return this.dispatchLive;
  }

  submitApprovalIntent(payload) {
    return this.caseStore.submitDecision(payload);
  }
}

class EvidenceAdapter {
  async hashFile(file) {
    if (!file) return { hashStatus: 'NOT_AVAILABLE', sha256: null };
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256 wird von diesem Browser nicht unterstützt');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return {
      hashStatus: 'COMPUTED_FROM_SELECTED_FILE',
      sha256,
      fileName: file.name,
      fileSize: file.size,
      computedAt: new Date().toISOString(),
      uploaded: false
    };
  }
}

globalThis.KF001_ADAPTERS = Object.freeze({
  CASE_STATUSES,
  CaseStoreAdapter,
  NotificationAdapter,
  OutreachAdapter,
  EvidenceAdapter
});