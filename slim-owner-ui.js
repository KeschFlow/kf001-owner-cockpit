(() => {
  'use strict';

  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const config = () => globalThis.KF001_CONFIG || {};
  const endpoint = (path) => `${String(config().apiBaseUrl || '').replace(/\/$/, '')}${path}`;
  let autopilotStatus = null;

  function readStoredNumber(keys) {
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function text(id, value) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(value)) el.textContent = value;
  }

  function installSlimShell() {
    if (document.getElementById('kfSlimOwner')) return;

    const style = document.createElement('style');
    style.textContent = `
      body > header, body > main, body > nav { display:none !important; }
      #kfSlimOwner { display:block !important; min-height:100vh; }
      #kfSlimOwner #governanceStatus,
      #kfSlimOwner #preparedGovernanceSystems,
      #kfSlimOwner #radarControlPanel,
      #kfSlimOwner #radarResultsPanel { display:none !important; }
      #kfSlimOwner #ownerGateContainer > .grid,
      #kfSlimOwner #ownerGateContainer > .p-3.bg-slate-950\\/80 { display:none !important; }
      #kfSlimOwner #ownerGateContainer { padding:16px !important; margin:0 !important; }
      #kfSlimOwner #gateTruth { font-size:11px !important; }
      #kfSlimOwner #ownerAuthPanel { margin-top:0; }
      #kfSlimOwner #ownerAuthPanel button,
      #kfSlimOwner #gateActionButtons button,
      #slimOpenCaseBtn,
      #slimActionBtn { min-height:48px; touch-action:manipulation; }
      #slimTopCase { cursor:pointer; }
      #slimTopCase:active { transform:scale(.995); }
      @media (max-width:640px){ #kfSlimOwner { padding-bottom:24px; } }
    `;
    document.head.appendChild(style);

    const shell = document.createElement('div');
    shell.id = 'kfSlimOwner';
    shell.className = 'max-w-3xl mx-auto px-4 py-5 space-y-4 text-slate-100';
    shell.innerHTML = `
      <div class="flex items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <div class="text-[10px] text-slate-500 font-mono tracking-widest">KF001</div>
          <h1 class="text-lg font-black text-white">FALLRADAR</h1>
        </div>
        <div id="slimSync" class="text-[10px] font-mono text-emerald-300 border border-emerald-500/30 bg-emerald-950/20 rounded-lg px-2 py-1">SYSTEM AKTIV</div>
      </div>

      <section id="slimActionCard" class="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
        <div class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Nächste Aktion</div>
        <div id="slimNextAction" class="mt-1 text-sm font-bold text-amber-300">Systemstatus wird gelesen …</div>
        <button id="slimActionBtn" type="button" class="hidden mt-3 w-full rounded-xl bg-indigo-600 text-white text-sm font-black px-4 py-3">AKTION ÖFFNEN</button>
      </section>

      <section id="slimTopCase" class="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-3" role="button" tabindex="0" aria-label="Aktiven Fall öffnen">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div id="slimWorkItemLabel" class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">ACTIVE WORK ITEM</div>
            <div id="slimCaseId" class="mt-1 text-base font-black text-white">—</div>
          </div>
          <div id="slimPriority" class="text-[10px] font-mono text-emerald-300 border border-emerald-500/30 rounded-lg px-2 py-1">PRIORITÄT —</div>
        </div>
        <div id="slimWorkItemDetails" class="grid grid-cols-2 gap-2 text-xs">
          <div class="bg-slate-900 rounded-xl border border-slate-800 p-3"><span class="block text-[9px] text-slate-500 uppercase">Potenzial</span><strong id="slimCaseValue" class="text-white">—</strong></div>
          <div class="bg-slate-900 rounded-xl border border-slate-800 p-3"><span class="block text-[9px] text-slate-500 uppercase">Status</span><strong id="slimCaseStatus" class="text-white">—</strong></div>
          <div id="slimVersionField" class="bg-slate-900 rounded-xl border border-slate-800 p-3"><span class="block text-[9px] text-slate-500 uppercase">Version</span><strong id="slimCaseVersion" class="text-white">—</strong></div>
          <div id="slimUpdatedField" class="bg-slate-900 rounded-xl border border-slate-800 p-3"><span class="block text-[9px] text-slate-500 uppercase">Updated</span><strong id="slimCaseUpdated" class="text-white break-words">—</strong></div>
        </div>
        <button id="slimOpenCaseBtn" type="button" class="w-full rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm font-black px-4 py-3">FALL ÖFFNEN</button>
      </section>

      <section class="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-300 space-y-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-slate-500 uppercase tracking-wider text-[9px]">Geldfluss · D1/Stripe</span>
          <button id="slimKillSwitchBtn" type="button" class="rounded-lg border px-2 py-1 text-[10px] font-black">VERSANDSTATUS …</button>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono">
          <div><span class="block text-[9px] text-slate-500">KONTAKTE</span><strong id="slimContacts">—</strong></div>
          <div><span class="block text-[9px] text-slate-500">CHECKOUTS</span><strong id="slimCheckouts">—</strong></div>
          <div><span class="block text-[9px] text-slate-500">CHECKOUT-AUFRUFE</span><strong id="slimCheckoutViews">—</strong></div>
          <div><span class="block text-[9px] text-slate-500">ZAHLUNGEN</span><strong id="slimPayments">—</strong></div>
        </div>
        <div class="font-mono"><span id="slimTotal">0,00 €</span> realisiert · <span id="slimOpen">0,00 €</span> offen</div>
        <div id="slimAttention" class="hidden rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-amber-200"></div>
      </section>

      <section id="slimDecisionSlot"></section>
      <section id="slimAuthSlot"></section>

      <details class="border-t border-slate-800 pt-3 text-[10px] text-slate-600">
        <summary class="cursor-pointer select-none">Hintergrundsystem</summary>
        <p class="mt-2">Radar, Evidence, Scoring, Musteransichten, Logs und technische Diagnose laufen weiter im Hintergrund.</p>
      </details>`;
    document.body.appendChild(shell);

    document.getElementById('slimOpenCaseBtn')?.addEventListener('click', openActiveCase);
    document.getElementById('slimTopCase')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openActiveCase(); }
    });
    document.getElementById('slimTopCase')?.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      openActiveCase();
    });
    document.getElementById('slimActionBtn')?.addEventListener('click', openCurrentAction);
    document.getElementById('slimKillSwitchBtn')?.addEventListener('click', toggleKillSwitch);

    refreshSlimView();
    refreshAutopilotStatus();
    setInterval(refreshAutopilotStatus, 30000);
    let refreshPending = false;
    const observer = new MutationObserver(() => {
      if (refreshPending) return;
      refreshPending = true;
      requestAnimationFrame(() => {
        refreshPending = false;
        refreshSlimView();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function hasActiveDecision() {
    return document.getElementById('ownerGateContainer')?.dataset.workItemState === 'active';
  }

  function focusDecisionGate() {
    const gate = document.getElementById('ownerGateContainer');
    if (!gate || gate.dataset.workItemState !== 'active') return false;
    gate.scrollIntoView({ behavior: 'smooth', block: 'center' });
    gate.animate?.(
      [{ outline: '2px solid rgba(245,158,11,.95)' }, { outline: '2px solid transparent' }],
      { duration: 900 }
    );
    return true;
  }

  async function refreshAutopilotStatus() {
    const path = config().autopilotStatusPath || '/v1/autopilot/status';
    if (!config().apiBaseUrl) return;
    try {
      const response = await fetch(endpoint(path), {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `AUTOPILOT_STATUS_${response.status}`);
      autopilotStatus = body;
      refreshSlimView();
    } catch {
      autopilotStatus = null;
      renderAutopilotControls();
    }
  }

  function renderAutopilotControls() {
    const button = document.getElementById('slimKillSwitchBtn');
    const attention = document.getElementById('slimAttention');
    const sync = document.getElementById('slimSync');
    if (button) {
      const enabled = autopilotStatus?.outreachEnabled !== false;
      button.textContent = enabled ? '⛔ VERSAND STOPPEN' : '▶ VERSAND AKTIVIEREN';
      button.className = enabled
        ? 'rounded-lg border border-rose-500/40 bg-rose-950/20 px-2 py-1 text-[10px] font-black text-rose-200'
        : 'rounded-lg border border-emerald-500/40 bg-emerald-950/20 px-2 py-1 text-[10px] font-black text-emerald-200';
    }
    if (sync && autopilotStatus) {
      sync.textContent = autopilotStatus.outreachEnabled === false ? 'VERSAND GESTOPPT' : 'SYSTEM AKTIV';
      sync.className = autopilotStatus.outreachEnabled === false
        ? 'text-[10px] font-mono text-rose-300 border border-rose-500/30 bg-rose-950/20 rounded-lg px-2 py-1'
        : 'text-[10px] font-mono text-emerald-300 border border-emerald-500/30 bg-emerald-950/20 rounded-lg px-2 py-1';
    }
    if (attention) {
      const count = Number(autopilotStatus?.ownerAttentionCount || 0);
      attention.classList.toggle('hidden', count === 0);
      attention.textContent = count > 0
        ? `${count} Owner-Ereignis(se): ${autopilotStatus.attentionReason || 'Prüfung erforderlich'} · ${autopilotStatus.attentionCaseId || ''}`
        : '';
    }
  }

  async function toggleKillSwitch() {
    if (!autopilotStatus) return;
    const target = autopilotStatus.outreachEnabled === false;
    const Adapter = globalThis.KF001_OWNER_AUTH?.OwnerAuthAdapter;
    if (!Adapter) return;
    const button = document.getElementById('slimKillSwitchBtn');
    if (button) button.disabled = true;
    try {
      const owner = new Adapter();
      const payload = { outreachEnabled: target };
      const auth = await owner.createAssertion('AUTOPILOT_KILL_SWITCH', payload);
      const response = await fetch(endpoint(config().autopilotKillSwitchPath || '/v1/autopilot/kill-switch'), {
        method: 'POST',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, auth })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `KILL_SWITCH_${response.status}`);
      await refreshAutopilotStatus();
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openActiveCase() {
    if (focusDecisionGate()) return;
    if (typeof globalThis.switchTab === 'function') globalThis.switchTab('cases');
  }

  function openCurrentAction() {
    const register = document.getElementById('registerPasskeyBtn');
    if (register) { register.scrollIntoView({ behavior: 'smooth', block: 'center' }); register.click(); return; }
    const approve = document.getElementById('approveIntentBtn');
    const reject = document.getElementById('rejectIntentBtn');
    if (approve && reject && !approve.disabled) {
      focusDecisionGate();
      return;
    }
    openActiveCase();
  }

  function extractGateValue(label) {
    const gate = document.getElementById('ownerGateContainer');
    if (!gate) return null;
    const labels = [...gate.querySelectorAll('span')];
    const hit = labels.find((el) => el.textContent.trim() === label);
    return hit?.nextElementSibling?.textContent?.trim() || null;
  }

  function refreshSlimView() {
    const shell = document.getElementById('kfSlimOwner');
    if (!shell) return;

    const total = Number(autopilotStatus?.realizedRevenueEur || 0);
    const open = Number(autopilotStatus?.openAmountEur || 0);
    text('slimTotal', money.format(total));
    text('slimOpen', money.format(open));
    text('slimContacts', autopilotStatus == null ? '—' : Number(autopilotStatus.contactsSent || 0));
    text('slimCheckouts', autopilotStatus == null ? '—' : Number(autopilotStatus.checkoutCreated || 0));
    text('slimCheckoutViews', autopilotStatus == null ? '—' : Number(autopilotStatus.checkoutViews || 0));
    text('slimPayments', autopilotStatus == null ? '—' : Number(autopilotStatus.paymentsReceived || 0));
    renderAutopilotControls();

    const gate = document.getElementById('ownerGateContainer');
    const decisionSlot = document.getElementById('slimDecisionSlot');
    if (gate && decisionSlot && gate.parentElement !== decisionSlot) decisionSlot.appendChild(gate);

    const auth = document.getElementById('ownerAuthPanel');
    const authSlot = document.getElementById('slimAuthSlot');
    if (auth && authSlot && auth.parentElement !== authSlot) authSlot.appendChild(auth);
    if (auth) {
      const needsAction = Boolean(auth.querySelector('#registerPasskeyBtn'));
      const verified = auth.dataset.ownerVerified === 'true';
      auth.style.display = needsAction || (!verified && auth.querySelector('#verifyPasskeyBtn') && !hasActiveDecision()) ? '' : 'none';
    }

    const gateText = gate?.textContent || '';
    const workItemState = gate?.dataset.workItemState || 'unavailable';
    const hasActiveWorkItem = workItemState === 'active';
    const caseId = hasActiveWorkItem ? (gate.dataset.workItemCaseId || '—') : '—';
    const caseValue = hasActiveWorkItem ? (extractGateValue('CASE_VALUE_SCORE') || '—') : '—';
    const impact = hasActiveWorkItem ? (extractGateValue('IMPACT-KLASSE') || '—') : '—';
    const status = hasActiveWorkItem ? (gate.dataset.workItemStatus || '—') : '—';
    const version = hasActiveWorkItem ? (gate.dataset.workItemVersion || '—') : '—';
    const updatedAt = hasActiveWorkItem ? (gate.dataset.workItemUpdatedAt || '—') : '—';
    text('slimWorkItemLabel', hasActiveWorkItem
      ? 'ACTIVE WORK ITEM'
      : (workItemState === 'none' ? 'NO ACTIVE WORK ITEM' : 'ACTIVE WORK ITEM UNAVAILABLE'));
    text('slimCaseId', caseId);
    text('slimCaseValue', caseValue);
    text('slimCaseStatus', status);
    text('slimCaseVersion', version);
    text('slimCaseUpdated', updatedAt);
    text('slimPriority', `PRIORITÄT ${impact}`);

    const topCase = document.getElementById('slimTopCase');
    const details = document.getElementById('slimWorkItemDetails');
    const priority = document.getElementById('slimPriority');
    const openCase = document.getElementById('slimOpenCaseBtn');
    if (topCase) {
      topCase.dataset.workItemState = workItemState;
      topCase.tabIndex = hasActiveWorkItem ? 0 : -1;
      topCase.setAttribute('aria-disabled', hasActiveWorkItem ? 'false' : 'true');
      topCase.setAttribute('aria-label', hasActiveWorkItem ? `Active Work Item ${caseId} öffnen` : 'Kein aktives Work Item');
    }
    details?.classList.toggle('hidden', !hasActiveWorkItem);
    priority?.classList.toggle('hidden', !hasActiveWorkItem);
    openCase?.classList.toggle('hidden', !hasActiveWorkItem);
    document.getElementById('slimVersionField')?.classList.toggle('hidden', !gate?.dataset.workItemVersion);
    document.getElementById('slimUpdatedField')?.classList.toggle('hidden', !gate?.dataset.workItemUpdatedAt);

    const action = document.getElementById('slimNextAction');
    const actionBtn = document.getElementById('slimActionBtn');
    if (!action || !actionBtn) return;

    actionBtn.classList.add('hidden');
    if (Number(autopilotStatus?.ownerAttentionCount || 0) > 0) {
      text('slimNextAction', `Owner-Eingriff: ${autopilotStatus.attentionReason || 'Antwort/Zahlung/Risiko'} · ${autopilotStatus.attentionCaseId || ''}`);
      action.className = 'mt-1 text-sm font-bold text-amber-300';
    } else if (document.getElementById('registerPasskeyBtn')) {
      text('slimNextAction', 'Owner-Passkey registrieren, damit Entscheidungen gespeichert werden können.');
      action.className = 'mt-1 text-sm font-bold text-amber-300';
      text('slimActionBtn', 'PASSKEY REGISTRIEREN');
      actionBtn.classList.remove('hidden');
    } else if (gateText.includes('OWNER GATE 1 · LIVE')) {
      text('slimNextAction', 'Owner-Entscheidung fällig: APPROVE oder REJECT.');
      action.className = 'mt-1 text-sm font-bold text-amber-300';
      text('slimActionBtn', 'ENTSCHEIDUNG ÖFFNEN');
      actionBtn.classList.remove('hidden');
    } else if (gateText.includes('DISPATCHED')) {
      text('slimNextAction', 'Outreach versendet. Auf Ergebnis bzw. Zahlung warten.');
      action.className = 'mt-1 text-sm font-bold text-emerald-300';
    } else if (gateText.includes('REJECTED')) {
      text('slimNextAction', 'Keine Aktion: letzter Kandidat wurde abgelehnt.');
      action.className = 'mt-1 text-sm font-bold text-slate-300';
    } else if (gateText.includes('NO QUALIFIED ECONOMIC WINNER') || gateText.includes('keine Owner-Entscheidung')) {
      text('slimNextAction', 'Keine Aktion. Radar sucht im Hintergrund weiter.');
      action.className = 'mt-1 text-sm font-bold text-slate-300';
    } else if (gateText.includes('LOCKED')) {
      text('slimNextAction', 'Owner Gate ist gesperrt. Prüfe Passkey-/Backend-Status.');
      action.className = 'mt-1 text-sm font-bold text-amber-300';
      text('slimActionBtn', 'STATUS ÖFFNEN');
      actionBtn.classList.remove('hidden');
    }
  }

  globalThis.addEventListener('kf001:owner-verified', () => {
    requestAnimationFrame(() => focusDecisionGate());
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installSlimShell, { once: true });
  } else {
    installSlimShell();
  }
})();
