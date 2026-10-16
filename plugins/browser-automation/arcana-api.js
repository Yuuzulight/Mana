const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

async function json(response) {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message || `Arcana API returned HTTP ${response.status}`);
  return value;
}

class ArcanaApiClient {
  constructor(endpoint, token) { this.endpoint = endpoint.endsWith('/') ? endpoint : `${endpoint}/`; this.token = token; }
  async request(route, options = {}) {
    const headers = { Authorization: `Bearer ${this.token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    return json(await fetch(new URL(route.replace(/^\//, ''), this.endpoint), { ...options, headers }));
  }
  get(route) { return this.request(route); }
  post(route, body) { return this.request(route, { method: 'POST', body: JSON.stringify(body || {}) }); }
  async bytes(route) {
    const response = await fetch(new URL(route.replace(/^\//, ''), this.endpoint), { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`Arcana API returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

function functionExpression(fn, arg) {
  if (typeof fn === 'string') return fn;
  if (typeof fn !== 'function') throw new TypeError('Arcana evaluate expects a function or expression');
  return `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
}

class ArcanaLocator {
  constructor(page, ref) { this.page = page; this.ref = ref; }
  click() { return this.page._action('click', { ref: this.page._resolveRef(this.ref) }); }
  fill(value) { return this.page._action('fill', { ref: this.page._resolveRef(this.ref), value: String(value ?? '') }); }
  selectOption(value) { return this.page._action('select', { ref: this.page._resolveRef(this.ref), value: typeof value === 'string' ? value : value?.value }); }
  press(key) { return this.page._action('press', { ref: this.page._resolveRef(this.ref), key }); }
  hover() { return this.page.evaluate((ref) => document.querySelector(`[aria-ref="${ref}"]`)?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })), this.page._resolveRef(this.ref)); }
  evaluate(fn, arg) {
    const source = typeof fn === 'function' ? fn.toString() : String(fn);
    return this.page.evaluate(`(${source})(document.querySelector('[aria-ref="${this.page._resolveRef(this.ref)}"]'), ${arg === undefined ? 'undefined' : JSON.stringify(arg)})`);
  }
  boundingBox() { return this.page.evaluate((ref) => { const r = document.querySelector(`[aria-ref="${ref}"]`)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; }, this.page._resolveRef(this.ref)); }
  setInputFiles(file) { return this.page._action('upload', { ref: this.page._resolveRef(this.ref), path: Array.isArray(file) ? file[0] : file }); }
  dragTo() { throw new Error('Arcana API drag is not available in v1 yet'); }
}

class ArcanaApiPage {
  constructor(client, id) { this.client = client; this.id = id; this.listeners = new Map(); this.refs = new Map(); this.routes = []; this.mouse = { move: async () => {}, click: (x, y) => this._action('click-at', { x, y }), wheel: (x, y) => this._action('mouse-wheel', { deltaX: x, deltaY: y }) }; this.keyboard = { insertText: text => this._action('type', { value: text }), press: key => this._action('key', { key }) }; }
  on(event, listener) { this.listeners.set(event, listener); }
  async _connectEvents() {
    const url = new URL(`v1/events?pageId=${this.id}`, this.client.endpoint); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.events = new WebSocket(url, { headers: { Authorization: `Bearer ${this.client.token}` } });
    await new Promise((resolve, reject) => { this.events.addEventListener('open', resolve, { once: true }); this.events.addEventListener('error', reject, { once: true }); });
    this.events.addEventListener('message', ({ data }) => { try { this._event(JSON.parse(String(data))); } catch {} });
  }
  _event(message) {
    const data = message.data || {};
    if (message.name === 'Runtime.consoleAPICalled') this.listeners.get('console')?.({ type: () => data.type || 'log', text: () => (data.args || []).map(arg => arg.value ?? '').join(' ') });
    if (message.name === 'Runtime.exceptionThrown') this.listeners.get('pageerror')?.(new Error(data.exceptionDetails?.text || 'Page exception'));
    if (message.name === 'Page.frameNavigated') this.listeners.get('framenavigated')?.(this);
    if (message.name === 'Fetch.requestPaused') this._route(data).catch(() => {});
  }
  async _route(data) {
    const url = data.request?.url || '';
    const route = this.routes.find(item => item.pattern === '**/*' || item.pattern === '*' || url.includes(item.pattern.replace(/^\*\*/, '')));
    const api = { request: () => ({ url: () => url, method: () => data.request?.method || 'GET', resourceType: () => data.resourceType || 'Other' }), abort: () => this.client.post(`v1/pages/${this.id}/cdp`, { method: 'Fetch.failRequest', parameters: { requestId: data.requestId, errorReason: 'Aborted' } }), continue: () => this.client.post(`v1/pages/${this.id}/cdp`, { method: 'Fetch.continueRequest', parameters: { requestId: data.requestId } }) };
    if (route) await route.handler(api); else await api.continue();
  }
  mainFrame() { return this; }
  async _action(name, body) { return this.client.post(`v1/pages/${this.id}/${name}`, body); }
  _resolveRef(ref) { const key = String(ref).replace(/^aria-ref=/, ''); return this.refs.get(key) || key; }
  async _snapshot() { const snapshot = await this.client.get(`v1/pages/${this.id}/snapshot`); this.refs.clear(); for (const element of snapshot.elements || []) { const short = `e${this.refs.size + 1}`; this.refs.set(short, element.reference); } return snapshot; }
  async goto(url) { await this._action('navigate', { url }); return this; }
  async waitForLoadState(state = 'load', options = {}) {
    if (state === 'networkidle') return this._action('wait', { condition: 'networkidle', value: '', timeoutMs: options.timeout || 10000 });
    if (state === 'domcontentloaded') return this._action('wait', { condition: 'expression', value: "document.readyState !== 'loading'", timeoutMs: options.timeout || 10000 });
    return this._action('wait', { condition: 'expression', value: "document.readyState === 'complete'", timeoutMs: options.timeout || 10000 });
  }
  async goBack() { await this._action('back'); }
  async goForward() { await this._action('forward'); }
  async close() { this.events?.close(); await this.client.request(`v1/pages/${this.id}`, { method: 'DELETE' }); this.closed = true; }
  isClosed() { return Boolean(this.closed); }
  async ariaSnapshot() { const snapshot = await this._snapshot(); return (snapshot.elements || []).map((e, i) => `- ${e.role === 'input' ? 'textbox' : e.role} "${String(e.name || '').replaceAll('"', '\\"')}" [ref=e${i + 1}]`).join('\n'); }
  async evaluate(fn, arg) { return this.client.post(`v1/pages/${this.id}/evaluate`, { expression: functionExpression(fn, arg) }); }
  async title() { return (await this._snapshot()).title; }
  async url() { return (await this._snapshot()).url; }
  locator(selector) { const match = /^aria-ref=(.+)$/.exec(selector); if (!match) throw new Error('Arcana v1 locators require an aria-ref selector'); return new ArcanaLocator(this, match[1]); }
  async screenshot(options = {}) { const format = options.type === 'jpeg' ? 'jpeg' : 'png'; const query = `v1/pages/${this.id}/screenshot?format=${format}${options.quality ? `&quality=${options.quality}` : ''}`; return this.client.bytes(query); }
  viewportSize() { return { width: 1280, height: 720 }; }
  async setViewportSize(size) { await this._action('viewport', size); }
  async emulateMedia() { /* v1 keeps the engine default media scheme */ }
  async route(pattern, handler) { this.routes.push({ pattern, handler }); await this.client.post(`v1/pages/${this.id}/cdp`, { method: 'Fetch.enable', parameters: { patterns: [{ urlPattern: '*' }] } }); }
  async waitForEvent() { throw new Error('Arcana v1 does not expose file chooser events'); }
  request = { head: async (url) => ({ status: () => 200, url: () => url }) };
}

class ArcanaApiContext {
  constructor(client, child, profileDirectory) { this.client = client; this.child = child; this.profileDirectory = profileDirectory; this._pages = []; this.listeners = new Map(); }
  pages() { return this._pages.filter(page => !page.closed); }
  async newPage() { const created = await this.client.post('v1/pages', {}); const page = new ArcanaApiPage(this.client, created.pageId); await page._connectEvents(); this._pages.push(page); return page; }
  on(event, listener) { this.listeners.set(event, listener); }
  async cookies() { return (await this.client.get(`v1/pages/${this.pages()[0]?.id}/cookies`)).cookies || []; }
  async close() {
    try {
      const page = this.pages()[0];
      if (page && this.profileDirectory) {
        const cookies = await this.cookies().catch(() => []);
        const pending = path.join(this.profileDirectory, `.env.arcana-state-${randomBytes(8).toString('hex')}`);
        fs.writeFileSync(pending, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
        fs.renameSync(pending, path.join(this.profileDirectory, 'credentials.json'));
      }
    } finally {
      await Promise.allSettled(this.pages().map(page => page.close()));
      if (this.child.exitCode == null) this.child.kill();
      this.listeners.get('close')?.();
    }
  }
}

function createArcanaApiBrowserType({ env = process.env }) {
  return {
    async launchPersistentContext(profileDirectory, options = {}) {
      if (!path.isAbsolute(profileDirectory)) throw new Error('Arcana profile directory must be absolute');
      fs.mkdirSync(profileDirectory, { recursive: true });
      const token = randomBytes(32).toString('hex');
      const executable = options.executablePath;
      const args = /\.dll$/i.test(executable) ? [executable] : [];
      args.push('api', '--profile=' + profileDirectory, '--token=' + token, '--port=0');
      if (env.MANA_ARCANA_ALLOW_PRIVATE_NETWORK === '1') args.push('--allow-private-network');
      const child = spawn(/\.dll$/i.test(executable) ? (env.MANA_DOTNET_PATH || 'dotnet') : executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let ready = null; let diagnostics = '';
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
      const deadline = Date.now() + 20000;
      let buffer = '';
      while (!ready) {
        if (child.exitCode !== null) throw new Error(`Arcana API exited during startup: ${diagnostics}`);
        if (Date.now() >= deadline) { child.kill(); throw new Error('Arcana API did not publish its endpoint within 20 seconds'); }
        const line = await Promise.race([once(child.stdout, 'data').then(([chunk]) => { buffer += chunk.toString(); }), delay(25)]);
        const first = buffer.split(/\r?\n/).find(Boolean);
        if (first) { try { ready = JSON.parse(first); } catch {} }
      }
      const context = new ArcanaApiContext(new ArcanaApiClient(ready.endpoint, ready.token), child, profileDirectory);
      const initial = await context.newPage();
      context._pages = [initial];
      return context;
    },
  };
}

module.exports = { createArcanaApiBrowserType };
