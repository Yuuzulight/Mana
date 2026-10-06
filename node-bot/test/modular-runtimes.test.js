const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechRuntime } = require('../ai/speech-runtime');
const { createChatReply } = require('../ai/chat-reply');
const { registerChatRoutes } = require('../routes/chat');
const { registerSpeechRoutes } = require('../routes/speech');
const { registerPluginRoutes } = require('../routes/plugins');

test('runtime factories are inert until a method is called', () => {
  const context = new Proxy({}, { get() { throw new Error('eager dependency access'); } });
  assert.equal(typeof createSpeechRuntime(context).runWhisper, 'function');
  assert.equal(typeof createChatReply(context).buildAssistantReply, 'function');
});

test('speech runtime shares the OCR worker promise and retries a failed initialization', async () => {
  let starts = 0;
  const worker = { recognize: async () => ({ data: { text: 'screen' } }) };
  const state = {
    screenOcrWorkerPromise: null,
    createWorker: async () => { starts += 1; if (starts === 1) throw new Error('OCR unavailable'); return worker; },
  };
  const speech = createSpeechRuntime(state);
  const first = speech.getScreenOcrWorker();
  assert.equal(speech.getScreenOcrWorker(), first);
  await assert.rejects(first, /OCR unavailable/);
  assert.equal(state.screenOcrWorkerPromise, null);
  const second = speech.getScreenOcrWorker();
  assert.equal(speech.getScreenOcrWorker(), second);
  assert.equal(await second, worker);
  assert.equal(starts, 2);
});

test('chat and speech modules register each existing endpoint once', () => {
  const routes = [];
  const context = {
    app: { post: route => routes.push(route) },
    upload: { single: () => () => {} },
  };
  const chat = registerChatRoutes(context);
  registerSpeechRoutes({ ...context, warnIfSessionless: chat.warnIfSessionless });
  assert.deepEqual(routes.sort(), [
    '/reply', '/reply/stream', '/screen/read', '/synthesize', '/transcribe',
    '/transcribe-only', '/transcribe-partial', '/vision/capture-result', '/vision/describe',
  ].sort());
});

test('plugin routes read the current capability list and retain toggle validation', () => {
  const handlers = {};
  const context = {
    app: { get: (route, fn) => { handlers[route] = fn; }, post: (route, fn) => { handlers[route] = fn; } },
    capabilities: [],
    activePluginSettingsStore: { isEnabled: () => true, setEnabled: (_key, value) => value },
  };
  registerPluginRoutes(context);
  context.capabilities = [{ key: 'example', category: 'Tools' }];
  let status = 200;
  let payload;
  const res = { status(value) { status = value; return this; }, json(value) { payload = value; return this; } };
  handlers['/plugins']({}, res);
  assert.equal(payload.plugins.Tools[0].key, 'example');
  handlers['/plugins/:key/enabled']({ params: { key: 'example' }, body: { enabled: 'yes' } }, res);
  assert.equal(status, 400);
  handlers['/plugins/:key/enabled']({ params: { key: 'example' }, body: { enabled: false } }, res);
  assert.equal(payload.enabled, false);
});
