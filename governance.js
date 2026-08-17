const {
  CaseStoreAdapter: KFCaseStoreAdapter,
  NotificationAdapter: KFNotificationAdapter,
  OutreachAdapter: KFOutreachAdapter,
  EvidenceAdapter: KFEvidenceAdapter
} = globalThis.KF001_ADAPTERS;

const caseStore = new KFCaseStoreAdapter();
const notifications = new KFNotificationAdapter();
const outreach = new KFOutreachAdapter(caseStore);
const evidence = new KFEvidenceAdapter();
let ownerState;

const yesNo = (value) => value ? 'YES' : 'NO';
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

function statusCard(label, live, detail) {
  const color = live ? 'emerald' : 'amber';
  return `<div class="bg-slate-950/80 p-3 rounded-xl border border-${color}-500/30">
    <span class="block text-[10px] text-slate-400 font-mono">${label}</span>
    <span class="font-black text-${color}-300 text-xs">${live ? 'LIVE' : 'NOT LIVE'}</span>
    <span class="block text-[10px] text-slate-500 mt-1">${detail}</span>
  </div>`;
}

function renderSystemStatus() {
  let panel = document.getElementById('governanceStatus');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'governanceStatus';
    document.getElementById('ownerGateContainer').before(panel);
  }
  panel.className = 'bg-slate-800/80 p-4 rounded-2xl border border-slate-700/70 shadow-sm space-y-3';
  panel.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <div><h2 class="font-extrabold text-white text-sm">PUBLIC VIEW ↔ PRIVATE OWNER STATE</h2>
      <p class="text-[11px] text-slate-400">Öffentlich: ausschließlich anonymisierte Anzeige. Privater Zustand: über sicheren Backend-Adapter, sobald konfiguriert.</p></div>
      <span class="text-[10px] font-mono px-2 py-1 rounded bg-slate-950 text-amber-300 border border-amber-500/30">STATE SOURCE: ${esc(ownerState.stateSource)}</span>
    </div>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
      ${statusCard('OWNER UI', true, 'Öffentliche PWA')}
      ${statusCard('CENTRAL BACKEND', caseStore.centralBackendConnected && ownerState.isSourceOfTruth, `CONNECTED = ${yesNo(caseStore.centralBackendConnected && ownerState.isSourceOfTruth)}`)}
      ${statusCard('REAL PUSH', notifications.pushBackendConnected, `PUSH_BACKEND_CONNECTED = ${yesNo(notifications.pushBackendConnected)}`)}
      ${statusCard('REAL OUTREACH DISPATCH', outreach.realDispatchConnected, `CONNECTED = ${yesNo(outreach.realDispatchConnected)}`)}
    </div>`;
}

function renderOwnerGate() {
  const container = document.getElementById('ownerGateContainer');
  const central = ownerState.isSourceOfTruth;
  container.className = 'bg-gradient-to-br from-amber-950/40 via-slate-800 to-slate-900 p-4 sm:p-5 rounded-2xl border border-amber-500/40 shadow-lg space-y-4';
  container.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 pb-3">
      <span class="px-2.5 py-1 rounded-md text-xs font-black bg-amber-500/20 text-amber-300 border border-amber-500/40">OWNER GATE 1 · LIVE</span>
      <span id="gateStateChip" class="text-[10px] font-mono text-amber-300 bg-slate-950 px-2 py-1 rounded border border-amber-500/30">${esc(ownerState.status)}</span>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
      ${field('ANONYMISIERTE CASE-ID', ownerState.caseId)}
      ${field('CASE_VALUE_SCORE', typeof ownerState.caseValueScore === 'number' ? `${ownerState.caseValueScore}/100` : ownerState.caseValueScore)}
      ${field('OUTREACH_READY', yesNo(ownerState.outreachReady))}
      ${field('IMPACT-KLASSE', ownerState.impactClass)}
      ${field('EVIDENCE-QUALITÄT', ownerState.evidenceQuality)}
      ${field('SYSTEM-EMPFEHLUNG', ownerState.recommendation)}
    </div>
    <div class="p-3 bg-slate-950/80 rounded-xl border border-slate-700">
      <span class="block text-[10px] text-slate-400 font-mono mb-1">VORBEREITETE OUTREACH-NACHRICHT · ÖFFENTLICH ABSTRAHIERT</span>
      <p class="text-xs text-slate-200 leading-relaxed">${esc(ownerState.outreachMessage)}</p>
    </div>
    <div id="gateTruth" class="p-3 rounded-xl border ${central ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200' : 'bg-amber-950/30 border-amber-500/30 text-amber-200'} text-[11px]">
      ${central ? 'Entscheidungen werden als Approval-Intent an den zentralen Backend-Adapter gesendet.' : 'CENTRAL BACKEND = NO. Entscheidungen werden nur im lokalen Cache vorgemerkt und sind NICHT zentral synchronisiert. APPROVE löst KEINEN Versand aus.'}
    </div>
    <div id="gateActionButtons" class="grid grid-cols-2 gap-2">
      <button id="approveIntentBtn" class="py-3 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg shadow transition-all">✅ APPROVE</button>
      <button id="rejectIntentBtn" class="py-3 px-3 bg-rose-600/30 hover:bg-rose-600/50 text-rose-300 font-bold text-xs rounded-lg border border-rose-500/40 transition-all">🛑 REJECT</button>
    </div>`;
  document.getElementById('approveIntentBtn').addEventListener('click', () => decide('APPROVE'));
  document.getElementById('rejectIntentBtn').addEventListener('click', () => decide('REJECT'));
}

