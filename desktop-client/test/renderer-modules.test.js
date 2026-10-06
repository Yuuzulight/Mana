const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', 'renderer');
const modules = {
  'core.js': ['ManaVoiceCore', 'createVoiceCore'],
  'voice-playback.js': ['ManaVoicePlayback', 'createVoicePlayback'],
  'chat-history.js': ['ManaChatHistory', 'createChatHistory'],
  'settings.js': ['ManaDesktopSettings', 'createDesktopSettings'],
  'plugins.js': ['ManaPlugins', 'createPluginsUI'],
  'ui.js': ['ManaDesktopUI', 'createDesktopUI'],
};

test('launcher loads each isolated controller before renderer without Node integration', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index_fixed.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
  const sandbox = vm.createContext({ window: {} });
  for (const [file, [global, factory]] of Object.entries(modules)) {
    assert.equal(scripts.filter(src => src === file).length, 1);
    assert.ok(scripts.indexOf(file) < scripts.indexOf('renderer.js'));
    vm.runInContext(fs.readFileSync(path.join(rendererDir, file), 'utf8'), sandbox, { filename: file });
    assert.equal(typeof sandbox.window[global][factory], 'function');
    // Construction must not read late-bound renderer state or acquire resources.
    const context = new Proxy({}, { get() { throw new Error('eager state read'); } });
    assert.ok(sandbox.window[global][factory](context));
  }
});

function load(file, globals = {}) {
  const sandbox = vm.createContext({ window: {}, ...globals });
  vm.runInContext(fs.readFileSync(path.join(rendererDir, file), 'utf8'), sandbox);
  return sandbox;
}

test('history updates shared session state and keeps markdown rendering in the safe preload API', () => {
  const values = new Map();
  const box = { appendChild(node) { this.child = node; }, scrollHeight: 12 };
  const sandbox = load('chat-history.js', {
    localStorage: { setItem: (key, value) => values.set(key, value) },
    document: { createElement: () => ({}) },
  });
  sandbox.window.crypto = { randomUUID: () => 'new-session' };
  sandbox.window.electronAPI = {
    renderMarkdownToSafeHtml: text => `safe:${text}`,
    extractArtifact: () => null,
  };
  let session = null;
  const context = {
    get currentSessionId() { return session; },
    set currentSessionId(value) { session = value; },
    SESSION_STORAGE_KEY: 'session', messagesEl: box, sessionArtifacts: [],
  };
  const history = sandbox.window.ManaChatHistory.createChatHistory(context);
  assert.equal(history.ensureSessionId(), 'new-session');
  assert.equal(values.get('session'), 'new-session');
  session = 'changed-outside-module';
  assert.equal(history.ensureSessionId(), session);
  history.appendMessage('assistant', 'hello');
  assert.equal(box.child.innerHTML, 'safe:hello');
  assert.equal(box.scrollTop, 12);
});

test('voice playback stop invalidates the live token rather than a state snapshot', () => {
  const sandbox = load('voice-playback.js');
  let token = 2;
  const playback = sandbox.window.ManaVoicePlayback.createVoicePlayback({
    get desktopReplyPlaybackToken() { return token; },
    set desktopReplyPlaybackToken(value) { token = value; },
  });
  playback.stopStreamingReply();
  assert.equal(token, 3);
  token = 10;
  playback.stopStreamingReply();
  assert.equal(token, 11);
});

test('failed held-reply playback releases its AudioContext and queue', async () => {
  let closed = 0;
  const sandbox = load('voice-playback.js', {
    AudioContext: class { async close() { closed += 1; } },
  });
  const queue = { run: async () => { throw new Error('playback failed'); }, pushChunk() {}, markDone() {} };
  const state = {
    heldReply: { sentences: ['hello'] }, desktopReplyPlaybackToken: 0,
    createDesktopStreamingChunkQueue: () => queue,
  };
  const playback = sandbox.window.ManaVoicePlayback.createVoicePlayback(state);
  await assert.rejects(playback.resumeHeldReply(), /playback failed/);
  assert.equal(closed, 1);
  assert.equal(state.heldReply, null);
  assert.equal(state.activeStreamingQueue, null);
});

test('real renderer boots with late-bound controllers and wires recording only once', async () => {
  const elements = new Map();
  const storage = new Map();
  let microphoneRequests = 0;
  const warnings = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, fn) { this.listeners[event] = fn; },
      querySelectorAll: () => [], querySelector: () => null,
      appendChild() {}, setAttribute() {}, focus() {},
    });
    return elements.get(id);
  }
  const response = {
    checks: [], profiles: {}, turns: [], presets: [], skills: [], pending: [], facts: [],
    providers: [], plugins: [], addons: [], sessions: [],
  };
  const sandbox = vm.createContext({
    window: {
      crypto: { randomUUID: () => 'boot-session' },
      ManaLive2DAvatar: { createLive2dAvatar: async () => null },
      ManaReplyEmotion: { detectReplyEmotion: () => 'idle' },
      ManaStreamingChunkQueue: { createDesktopStreamingChunkQueue() {} },
      ManaSileroVad: { createSileroVad() {} }, ManaVoiceEndpointing: {},
      ManaPluginStoreUi: { pluginRowsHtml: () => '' },
      electronAPI: { backendStatus: async () => ({ running: true }), backendLog() {}, backendExit() {} },
    },
    document: { getElementById: element, createElement: () => element(Symbol()), addEventListener() {}, activeElement: null },
    navigator: { mediaDevices: { async getUserMedia() { microphoneRequests += 1; return {}; } } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async url => ({ ok: true, json: async () => url.endsWith('/brain-providers') ? [] : response }),
    console: { ...console, warn: (...args) => warnings.push(args) },
    setInterval: () => 1, setTimeout, URLSearchParams, AbortController,
  });
  for (const file of Object.keys(modules)) {
    vm.runInContext(fs.readFileSync(path.join(rendererDir, file), 'utf8'), sandbox);
  }
  await vm.runInContext(fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(microphoneRequests, 1);
  assert.equal(typeof element('btnRecord').listeners.mousedown, 'function');
  assert.equal(typeof element('btnStop').listeners.click, 'function');
  assert.ok([...storage.values()].includes('boot-session'));
  assert.equal(element('status').textContent, 'Backend running');
  assert.deepEqual(warnings, []);
});
