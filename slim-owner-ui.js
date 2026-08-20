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

  function metric(label, value, id) {
    return `<div class="bg-slate-950/80 border border-slate-800 rounded-xl p-4 min-w-0">
      <div class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">${label}</div>
      <div id="${id}" class="mt-1 text-xl font-black text-white break-words">${value}</div>
    </div>`;
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
      #kfSlimOwner #ownerGateContainer > .grid { display:none !important; }
      #kfSlimOwner #ownerGateContainer > .p-3.bg-slate-950\/80 { display:none !important; }
      #kfSlimOwner #gateTruth { font-size:11px !important; }
      #kfSlimOwner #ownerAuthPanel { margin-top:12px; }
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
          <h1 class="text-lg font-black text-white">OWNER COCKPIT</h1>
        </div>
        <div id="slimSync" class="text-[10px] font-mono text-emerald-300 border border-emerald-500/30 bg-emerald-950/20 rounded-lg px-2 py-1">SYSTEM AKTIV</div>
      </div>

      <section>
        <div class="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-2">Geldfluss</div>
        <div class="grid grid-cols-2 gap-2">
          ${metric('Einnahmen heute', '0,00 €', 'slimToday')}
          ${metric('Einnahmen kumuliert', '0,00 €', 'slimTotal')}
          ${metric('Offene Beträge', '—', 'slimOpen')}
          ${metric('Nächster Geldeingang', '—', 'slimNextMoney')}
        </div>
      </section>

      <section class="bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
        <div class="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Nächste Aktion</div>
        <div id="slimNextAction" class="mt-1 text-sm font-bold text-amber-300">Systemstatus wird gelesen …</div>
      </section>

      <section id="slimDecisionSlot"></section>
      <section id="slimAuthSlot"></section>

      <details class="border-t border-slate-800 pt-3 text-[10px] text-slate-600">
        <summary class="cursor-pointer select-none">Systemhinweis</summary>
        <p class="mt-2">Radar, Analytics, Musteransichten, Logs und technische Diagnose laufen weiter im Hintergrund. Sie sind aus der Owner-Oberfläche entfernt.</p>
      </details>`;
    document.body.appendChild(shell);

    refreshSlimView();
    const observer = new MutationObserver(refreshSlimView);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function refreshSlimView() {
    const shell = document.getElementById('kfSlimOwner');
    if (!shell) return;

    const today = readStoredNumber(['kf001_revenue_today', 'revenue_today']);
    const total = readStoredNumber(['kf001_revenue_total', 'revenue_total']);
    const open = readStoredNumber(['kf001_open_amount', 'open_amount']);
    const next = readStoredNumber(['kf001_next_payment', 'next_payment']);

    document.getElementById('slimToday').textContent = money.format(today ?? 0);
    document.getElementById('slimTotal').textContent = money.format(total ?? 0);
    document.getElementById('slimOpen').textContent = open == null ? '—' : money.format(open);
    document.getElementById('slimNextMoney').textContent = next == null ? '—' : money.format(next);

    const gate = document.getElementById('ownerGateContainer');
    const decisionSlot = document.getElementById('slimDecisionSlot');
    if (gate && decisionSlot && gate.parentElement !== decisionSlot) decisionSlot.appendChild(gate);

    const auth = document.getElementById('ownerAuthPanel');
    const authSlot = document.getElementById('slimAuthSlot');
    if (auth && authSlot && auth.parentElement !== authSlot) authSlot.appendChild(auth);
    if (auth) {
      const needsAction = Boolean(auth.querySelector('#registerPasskeyBtn'));
      auth.style.display = needsAction ? '' : 'none';
    }

    const gateText = gate?.textContent || '';
    const action = document.getElementById('slimNextAction');
    if (!action) return;
    if (gateText.includes('OWNER GATE 1 · LIVE')) {
      action.textContent = 'Owner-Entscheidung fällig: APPROVE oder REJECT.';
      action.className = 'mt-1 text-sm font-bold text-amber-300';
    } else if (gateText.includes('DISPATCHED')) {
      action.textContent = 'Outreach versendet. Auf Ergebnis bzw. Zahlung warten.';
      action.className = 'mt-1 text-sm font-bold text-emerald-300';
    } else if (gateText.includes('REJECTED')) {
      action.textContent = 'Keine Aktion: letzter Kandidat wurde abgelehnt.';
      action.className = 'mt-1 text-sm font-bold text-slate-300';
    } else if (gateText.includes('NO QUALIFIED ECONOMIC WINNER') || gateText.includes('keine Owner-Entscheidung')) {
      action.textContent = 'Keine Aktion. Radar sucht im Hintergrund weiter.';
      action.className = 'mt-1 text-sm font-bold text-slate-300';
    } else if (gateText.includes('LOCKED')) {
      action.textContent = 'Keine Owner-Entscheidung fällig.';
      action.className = 'mt-1 text-sm font-bold text-slate-300';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installSlimShell, { once: true });
  } else {
    installSlimShell();
  }
})();