function field(label, value) {
  return `<div class="bg-slate-950/80 p-3 rounded-xl border border-slate-700/80 min-w-0"><span class="block text-[9px] text-slate-400 font-mono">${label}</span><span class="block text-xs font-bold text-white mt-1 break-words">${esc(value)}</span></div>`;
}

async function decide(decision) {
  const buttons = document.getElementById('gateActionButtons');
  buttons.querySelectorAll('button').forEach((button) => { button.disabled = true; button.classList.add('opacity-50'); });
  try {
    const result = await outreach.submitApprovalIntent({ caseId: ownerState.caseId, decision, version: ownerState.version });
    ownerState = { ...ownerState, ...result };
    const truth = document.getElementById('gateTruth');
    document.getElementById('gateStateChip').textContent = result.status;
    truth.className = `p-3 rounded-xl border text-[11px] ${result.centralState ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200' : 'bg-amber-950/30 border-amber-500/30 text-amber-200'}`;
    truth.textContent = result.centralState
      ? `Approval-Intent zentral gespeichert. Status: ${result.status}. Ein Versand wurde durch den Client nicht ausgeführt.`
      : `LOKALER CACHE/FALLBACK – NICHT SOURCE OF TRUTH. Status: ${result.status}. NOT_SYNCED. Kein serverseitiger Versand ausgeführt.`;
    addLog(`OWNER GATE 1: ${decision} → ${result.status}; SOURCE=${result.stateSource}; DISPATCH_EXECUTED=NO`, result.centralState ? 'SYNCED' : 'NOT_SYNCED');
    renderSystemStatus();
  } catch (error) {
    document.getElementById('gateTruth').textContent = `Entscheidung nicht gespeichert: ${error.message}`;
  } finally {
    buttons.querySelectorAll('button').forEach((button) => { button.disabled = false; button.classList.remove('opacity-50'); });
  }
}

function addLog(message, status) {
  const feed = document.getElementById('systemLogFeed');
  if (!feed) return;
  const row = document.createElement('div');
  row.className = 'p-2 bg-slate-900/80 rounded border border-slate-800 text-slate-300 flex justify-between gap-2';
  const text = document.createElement('span');
  text.textContent = `[${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}] ${message}`;
  const chip = document.createElement('span');
  chip.className = 'font-bold text-amber-300';
  chip.textContent = status;
  row.append(text, chip);
  feed.prepend(row);
}

