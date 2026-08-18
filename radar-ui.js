(function initRealRadarUI(global) {
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const config = () => global.KF001_CONFIG || {};
  const endpoint = (path) => `${String(config().apiBaseUrl || '').replace(/\/$/, '')}${path}`;
  let ownerAuth = null;
  let privateTimer = null;

  async function waitForOwnerAuth() {
    for (let i = 0; i < 80; i += 1) {
      const Adapter = global.KF001_OWNER_AUTH?.OwnerAuthAdapter;
      if (Adapter) {
        ownerAuth = new Adapter();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  function ensurePanel() {
    let panel = document.getElementById('realRadarPanel');
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = 'realRadarPanel';
    panel.className = 'bg-slate-800/80 p-4 rounded-2xl border border-cyan-500/30 shadow-sm space-y-3';
    const gate = document.getElementById('ownerGateContainer');
    gate?.before(panel);
    return panel;
  }

  async function readHealth() {
    const response = await fetch(endpoint('/health'), { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HEALTH_${response.status}`);
    return body;
  }

  async function readOwnerState() {
    const response = await fetch(endpoint(config().ownerStatePath || '/v1/owner-state'), { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `OWNER_STATE_${response.status}`);
    return body;
  }

  async function render() {
    const panel = ensurePanel();
    let health = {};
    try {
      health = await readHealth();
    } catch (error) {
      panel.innerHTML = `<h3 class="font-extrabold text-white text-sm">REAL RADAR</h3><p class="text-xs text-rose-300">Radar-Status nicht abrufbar: ${esc(error.message)}</p>`;
      return;
    }

    const live = health.realRadar === 'LIVE';
    const lastRun = health.radarLastRunAt ? new Date(health.radarLastRunAt).toLocaleString('de-DE') : 'noch kein Lauf';
    panel.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="font-extrabold text-white text-sm">REAL RADAR</h3>
          <p class="text-[11px] text-slate-400">Automatischer Scout sucht reale öffentliche Plattform-/Billing-Fälle, bewertet sie und hält private Identitäts-/Quelldaten aus der öffentlichen Ansicht heraus.</p>
        </div>
        <span class="text-[10px] font-mono px-2 py-1 rounded bg-slate-950 border ${live ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300'}">${live ? 'LIVE' : 'NOT LIVE'}</span>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div class="bg-slate-950/80 p-3 rounded-xl border border-slate-700"><span class="block text-[9px] text-slate-400 font-mono">LETZTER LAUF</span><span class="block text-xs font-bold text-white mt-1">${esc(lastRun)}</span></div>
        <div class="bg-slate-950/80 p-3 rounded-xl border border-slate-700"><span class="block text-[9px] text-slate-400 font-mono">GEFUNDEN</span><span class="block text-xs font-bold text-white mt-1">${Number(health.radarLastDiscovered || 0)}</span></div>
        <div class="bg-slate-950/80 p-3 rounded-xl border border-slate-700"><span class="block text-[9px] text-slate-400 font-mono">QUALIFIZIERT</span><span class="block text-xs font-bold text-white mt-1">${Number(health.radarLastQualified || 0)}</span></div>
        <div class="bg-slate-950/80 p-3 rounded-xl border border-slate-700"><span class="block text-[9px] text-slate-400 font-mono">KONTAKTIERBAR</span><span class="block text-xs font-bold text-white mt-1">${Number(health.radarLastContactable || 0)}</span></div>
      </div>
      <div class="flex flex-wrap gap-2">
        <button id="runRealRadarBtn" class="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold">⚡ RADAR JETZT SCANNEN</button>
        <button id="loadPrivateCaseBtn" class="px-3 py-2 rounded-lg bg-slate-950 border border-cyan-500/40 text-cyan-200 text-xs font-bold">🔐 PRIVATE FALLDATEN</button>
      </div>
      <p id="realRadarResult" class="text-[10px] ${health.radarLastRunError ? 'text-rose-300' : 'text-slate-400'}">${health.radarLastRunError ? `Letzter Fehler: ${esc(health.radarLastRunError)}` : 'Automatik: alle 3 Stunden. Manuelles Scannen verlangt deinen Passkey.'}</p>
      <div id="privateCaseDetail" class="hidden"></div>`;

    document.getElementById('runRealRadarBtn')?.addEventListener('click', runRadarNow);
    document.getElementById('loadPrivateCaseBtn')?.addEventListener('click', loadPrivateCase);
  }

  async function runRadarNow() {
    const result = document.getElementById('realRadarResult');
    const button = document.getElementById('runRealRadarBtn');
    if (!ownerAuth) return;
    button.disabled = true;
    result.textContent = 'Radar läuft: öffentliche Quellen werden jetzt geprüft und autoritativ bewertet …';
    try {
      const auth = await ownerAuth.createAssertion('RADAR_SCAN', null);
      const response = await fetch(endpoint(config().radarRunPath || '/v1/radar/run'), {
        method: 'POST',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `RADAR_${response.status}`);
      result.textContent = `Radar abgeschlossen: ${body.discovered || 0} gefunden, ${body.qualified || 0} qualifiziert, ${body.contactable || 0} kontaktierbar${body.promotedCaseId ? `, ${body.promotedCaseId} ins Owner Gate übernommen` : ''}.`;
      setTimeout(() => location.reload(), 1200);
    } catch (error) {
      result.textContent = `Radar fehlgeschlagen: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async function loadPrivateCase() {
    const result = document.getElementById('realRadarResult');
    const box = document.getElementById('privateCaseDetail');
    if (!ownerAuth) return;
    try {
      const state = await readOwnerState();
      const payload = { caseId: state.caseId };
      result.textContent = `Private Falldaten für ${state.caseId} werden per Passkey freigegeben …`;
      const auth = await ownerAuth.createAssertion('PRIVATE_CASE_READ', payload);
      const response = await fetch(endpoint(config().privateCaseDetailPath || '/v1/private/case-detail'), {
        method: 'POST',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: state.caseId, auth })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `PRIVATE_CASE_${response.status}`);
      box.className = 'p-3 bg-slate-950/90 rounded-xl border border-cyan-500/30 text-xs space-y-2';
      box.innerHTML = `
        <div class="flex justify-between gap-2"><strong class="text-cyan-300">PRIVATE OWNER DETAIL</strong><span class="font-mono text-slate-400">${esc(body.caseId)}</span></div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div><span class="text-slate-500">Quelle</span><div class="text-white font-bold">${esc(body.source)}</div></div>
          <div><span class="text-slate-500">Kontaktweg</span><div class="text-white font-bold">${esc(body.contactRoute || 'nicht gefunden')}</div></div>
          <div><span class="text-slate-500">Autor</span><div class="text-white font-bold">${esc(body.authorName || body.authorLogin || 'unbekannt')}</div></div>
          <div><span class="text-slate-500">Kontakt</span><div class="text-white font-bold break-all">${esc(body.contactEmail || 'nicht gefunden')}</div></div>
          <div><span class="text-slate-500">Impact Score</span><div class="text-white font-bold">${esc(body.impactScore)}/100</div></div>
          <div><span class="text-slate-500">Evidence Score</span><div class="text-white font-bold">${esc(body.evidenceScore)}/100</div></div>
        </div>
        <div><span class="text-slate-500">Originaltitel</span><div class="text-white font-bold">${esc(body.sourceTitle)}</div></div>
        <div><span class="text-slate-500">Öffentliche Quelle</span><div><a class="text-cyan-300 underline break-all" target="_blank" rel="noopener noreferrer" href="${esc(body.sourceUrl)}">${esc(body.sourceUrl)}</a></div></div>
        <div><span class="text-slate-500">Quellenauszug</span><div class="text-slate-200 leading-relaxed max-h-48 overflow-auto">${esc(body.sourceExcerpt)}</div></div>`;
      result.textContent = 'Private Falldaten per Passkey geladen. Sie werden nach 5 Minuten wieder aus der Ansicht entfernt.';
      clearTimeout(privateTimer);
      privateTimer = setTimeout(() => {
        box.innerHTML = '';
        box.className = 'hidden';
      }, 5 * 60 * 1000);
    } catch (error) {
      box.innerHTML = '';
      box.className = 'hidden';
      result.textContent = `Private Falldaten nicht geladen: ${error.message}`;
    }
  }

  async function boot() {
    const ready = await waitForOwnerAuth();
    if (!ready) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    } else {
      render();
    }
  }

  boot();
})(globalThis);
