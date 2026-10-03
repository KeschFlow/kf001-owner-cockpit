(() => {
  'use strict';

  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const config = () => globalThis.KF001_CONFIG || {};
  const endpoint = (path) => `${String(config().apiBaseUrl || '').replace(/\/$/, '')}${path}`;

  let autopilotStatus = null;
  let ownerSnapshot = null;
  let statusError = null;

  function text(id, value) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(value)) el.textContent = value;
  }

  function installShell() {
    if (document.getElementById('kfSlimOwner')) return;

    const style = document.createElement('style');
    style.textContent = `
      body > header, body > main, body > nav { display:none !important; }
      #kfSlimOwner { display:block !important; min-height:100vh; }
      #slimDecisionRuntime[hidden], #slimIntervention[hidden], #slimControls[hidden] { display:none !important; }
      #slimDecisionRuntime #ownerGateContainer { margin:0 !important; }
      #slimDecisionRuntime #ownerGateContainer > .grid:not(#gateActionButtons),
      #slimDecisionRuntime #ownerGateContainer > .p-3.bg-slate-950\\/80 { display:none !important; }
      #slimDecisionRuntime #gateActionButtons { display:grid !important; }
      #slimDecisionRuntime #gateActionButtons button { min-height:52px; touch-action:manipulation; }
      button { touch-action:manipulation; }
    `;
    document.head.appendChild(style);

    const shell = document.createElement('div');
    shell.id = 'kfSlimOwner';
    shell.className = 'max-w-xl mx-auto px-4 py-7 text-slate-100';
    shell.innerHTML = `
      <header class="flex items-center justify-between gap-3 border-b border-slate-800 pb-5">
        <div>
          <div class="text-[10px] text-slate-500 font-mono tracking-[.22em]">KF001</div>
          <h1 class="text-xl font-black text-white mt-1">FALLRADAR</h1>
        </div>
        <div id="slimSystem" class="text-[10px] font-mono rounded-xl border border-slate-700 px-3 py-2 text-slate-400">VERBINDET …</div>
      </header>

      <main class="py-8 space-y-5">
        <section class="rounded-3xl border border-emerald-500/30 bg-slate-950/70 p-6">
          <div class="text-[10px] uppercase tracking-[.18em] text-slate-500 font-bold">Einnahmen</div>
          <div id="slimRevenue" class="mt-3 text-4xl sm:text-5xl font-black tracking-tight text-white">0,00 €</div>
          <div class="mt-3 text-sm text-slate-500">realisiert</div>
          <div class="mt-5 pt-4 border-t border-slate-800 flex items-center justify-between text-sm">
            <span class="text-slate-500">Offen</span>
            <strong id="slimOpenRevenue" class="text-slate-200">0,00 €</strong>
          </div>
        </section>

        <section id="slimNoAction" class="rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
          <div class="text-[10px] uppercase tracking-[.18em] text-slate-500 font-bold">Status</div>
          <div id="slimNoActionText" class="mt-2 text-base font-bold text-emerald-300">Keine Aktion nötig.</div>
          <div class="mt-1 text-xs text-slate-500">Radar, Qualifizierung, Kontakt, Checkout und Zahlungsverbuchung laufen im Hintergrund.</div>
        </section>

        <section id="slimIntervention" hidden class="rounded-2xl border border-amber-500/40 bg-amber-950/15 p-5">
          <div class="text-[10px] uppercase tracking-[.18em] text-amber-400 font-bold">Eingriff erforderlich</div>
          <div id="slimInterventionText" class="mt-2 text-base font-black text-white">Owner-Entscheidung erforderlich.</div>
          <button id="slimInterventionBtn" type="button" class="mt-4 w-full rounded-xl bg-indigo-600 text-white font-black px-4 py-4">ÖFFNEN</button>
        </section>

        <section id="slimDecisionRuntime" hidden class="rounded-2xl border border-amber-500/30 bg-slate-950/60 p-3"></section>

        <details class="pt-3 text-xs text-slate-600">
          <summary class="cursor-pointer select-none">Systemsteuerung</summary>
          <div class="mt-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-3">
            <div id="slimTechnicalStatus">Status wird geladen …</div>
            <button id="slimControlBtn" type="button" class="w-full rounded-lg border border-slate-700 px-3 py-3 font-bold text-slate-300">VERSANDSTATUS LADEN</button>
          </div>
        </details>
      </main>`;

    document.body.appendChild(shell);

    const gate = document.getElementById('ownerGateContainer');
    const runtime = document.getElementById('slimDecisionRuntime');
    if (gate && runtime) runtime.appendChild(gate);

    document.getElementById('slimInterventionBtn')?.addEventListener('click', () => {
      if (!runtime) return;
      runtime.hidden = false;
      runtime.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.getElementById('slimControlBtn')?.addEventListener('click', toggleOutreach);

    refreshAll();
    setInterval(refreshAll, 30000);
  }

  async function loadAutopilotStatus() {
    const path = config().autopilotStatusPath || '/v1/autopilot/status';
    if (!config().apiBaseUrl) throw new Error('NO_API_BASE');
    const response = await fetch(endpoint(path), {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `AUTOPILOT_STATUS_${response.status}`);
    autopilotStatus = body;
  }

  async function loadOwnerSnapshot() {
    const path = config().ownerStatePath || '/v1/owner-state';
    if (!config().apiBaseUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(endpoint(path), {
        cache: 'no-store',
        credentials: config().ownerStateCredentials || 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      ownerSnapshot = response.status === 404 && body.error === 'NO_ACTIVE_CASE'
        ? { noActiveCase: true }
        : response.ok
          ? body
          : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshAll() {
    try {
      await Promise.all([loadAutopilotStatus(), loadOwnerSnapshot()]);
      statusError = null;
    } catch (error) {
      statusError = error?.message || 'STATUS_FAILED';
    }
    render();
  }

  function render() {
    const realized = Number(autopilotStatus?.realizedRevenueEur || 0);
    const open = Number(autopilotStatus?.openAmountEur || 0);
    text('slimRevenue', money.format(realized));
    text('slimOpenRevenue', money.format(open));

    const system = document.getElementById('slimSystem');
    const outreachEnabled = autopilotStatus?.outreachEnabled !== false;
    if (system) {
      if (statusError) {
        system.textContent = 'VERBINDUNG PRÜFEN';
        system.className = 'text-[10px] font-mono rounded-xl border border-rose-500/40 px-3 py-2 text-rose-300';
      } else if (!outreachEnabled) {
        system.textContent = 'VERSAND GESTOPPT';
        system.className = 'text-[10px] font-mono rounded-xl border border-rose-500/40 px-3 py-2 text-rose-300';
      } else {
        system.textContent = 'SYSTEM AKTIV';
        system.className = 'text-[10px] font-mono rounded-xl border border-emerald-500/40 px-3 py-2 text-emerald-300';
      }
    }

    const intervention = document.getElementById('slimIntervention');
    const noAction = document.getElementById('slimNoAction');
    const pendingDecision = Boolean(ownerSnapshot?.caseId && ['PENDING_APPROVAL', 'APPROVED_PENDING_DISPATCH'].includes(ownerSnapshot?.status));
    const attentionCount = Number(autopilotStatus?.ownerAttentionCount || 0);
    const needsIntervention = Boolean(statusError || !outreachEnabled || pendingDecision || attentionCount > 0);

    if (intervention) intervention.hidden = !needsIntervention;
    if (noAction) noAction.hidden = needsIntervention;

    if (needsIntervention) {
      const reason = statusError
        ? `Systemstatus nicht erreichbar: ${statusError}`
        : !outreachEnabled
          ? 'Versand ist gestoppt.'
          : pendingDecision
            ? `Owner-Entscheidung für ${ownerSnapshot.caseId} erforderlich.`
            : autopilotStatus?.attentionReason || 'Prüfung erforderlich.';
      text('slimInterventionText', reason);
    }

    const technical = statusError
      ? `Backend: ${statusError}`
      : `Autopilot: ${autopilotStatus?.enabled === false ? 'AUS' : 'AN'} · Outreach: ${outreachEnabled ? 'AN' : 'AUS'}`;
    text('slimTechnicalStatus', technical);

    const control = document.getElementById('slimControlBtn');
    if (control) {
      control.textContent = outreachEnabled ? 'VERSAND STOPPEN' : 'VERSAND AKTIVIEREN';
      control.className = outreachEnabled
        ? 'w-full rounded-lg border border-rose-500/40 px-3 py-3 font-bold text-rose-300'
        : 'w-full rounded-lg border border-emerald-500/40 px-3 py-3 font-bold text-emerald-300';
    }
  }

  async function toggleOutreach() {
    if (!autopilotStatus) return;
    const Adapter = globalThis.KF001_OWNER_AUTH?.OwnerAuthAdapter;
    if (!Adapter) return;
    const target = autopilotStatus.outreachEnabled === false;
    const button = document.getElementById('slimControlBtn');
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
      await refreshAll();
    } catch (error) {
      statusError = error?.message || 'CONTROL_FAILED';
      render();
    } finally {
      if (button) button.disabled = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installShell, { once:true });
  } else {
    installShell();
  }
})();
