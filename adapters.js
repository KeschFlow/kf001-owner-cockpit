const CACHE_KEY = 'kf001-owner-cache-v2';

const CASE_STATUSES = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED_PENDING_DISPATCH: 'APPROVED_PENDING_DISPATCH',
  DISPATCHED: 'DISPATCHED',
  RESPONSE_RECEIVED: 'RESPONSE_RECEIVED',
  REJECTED: 'REJECTED'
});

const PUBLIC_FALLBACK = Object.freeze({
  caseId: 'PUB-001',
  caseValueScore: 'PRIVATE / NOT EXPOSED',
  outreachReady: true,
  impactClass: 'HOCH',
  evidenceQuality: 'PRIVATE / NOT EXPOSED',
  recommendation: 'APPROVE OUTREACH',
  outreachMessage: 'Anonymisierte Erstkontakt-Nachricht ist vorbereitet. Empfänger, Falldetails, Beweise und Konditionen verbleiben ausschließlich im privaten System.',
  status: CASE_STATUSES.PENDING_APPROVAL,
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
    status: Object.values(CASE_STATUSES).includes(record.status) ? record.status : CASE_STATUSES.PENDING_APPROVAL,
    version: Number(record.version || 1),
    cachedAt: new Date().toISOString()
  };
}

class CaseStoreAdapter {
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

  async loadOwnerState() {
    const url = endpoint(config().ownerStatePath || '/v1/owner-state');
    if (url && this.centralBackendConnected) {
      try {
        const response = await fetch(url, {
          credentials: config().ownerStateCredentials || 'omit',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`Owner state HTTP ${response.status}`);
        const state = await response.json();
        this.writeCache(state);
        return { ...PUBLIC_FALLBACK, ...state, stateSource: 'CENTRAL_BACKEND', isSourceOfTruth: true };
      } catch (error) {
        const cached = this.readCache();
        return {
          ...PUBLIC_FALLBACK,
          ...(cached || {}),
          stateSource: cached ? 'LOCAL_CACHE_FALLBACK' : 'PUBLIC_FALLBACK',
          isSourceOfTruth: false,
          backendError: error.message
        };
      }
    }

    const cached = this.readCache();
    return {
      ...PUBLIC_FALLBACK,
      ...(cached || {}),
      stateSource: cached ? 'LOCAL_CACHE_FALLBACK' : 'PUBLIC_FALLBACK',
      isSourceOfTruth: false
    };
  }

  async submitDecision({ caseId, decision, version }) {
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('Ungültige Owner-Entscheidung');

    const localStatus = decision === 'APPROVE'
      ? CASE_STATUSES.APPROVED_PENDING_DISPATCH
      : CASE_STATUSES.REJECTED;
    const intent = { caseId, decision, expectedVersion: version, requestedAt: new Date().toISOString() };
    const url = config().approvalIntentConnected
      ? endpoint(config().approvalIntentPath || '/v1/approval-intents')
      : '';

    if (url) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(intent)
      });
      if (!response.ok) throw new Error(`Approval intent HTTP ${response.status}`);
      const result = await response.json();
      this.writeCache(result);
      return { ...result, centralState: true, stateSource: 'CENTRAL_BACKEND', dispatchExecuted: false };
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
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }
}

class OutreachAdapter {
  constructor(caseStore) {
    this.caseStore = caseStore;
  }

  get realDispatchConnected() {
    return false;
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
