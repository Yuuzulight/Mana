const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('../../../node-bot/node_modules/ws');
const { createExtensionTransport, allowedUrl } = require('../extension-transport');

async function peer(bridge, overrides = {}) {
  const [port, secret] = bridge.connectionCode.split(':');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, overrides.secret || secret, { origin: overrides.origin || `chrome-extension://${'a'.repeat(32)}` });
  ws.on('error', () => {});
  return ws;
}
async function connect(bridge, respond = () => ({})) {
  const ws = await peer(bridge);
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method === 'extension.configure') ws.send(JSON.stringify({ method: 'extension.initialized', params: { tabs: [{ id: 1, url: 'https://site.test/' }] } }));
    else if (message.id) Promise.resolve(respond(message)).then(result => result !== null && ws.readyState === 1 && ws.send(JSON.stringify({ id: message.id, result })));
  });
  await bridge.connected;
  return ws;
}
function command(transport, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    transport.onmessage = message => { if (message.id !== 99) return; if (message.error) reject(new Error(message.error.message)); else resolve(message.result); };
    transport.onclose = reason => reject(new Error(reason));
    transport.send({ id: 99, method, params, sessionId });
  });
}

test('allowlist matches exact origins and never accepts non-web URLs', () => {
  assert.equal(allowedUrl('https://site.test/x', ['https://site.test']), true);
  for (const url of ['https://site.test.evil/x', 'http://site.test/x', 'file:///x', 'chrome://settings']) assert.equal(allowedUrl(url, ['https://site.test']), false);
});

test('transport requires a one-session code and an extension origin, and rejects a second connection', async t => {
  const bridge = await createExtensionTransport({ sessionId: 'chat' }); t.after(() => bridge.close());
  for (const overrides of [{ secret: '0'.repeat(48) }, { origin: 'https://evil.test' }]) {
    const ws = await peer(bridge, overrides);
    await new Promise(resolve => ws.once('close', resolve));
    assert.equal(bridge.isConnected(), false);
  }
  const ws = await connect(bridge); t.after(() => ws.terminate());
  const second = await peer(bridge); await new Promise(resolve => second.once('close', resolve));
  assert.equal(bridge.isConnected(), true);
});

test('selected tab commands route through CDP without exposing other tabs or browser cookies', async t => {
  const bridge = await createExtensionTransport({ sessionId: 'chat', origins: ['https://site.test'] }); t.after(() => bridge.close());
  const seen = [];
  await connect(bridge, msg => { seen.push(msg); return msg.params?.[1] === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'target-1', url: 'https://site.test/' } } : { value: 42 }; });
  await command(bridge.transport, 'Target.setAutoAttach', {});
  await command(bridge.transport, 'Target.setAutoAttach', { autoAttach: true, flatten: true }, 'mana-tab-1');
  assert.deepEqual(seen.find(m => m.params?.[1] === 'Target.setAutoAttach').params[2].filter, [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }]);
  assert.deepEqual(await command(bridge.transport, 'Runtime.evaluate', { expression: '1' }, 'mana-tab-1'), { value: 42 });
  await assert.rejects(command(bridge.transport, 'Runtime.evaluate', {}, 'unknown'), /no longer authorized/);
  await assert.rejects(command(bridge.transport, 'Page.navigate', { url: 'https://evil.test/' }, 'mana-tab-1'), /allowlist/);
  await assert.rejects(command(bridge.transport, 'Network.getAllCookies', {}, 'mana-tab-1'), /cookies/);
  await assert.rejects(command(bridge.transport, 'Target.createTarget', { url: 'https://site.test' }), /limited/);
  assert.equal(seen.filter(m => m.params?.[1] === 'Runtime.evaluate').length, 1);
});

test('an unselected related page is detached, never exposed as a selected tab or routed child session', async t => {
  const bridge = await createExtensionTransport({ sessionId: 'chat' }); t.after(() => bridge.close());
  const seen = [];
  const ws = await connect(bridge, msg => { seen.push(msg); return msg.params?.[1] === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'target-1', url: 'https://site.test/' } } : {}; });
  await command(bridge.transport, 'Target.setAutoAttach', {});
  const events = [];
  bridge.transport.onmessage = message => events.push(message);
  ws.send(JSON.stringify({ method: 'chrome.debugger.onEvent', params: [{ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'unselected-popup', targetInfo: { type: 'page', targetId: 'popup' }, waitingForDebugger: true }] }));
  for (let i = 0; i < 50 && !seen.some(msg => msg.params?.[1] === 'Target.detachFromTarget'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seen.some(msg => msg.params?.[1] === 'Target.detachFromTarget'));
  assert.equal(events.some(event => event.method === 'Target.attachedToTarget'), false);
  await assert.rejects(command(bridge.transport, 'Runtime.evaluate', {}, 'unselected-popup'), /no longer authorized/);
});

test('commands preserve per-session reply order before enabling runtime events', async t => {
  const bridge = await createExtensionTransport({ sessionId: 'chat' }); t.after(() => bridge.close());
  let releaseFrame;
  const frame = new Promise(resolve => { releaseFrame = resolve; });
  const seen = [];
  await connect(bridge, async msg => {
    const method = msg.params?.[1];
    seen.push(method);
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-1' } };
    if (method === 'Page.getFrameTree') await frame;
    return {};
  });
  await command(bridge.transport, 'Target.setAutoAttach', {});
  const replies = [];
  bridge.transport.onmessage = message => replies.push(message.id);
  bridge.transport.send({ id: 1, method: 'Page.getFrameTree', sessionId: 'mana-tab-1' });
  bridge.transport.send({ id: 2, method: 'Runtime.enable', sessionId: 'mana-tab-1' });
  for (let i = 0; i < 50 && !seen.includes('Page.getFrameTree'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(seen.includes('Runtime.enable'), false);
  releaseFrame();
  for (let i = 0; i < 50 && replies.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(replies, [1, 2]);
});

test('timeout rejects pending commands, closes the port and drops all session state', async t => {
  const bridge = await createExtensionTransport({ sessionId: 'chat', commandMs: 20 }); t.after(() => bridge.close());
  const connected = await connect(bridge, msg => msg.params?.[1] === 'Runtime.evaluate' ? null : { targetInfo: { targetId: 'target-1' } });
  await command(bridge.transport, 'Target.setAutoAttach', {});
  const ended = once(connected, 'close');
  await assert.rejects(command(bridge.transport, 'Runtime.evaluate', {}, 'mana-tab-1'), /timed out/);
  await ended;
  assert.equal(bridge.isClosed(), true);
});

test('redirect outside an allowlist revokes the whole session rather than reading the new page', async t => {
  const bridge = await createExtensionTransport({ sessionId: 'chat', origins: ['https://site.test'] }); t.after(() => bridge.close());
  const ws = await connect(bridge);
  const ended = once(ws, 'close');
  ws.send(JSON.stringify({ method: 'extension.tabUrl', params: { tabId: 1, url: 'https://evil.test/' } }));
  await ended;
  assert.equal(bridge.isClosed(), true);
});
