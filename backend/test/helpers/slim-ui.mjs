import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../../slim-owner-ui.js', import.meta.url), 'utf8');

// Minimal DOM/event boundary; run the actual UI script and its asynchronous fetches.
export async function loadSlimUi({owner = {noActiveCase: true}, status = {}, assertionError = false} = {}) {
  const elements = new Map();
  class Element {
    constructor(id = '') { this.id = id; this.hidden = false; this.disabled = false; this.textContent = ''; this.listeners = {}; this.children = []; }
    set innerHTML(value) {
      for (const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const el = new Element(match[1]); el.hidden = /\bhidden\b/.test(match[0]); elements.set(el.id, el);
      }
    }
    appendChild(el) { this.children.push(el); if (el.id) elements.set(el.id, el); }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    scrollIntoView() { this.scrolled = true; }
    async click() { if (!this.disabled) await this.listeners.click?.(); }
  }
  const gate = new Element('ownerGateContainer'); elements.set(gate.id, gate);
  let diagnosticClicks = 0;
  const diagnostic = new Element('verifyPasskeyBtn'); diagnostic.addEventListener('click', () => diagnosticClicks++); elements.set(diagnostic.id, diagnostic);
  const calls = [], assertions = [];
  const backendStatus = {realizedRevenueEur: 123.45, openAmountEur: 67.89, outreachEnabled: true, enabled: true, ownerAttentionCount: 0, ...status};
  const document = {readyState: 'complete', head: new Element(), body: new Element(), createElement: () => new Element(), getElementById: id => elements.get(id) || null};
  const context = {
    document, Intl, AbortController, setTimeout, clearTimeout, setInterval() {},
    KF001_CONFIG: {apiBaseUrl: 'https://backend.example'},
    KF001_OWNER_AUTH: {OwnerAuthAdapter: class {
      async createAssertion(action, payload) {
        assertions.push({action, payload}); if (assertionError) throw Error('PASSKEY_DENIED'); return {credential: 'test-assertion'};
      }
    }},
    fetch: async (url, options) => {
      calls.push({url, options});
      if (url.endsWith('/kill-switch')) {
        backendStatus.outreachEnabled = JSON.parse(options.body).outreachEnabled;
        return {ok: true, json: async () => ({})};
      }
      if (url.endsWith('/status')) return {ok: true, json: async () => ({...backendStatus})};
      return owner.noActiveCase
        ? {ok: false, status: 404, json: async () => ({error: 'NO_ACTIVE_CASE'})}
        : {ok: true, status: 200, json: async () => ({...owner})};
    }
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return {get: id => elements.get(id), gate, calls, assertions, get diagnosticClicks() {return diagnosticClicks;}};
}
