(function correctNoWinnerTruth(global) {
  function applyTruth() {
    const gate = document.getElementById('ownerGateContainer');
    const truth = document.getElementById('gateTruth');
    if (!gate || !truth) return;

    const text = gate.textContent || '';
    const noWinner = text.includes('NO QUALIFIED ECONOMIC WINNER') || text.includes('Kein wirtschaftlich qualifizierter Fall im Owner Gate');
    if (!noWinner) return;

    const nextClass = 'p-3 rounded-xl border bg-amber-950/30 border-amber-500/30 text-amber-200 text-[11px]';
    const nextText = 'CENTRAL READ = LIVE. Kein aktiver Economic Winner. Owner Gate 1 ist deshalb korrekt gesperrt; es liegt derzeit keine Owner-Entscheidung an.';
    if (truth.className !== nextClass) truth.className = nextClass;
    if (truth.textContent !== nextText) truth.textContent = nextText;
  }

  function boot() {
    applyTruth();
    // Governance may render slightly after DOMContentLoaded. Check a few bounded times
    // instead of observing our own DOM writes indefinitely.
    setTimeout(applyTruth, 500);
    setTimeout(applyTruth, 1500);
    setTimeout(applyTruth, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(globalThis);
