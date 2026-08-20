(function correctNoWinnerTruth(global) {
  function applyTruth() {
    const gate = document.getElementById('ownerGateContainer');
    const truth = document.getElementById('gateTruth');
    if (!gate || !truth) return;

    const text = gate.textContent || '';
    const noWinner = text.includes('NO QUALIFIED ECONOMIC WINNER') || text.includes('Kein wirtschaftlich qualifizierter Fall im Owner Gate');
    if (!noWinner) return;

    truth.className = 'p-3 rounded-xl border bg-amber-950/30 border-amber-500/30 text-amber-200 text-[11px]';
    truth.textContent = 'CENTRAL READ = LIVE. Kein aktiver Economic Winner. Owner Gate 1 ist deshalb korrekt gesperrt; es liegt derzeit keine Owner-Entscheidung an.';
  }

  const observer = new MutationObserver(applyTruth);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyTruth();
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, { once: true });
  } else {
    applyTruth();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
})(globalThis);
