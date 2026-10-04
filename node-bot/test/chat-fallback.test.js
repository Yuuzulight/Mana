const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createChatAttempt } = require('../ai/chat-attempt');
const { completionUrl, requestChatCompletion } = require('../ai/remote-chat');
const { createApp } = require('../server');

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function fakeTimers() {
  let callback;
  let delay;
  let cleared = false;
  return {
    setTimeout(fn, ms) { callback = fn; delay = ms; return 1; },
    clearTimeout() { cleared = true; },
    expire() { if (!cleared) callback?.(); },
    get delay() { return delay; },
    get cleared() { return cleared; },
  };
}

test('30/60 second handoff aborts only before progress and clears its timer', async () => {
  for (const seconds of [30, 60]) {
    const timers = fakeTimers();
    const attempt = createChatAttempt(seconds, timers);
    assert.equal(timers.delay, seconds * 1000);
    timers.expire();
    assert.match(attempt.signal.reason.message, /fallback deadline/);
    assert.equal(attempt.signal.aborted, true);
    assert.throws(attempt.markStarted, /fallback deadline/);
    attempt.close();
    assert.equal(timers.cleared, true);
    const progressTimers = fakeTimers();
    const progress = createChatAttempt(seconds, progressTimers);
    progress.markStarted();
    progressTimers.expire();
    assert.equal(progress.signal.aborted, false);
    assert.equal(progress.started, true);
    progress.close();
  }
  const timers = fakeTimers();
  const attempt = createChatAttempt(0, timers);
  assert.equal(timers.delay, undefined);
  attempt.close();
});

test('endpoint URLs normalize /v1 once and reject embedded credentials and other schemes', () => {
  assert.equal(completionUrl('https://example.com/v1/').pathname, '/v1/chat/completions');
  assert.equal(completionUrl('https://example.com/proxy').pathname, '/proxy/v1/chat/completions');
  assert.throws(() => completionUrl('https://key:secret@example.com'));
  assert.throws(() => completionUrl('file:///private'));
});

test('remote response accepts success, refuses HTTP error bodies, and closes on a wall deadline', async t => {
  const success = await endpoint(t, (_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: ' answer ' } }], usage: { total_tokens: 5 } })));
  assert.deepEqual(await requestChatCompletion({ baseUrl: success, model: 'test', messages: [], maxTokens: 20 }), { content: 'answer', usage: { total_tokens: 5 } });
  const failure = await endpoint(t, (_req, res) => { res.statusCode = 500; res.end(JSON.stringify({ choices: [{ message: { content: 'must not answer' } }] })); });
  assert.equal(await requestChatCompletion({ baseUrl: failure, model: 'test', messages: [] }), null);
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const stalled = await endpoint(t, req => req.on('close', closed));
  assert.equal(await requestChatCompletion({ baseUrl: stalled, model: 'test', messages: [], timeoutMs: 100 }), null);
  await disconnected;
});

test('failed local chat uses scoped opted-in fallback and labels the answer; scheduled work does not', async t => {
  let calls = 0;
  const baseUrl = await endpoint(t, (req, res) => {
    calls += 1;
    assert.equal(req.url, '/v1/chat/completions');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Cloud answer.' } }] }));
  });
  const app = createApp({
    runLocalAssistantReply: async () => { throw new Error('local failed'); },
    openAiFallbackConfig: () => ({ baseUrl, model: 'cloud-test', allowRemoteAi: '1', timeoutSeconds: 0 }),
  });
  const meta = {};
  assert.equal(await app.locals.buildAssistantReply('hi', '', '', 'default', null, null, null, meta), 'Cloud answer.');
  assert.equal(meta.answerModel, 'cloud-test');
  assert.equal(meta.cloudFallback, true);
  await assert.rejects(app.locals.buildAssistantReply('hi', '', '', 'default', null, null, null, { scheduled: true }), /local failed/);
  assert.equal(calls, 1);
});

test('timed fallback aborts the local request before calling cloud and clears its timer', async t => {
  const timers = fakeTimers();
  let aborted = false;
  const baseUrl = await endpoint(t, (_req, res) => {
    assert.equal(aborted, true);
    res.end(JSON.stringify({ choices: [{ message: { content: 'Timed fallback.' } }] }));
  });
  const app = createApp({
    createChatAttempt: seconds => createChatAttempt(seconds, timers),
    openAiFallbackConfig: () => ({ baseUrl, model: 'cloud-test', timeoutSeconds: 30 }),
    runLocalAssistantReply: async (_prompt, _max, _profile, _system, extra) => new Promise((_, reject) => {
      extra.signal.addEventListener('abort', () => { aborted = true; reject(extra.signal.reason); }, { once: true });
      timers.expire();
    }),
  });
  const meta = {};
  assert.equal(await app.locals.buildAssistantReply('hi', '', '', 'default', null, null, null, meta), 'Timed fallback.');
  assert.equal(timers.cleared, true);
});

