const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('../../../node-bot/node_modules/ws');
const { chromium } = require('../../../node-bot/node_modules/playwright-core');
const { createPersonalBrowser } = require('../personal-browser');

test('real Chromium: extension transport drives the selected page and disconnect leaves the original browser usable', { skip: !process.env.MANA_BROWSER_TEST_EXECUTABLE, timeout: 45000 }, async t => {
  const server = http.createServer((_req, res) => res.end('<html><title>Transport test</title><button onclick="this.textContent=\'Clicked\'">Click me</button></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-browser-transport-'));
  let context;
  let personal;
  t.after(async () => {
    await personal?.close();
    await context?.close();
    await fs.rm(profile, { recursive: true, force: true });
  });
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.MANA_BROWSER_TEST_EXECUTABLE, headless: true, args: ['--disable-gpu'] });
  const original = context.browser();
  const page = await context.newPage();
  await page.goto(url);
  const debuggerSession = await context.newCDPSession(page);
  personal = await createPersonalBrowser({ sessionId: 'chat', origins: [new URL(url).origin], chromium, runAgent: fn => fn(), isPaused: () => false });
  const [port, secret] = personal.connectionCode.split(':');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, secret, { origin: `chrome-extension://${'a'.repeat(32)}` });
  const send = message => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
  // Public CDPSession emits named protocol events, not a generic "event".
  for (const method of [
    'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared',
    'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Page.frameAttached', 'Page.frameDetached',
    'Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.lifecycleEvent',
    'Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Page.domContentEventFired', 'Page.loadEventFired',
    'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed',
  ]) debuggerSession.on(method, params => send({ method: 'chrome.debugger.onEvent', params: [{ tabId: 1 }, method, params] }));
  ws.on('message', async raw => {
    const message = JSON.parse(raw);
    if (message.method === 'extension.configure') { send({ method: 'extension.initialized', params: { tabs: [{ id: 1, url }] } }); return; }
    try {
      let result;
      if (message.method === 'chrome.debugger.attach') result = {};
      else if (message.method === 'extension.disconnect') { await debuggerSession.detach(); result = {}; }
      else result = await debuggerSession.send(message.params[1], message.params[2] || {});
      send({ id: message.id, result });
    } catch (error) { send({ id: message.id, error: error.message }); }
  });
  await personal.connected;
  await assert.rejects(personal.getSession({ sessionId: 'another chat' }), /different chat/);
  const session = await personal.getSession({ sessionId: 'chat' });
  const snapshot = await session.snapshot();
  assert.match(snapshot.text, /Click me/);
  const element = snapshot.elements.find(line => line.includes('Click me'));
  const ref = /ref=(\w+)/.exec(element)?.[1];
  assert.ok(ref, `No button ref: ${element}`);
  await session.click(ref);
  assert.equal(await page.locator('button').textContent(), 'Clicked');
  await personal.close();
  assert.equal(original.isConnected(), true);
  assert.equal(page.isClosed(), false);
  await page.locator('button').click();
  await assert.rejects(session.snapshot(), /ownership changed/);
});
