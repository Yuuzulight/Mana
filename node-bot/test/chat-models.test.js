const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAcpMemoryStore } = require('../acp-memory-store');
const { registerChatModelRoutes } = require('../routes/chat-models');
const { createLifecycle } = require('../ai/llama/lifecycle');

test('chat model choice is per session, survives restart/fork, and clears to automatic', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-chat-model-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createAcpMemoryStore({ dataDir });
  store.setSessionChatModel('one', 'local:fast');
  store.setSessionChatModel('two', 'cloud:fallback');
  const reopened = createAcpMemoryStore({ dataDir });
  assert.equal(reopened.getSession('one').chatModel, 'local:fast');
  assert.equal(reopened.getSession('two').chatModel, 'cloud:fallback');
  assert.equal(reopened.forkSession('one', { sessionId: 'fork' }).chatModel, 'local:fast');
  reopened.setSessionChatModel('one', 'automatic');
  assert.equal(reopened.getSession('one').chatModel, 'automatic');
  assert.throws(() => store.setSessionChatModel('x'.repeat(241), 'automatic'));
  assert.throws(() => store.setSessionChatModel('one', 'unvalidated-model'));
});

test('chat model routes require authorization and validate before changing the session', () => {
  const routes = {};
  let saved = 0;
  registerChatModelRoutes({ get: (key, handler) => { routes[`GET ${key}`] = handler; }, post: (key, handler) => { routes[`POST ${key}`] = handler; } }, {
    checkAdminAuth: req => req.authorized === true,
    modelManagement: {
      getChatModels: () => [{ id: 'automatic', label: 'Automatic' }],
      resolveChatModel: id => { if (id !== 'automatic') throw new Error('not permitted'); },
    },
    acpMemoryStore: { getSession: () => ({ chatModel: 'automatic' }), setSessionChatModel: () => { saved += 1; } },
  });
  let payload;
  let status;
  const res = { json(value) { payload = value; }, status(value) { status = value; return this; } };
  routes['POST /models/chat']({ body: { sessionId: 'one', model: 'automatic' } }, res);
  assert.equal(saved, 0);
  routes['POST /models/chat']({ authorized: true, body: { sessionId: 'one', model: 'cloud:arbitrary' } }, res);
  assert.equal(status, 400);
  assert.equal(saved, 0);
  routes['POST /models/chat']({ authorized: true, body: { sessionId: 'one', model: 'automatic' } }, res);
  assert.equal(saved, 1);
  routes['GET /models/chat']({ authorized: true, query: { sessionId: 'one' } }, res);
  assert.equal(payload.selected, 'automatic');
  routes['GET /models/chat']({ authorized: true, query: { sessionId: ['one', 'two'] } }, res);
  assert.equal(status, 400);
});

test('cancelled sole-owned model is tree-killed and exit-awaited; concurrent users retain it', async () => {
  const controller = new AbortController();
  const child = { pid: 123 };
  const state = { busy: 0, child, gamingSwapPending: null };
  let killed = 0;
  let exited;
  const stopping = new Promise(resolve => { exited = resolve; });
  const lifecycle = createLifecycle({ state, killProcessTree: actual => { assert.equal(actual, child); killed += 1; }, waitForExit: () => stopping });
  let settled = false;
  const run = lifecycle.inTurn(async () => { controller.abort(new Error('deadline')); controller.signal.throwIfAborted(); });
  const result = run({ signal: controller.signal }).catch(error => { settled = true; return error; });
  await Promise.resolve();
  assert.equal(killed, 1);
  assert.equal(settled, false);
  exited(true);
  assert.match((await result).message, /deadline/);
  assert.equal(state.busy, 0);

  const otherController = new AbortController();
  const shared = { busy: 1, child, gamingSwapPending: null };
  const sharedLifecycle = createLifecycle({ state: shared, killProcessTree: () => assert.fail('killed another active turn') });
  await assert.rejects(sharedLifecycle.inTurn(async () => { otherController.abort(new Error('deadline')); throw otherController.signal.reason; })({ signal: otherController.signal }), /deadline/);
  assert.equal(shared.busy, 1);
  assert.equal(shared.child, child);
});

test('cleanup failure restores temporary context and prevents claiming successful cancellation', async () => {
  const controller = new AbortController();
  const state = { busy: 0, child: { pid: 123 }, gamingSwapPending: null, contextRestorePending: true, contextOverride: 32768 };
  const lifecycle = createLifecycle({ state, killProcessTree() {}, waitForExit: async () => false });
  await assert.rejects(lifecycle.inTurn(async () => {
    controller.abort(new Error('deadline'));
    controller.signal.throwIfAborted();
  })({ signal: controller.signal }), { code: 'LOCAL_CLEANUP_FAILED' });
  assert.equal(state.busy, 0);
  assert.equal(state.contextOverride, null);
  assert.equal(state.contextRestorePending, false);
});

test('picker shows effective local recovery without overwriting the saved cloud preference', () => {
  let route;
  registerChatModelRoutes({ get: (_path, handler) => { route = handler; }, post() {} }, {
    checkAdminAuth: () => true,
    acpMemoryStore: { getSession: () => ({ chatModel: 'cloud:fallback' }), setSessionChatModel: () => assert.fail('read must not change preference') },
    modelManagement: {
      getChatModels: () => [{ id: 'local:fast', label: 'Local: fast' }],
      resolveChatModel: (id, opts) => { assert.equal(id, 'cloud:fallback'); assert.equal(opts.fallbackToLocal, true); return { profile: 'fast', localOnly: true }; },
    },
  });
  let payload;
  route({ query: { sessionId: 'one' } }, { json: value => { payload = value; } });
  assert.equal(payload.selected, 'local:fast');
});

test('answer model follows the selected regenerated reply version', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-chat-version-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createAcpMemoryStore({ dataDir });
  store.appendTurn({ sessionId: 'one', user: 'hi', assistant: 'local', answerModel: 'local.gguf' });
  store.addTurnVersion('one', 0, { assistant: 'cloud', answerModel: 'cloud-test', cloudFallback: true });
  assert.equal(store.getSession('one').turns[0].answerModel, 'cloud-test');
  store.setTurnVersion('one', 0, 0);
  assert.equal(store.getSession('one').turns[0].answerModel, 'local.gguf');
  assert.equal(store.getSession('one').turns[0].cloudFallback, false);
  store.setTurnVersion('one', 0, 1);
  assert.equal(store.getSession('one').turns[0].cloudFallback, true);
});