function renderPreparedSystems() {
  const gate = document.getElementById('ownerGateContainer');
  let section = document.getElementById('preparedGovernanceSystems');
  if (!section) {
    section = document.createElement('section');
    section.id = 'preparedGovernanceSystems';
    gate.after(section);
  }
  section.className = 'grid grid-cols-1 lg:grid-cols-2 gap-4';
  section.innerHTML = `
    <div class="bg-slate-800/80 p-4 rounded-2xl border border-slate-700/70 space-y-3">
      <div class="flex justify-between gap-2"><h3 class="font-bold text-white text-sm">Notifications</h3><span class="text-[10px] font-mono text-amber-300">PUSH_BACKEND_CONNECTED = ${yesNo(notifications.pushBackendConnected)}</span></div>
      <p class="text-[11px] text-slate-400">Permission: <span id="notificationPermission" class="font-mono text-white">${esc(notifications.permission())}</span>. Lokale Meldungen sind ausschließlich als TEST erlaubt.</p>
      <div class="flex flex-wrap gap-2"><button id="permissionBtn" class="px-3 py-2 rounded-lg bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 text-xs font-bold">Berechtigung anfragen</button><button id="testNotificationBtn" class="px-3 py-2 rounded-lg bg-slate-950 border border-slate-600 text-slate-200 text-xs font-bold">[TEST] lokale Notification</button></div>
      <p id="notificationResult" class="text-[10px] text-slate-500"></p>
    </div>
    <div class="bg-slate-800/80 p-4 rounded-2xl border border-slate-700/70 space-y-3">
      <div class="flex justify-between gap-2"><h3 class="font-bold text-white text-sm">Owner Gate 2 · vorbereitet</h3><span class="text-[10px] font-mono text-slate-400">NOT ACTIVE</span></div>
      <p class="text-[11px] text-slate-400">Evidence Intake und Eskalation bleiben deaktiviert, bis ein privater Backend-Workflow angebunden ist.</p>
      <label class="block text-[10px] text-slate-300">Lokale Datei nur für echte SHA-256-Prüfung<input id="evidenceFile" type="file" class="block w-full mt-1 text-[10px] text-slate-400 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-slate-700 file:text-white"></label>
      <div class="font-mono text-[10px] break-all"><span class="text-slate-400">HASH_STATUS = </span><span id="hashStatus" class="text-amber-300">NOT_AVAILABLE</span><div id="hashValue" class="text-slate-300 mt-1"></div></div>
    </div>`;
  document.getElementById('permissionBtn').addEventListener('click', requestNotificationPermission);
  document.getElementById('testNotificationBtn').addEventListener('click', testNotification);
  document.getElementById('evidenceFile').addEventListener('change', hashSelectedEvidence);
}

async function requestNotificationPermission() {
  const result = await notifications.requestPermission();
  document.getElementById('notificationPermission').textContent = result;
  document.getElementById('notificationResult').textContent = `Notification Permission = ${result}. REAL PUSH bleibt ${notifications.pushBackendConnected ? 'LIVE' : 'NOT LIVE'}.`;
}

async function testNotification() {
  const output = document.getElementById('notificationResult');
  try {
    await notifications.showLocalTest();
    output.textContent = '[TEST] Lokale Notification ausgelöst. Kein Radar-Event.';
  } catch (error) {
    output.textContent = `[TEST] Nicht ausgelöst: ${error.message}`;
  }
}

async function hashSelectedEvidence(event) {
  const result = await evidence.hashFile(event.target.files[0]);
  document.getElementById('hashStatus').textContent = result.hashStatus;
  document.getElementById('hashValue').textContent = result.sha256 ? `SHA-256: ${result.sha256} · LOCAL ONLY · NOT UPLOADED` : '';
}

function retireDemoControls() {
  const demoButton = document.getElementById('simRevenueBtn');
  if (demoButton) demoButton.remove();
  const subtitle = document.getElementById('sbSubtitle');
  if (subtitle) subtitle.textContent = '[ÖFFENTLICHE ANSICHT · ANONYMISIERT · KEIN CENTRAL STATE]';
  const version = document.querySelector('header h1 + span');
  if (version) version.textContent = 'v1.4 PUBLIC GOVERNANCE';
}

async function initGovernance() {
  retireDemoControls();
  ownerState = await caseStore.loadOwnerState();
  renderSystemStatus();
  renderOwnerGate();
  renderPreparedSystems();
  addLog(`GOVERNANCE UI: OWNER GATE 1 LIVE; CENTRAL_BACKEND=${yesNo(ownerState.isSourceOfTruth)}; REAL_PUSH=${yesNo(notifications.pushBackendConnected)}; REAL_DISPATCH=${yesNo(outreach.realDispatchConnected)}`, 'TRUTHFUL');
  globalThis.KF001_GOVERNANCE_LOADED = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGovernance, { once: true });
} else {
  initGovernance();
}