test('a partial local sentence suppresses cloud handoff even when the later local retry fails', async t => {
  let calls = 0;
  const baseUrl = await endpoint(t, (_req, res) => { calls += 1; res.end('{}'); });
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true, streamLocalAssistantReply: async (_prompt, opts) => { await opts.onSentence('Already started.'); throw new Error('stream failed'); } },
    runLocalAssistantReply: async () => { throw new Error('local failed'); },
    openAiFallbackConfig: () => ({ baseUrl, model: 'cloud-test', timeoutSeconds: 30 }),
  });
  await assert.rejects(app.locals.buildAssistantReply('hi', '', '', 'default', null, null, null, {}, () => {}), /local failed/);
  assert.equal(calls, 0);
});

test('oversized and slow-drip cloud responses are bounded and disconnected', async t => {
  const oversized = await endpoint(t, (_req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
  assert.equal(await requestChatCompletion({ baseUrl: oversized, model: 'test', messages: [] }), null);
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const drip = await endpoint(t, (_req, res) => {
    res.writeHead(200);
    const interval = setInterval(() => res.write(' '), 20);
    res.on('close', () => { clearInterval(interval); disconnected(); });
  });
  assert.equal(await requestChatCompletion({ baseUrl: drip, model: 'test', messages: [], timeoutMs: 100 }), null);
  await closed;
});

test('cleanup failure refuses cloud fallback', async t => {
  let calls = 0;
  const baseUrl = await endpoint(t, (_req, res) => { calls += 1; res.end('{}'); });
  const app = createApp({
    runLocalAssistantReply: async () => { const error = new Error('process still alive'); error.code = 'LOCAL_CLEANUP_FAILED'; throw error; },
    openAiFallbackConfig: () => ({ baseUrl, model: 'cloud-test', timeoutSeconds: 30 }),
  });
  await assert.rejects(app.locals.buildAssistantReply('hi', '', '', 'default', null, null, null, {}), /process still alive/);
  assert.equal(calls, 0);
});

test('startup cleanup failure also refuses cloud fallback', async t => {
  let calls = 0;
  const baseUrl = await endpoint(t, (_req, res) => { calls += 1; res.end('{}'); });
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true, waitForServer: async () => { const error = new Error('startup process still alive'); error.code = 'LOCAL_CLEANUP_FAILED'; throw error; } },
    runLocalAssistantReply: async () => assert.fail('must not retry after cleanup failure'),
    openAiFallbackConfig: () => ({ baseUrl, model: 'cloud-test', timeoutSeconds: 30 }),
  });
  await assert.rejects(app.locals.buildAssistantReply('hi', '', '', 'default', null, null, null, {}), /startup process still alive/);
  assert.equal(calls, 0);
});

test('explicit cloud choice answers directly, and a local choice preserves its profile', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createAcpMemoryStore } = require('../acp-memory-store');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-chat-routing-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createAcpMemoryStore({ dataDir });
  store.setSessionChatModel('cloud', 'cloud:fallback');
  store.setSessionChatModel('local', 'local:fast');
  let calls = 0;
  const baseUrl = await endpoint(t, (_req, res) => { calls += 1; res.end(JSON.stringify({ choices: [{ message: { content: 'Selected cloud.' } }] })); });
  const app = createApp({
    acpMemoryStore: store,
    modelManagement: { getActiveProfile: () => 'default', resolveChatModel: id => id === 'local:fast' ? { profile: 'fast' } : { remoteConfig: { baseUrl, model: 'chosen-cloud', allowRemoteAi: '1' } } },
    runLocalAssistantReply: async (_prompt, _max, profile) => { assert.equal(profile, 'fast'); return 'Selected local.'; },
    openAiFallbackConfig: () => null,
  });
  const meta = {};
  assert.equal(await app.locals.buildAssistantReply('hi', '', '', 'default', 'cloud', null, null, meta), 'Selected cloud.');
  assert.equal(meta.answerModel, 'chosen-cloud');
  assert.equal(meta.cloudFallback, undefined);
  assert.equal(await app.locals.buildAssistantReply('hi', '', '', 'default', 'local', null, null, {}), 'Selected local.');
  assert.equal(calls, 1);
});

test('unavailable cloud primary recovers locally without bouncing into cloud fallback', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createAcpMemoryStore } = require('../acp-memory-store');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-cloud-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createAcpMemoryStore({ dataDir });
  store.setSessionChatModel('one', 'cloud:brain');
  const app = createApp({
    acpMemoryStore: store,
    modelManagement: { getActiveProfile: () => 'fast', resolveChatModel: (_id, options) => { assert.equal(options.fallbackToLocal, true); return { profile: 'fast', localOnly: true }; } },
    runLocalAssistantReply: async (_prompt, _max, profile) => { assert.equal(profile, 'fast'); return 'Local recovery.'; },
    openAiFallbackConfig: () => assert.fail('must not escalate a revoked cloud selection'),
  });
  const meta = {};
  assert.equal(await app.locals.buildAssistantReply('hi', '', '', 'default', 'one', null, null, meta), 'Local recovery.');
  assert.match(meta.answerModel, /Local: fast/);
  assert.equal(meta.cloudFallback, undefined);
  assert.equal(store.getSession('one').chatModel, 'cloud:brain');
});
