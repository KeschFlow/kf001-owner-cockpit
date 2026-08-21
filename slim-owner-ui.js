(() => {
  'use strict';

  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

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
            <div class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Aktiver Fall</div>
            <div id="slimCaseId" class="mt-1 text-base font-black text-white">—</div>
          </div>
          <div id="slimPriority" class="text-[10px] font-mono text-emerald-300 border border-emerald-500/30 rounded-lg px-2 py-1">PRIORITÄT —</div>
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div class="bg-slate-900 rounded-xl border border-slate-800 p-3"><span class="block text-[9px] text-slate-500 uppercase">Potenzial</span><strong id="slimCaseValue" class="text-white">—</strong></div>
          <div class="bg-slate-900 rounded-xl border border-slate-800 p-3"><span class="block text-[9px] text-slate-500 uppercase">Status</span><strong id="slimCaseStatus" class="text-white">—</strong></div>
        </div>
        <button id="slimOpenCaseBtn" type="button" class="w-full rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm font-black px-4 py-3">FALL ÖFFNEN</button>
      </section>

      <section class="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-300">
        <span class="text-slate-500 uppercase tracking-wider text-[9px]">Geldfluss</span>
        <div class="mt-1 font-mono"><span id="slimTotal">0,00 €</span> realisiert · <span id="slimOpen">—</span> offen · <span id="slimNextMoney">—</span> nächster Eingang</div>
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

    refreshSlimView();
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

  function openActiveCase() {
    const gate = document.getElementById('ownerGateContainer');
    if (gate) {
      gate.scrollIntoView({ behavior: 'smooth', block: 'start' });
      gate.animate?.([{ outline: '2px solid rgba(245,158,11,.9)' }, { outline: '2px solid transparent' }], { duration: 900 });
      return;
    }
    if (typeof globalThis.switchTab === 'function') globalThis.switchTab('cases');
  }

  function openCurrentAction() {
    const register = document.getElementById('registerPasskeyBtn');
    if (register) { register.scrollIntoView({ behavior: 'smooth', block: 'center' }); register.click(); return; }
    const approve = document.getElementById('approveIntentBtn');
    const reject = document.getElementById('rejectIntentBtn');
    if (approve && reject && !approve.disabled) {
      document.getElementById('ownerGateContainer')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    const total = readStoredNumber(['kf001_revenue_total', 'revenue_total']);
    const open = readStoredNumber(['kf001_open_amount', 'open_amount']);
    const next = readStoredNumber(['kf001_next_payment', 'next_payment']);

    text('slimTotal', money.format(total ?? 0));
    text('slimOpen', open == null ? '—' : money.format(open));
    text('slimNextMoney', next == null ? '—' : money.format(next));

    const gate = document.getElementById('ownerGateContainer');
    const decisionSlot = document.getElementById('slimDecisionSlot');
    if (gate && decisionSlot && gate.parentElement !== decisionSlot) decisionSlot.appendChild(gate);

    const auth = document.getElementById('ownerAuthPanel');
    const authSlot = document.getElementById('slimAuthSlot');
    if (auth && authSlot && auth.parentElement !== authSlot) authSlot.appendChild(auth);
    if (auth) {
      const needsAction = Boolean(auth.querySelector('#registerPasskeyBtn') || auth.querySelector('#verifyPasskeyBtn'));
      auth.style.display = needsAction ? '' : 'none';
    }

    const gateText = gate?.textContent || '';
    const caseId = extractGateValue('ANONYMISIERTE CASE-ID') || document.getElementById('gateStateChip')?.dataset?.caseId || '—';
    const caseValue = extractGateValue('CASE_VALUE_SCORE') || '—';
    const impact = extractGateValue('IMPACT-KLASSE') || '—';
    const status = document.getElementById('gateStateChip')?.textContent?.trim() || '—';
    text('slimCaseId', caseId);
    text('slimCaseValue', caseValue);
    text('slimCaseStatus', status);
    text('slimPriority', `PRIORITÄT ${impact}`);

    const action = document.getElementById('slimNextAction');
    const actionBtn = document.getElementById('slimActionBtn');
    if (!action || !actionBtn) return;

    actionBtn.classList.add('hidden');
    if (document.getElementById('registerPasskeyBtn')) {
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installSlimShell, { once: true });
  } else {
    installSlimShell();
  }
})();
