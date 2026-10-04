const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../../../node-bot/node_modules/playwright-core');
const express = require('../../../node-bot/node_modules/express');
const plugin = require('../index');

test('real unpacked extension: explicit tab selection, screenshots, clicks, and debugger cleanup', { skip: !process.env.MANA_EXTENSION_TEST_EXECUTABLE, timeout: 45000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-extension-test-'));
  const extension = path.resolve(__dirname, '../../browser-control-extension');
  let context;
  t.after(async () => { if (context) await context.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  const app = express(); app.use(express.json());
  plugin._resetForTests();
  plugin.registerRoutes(app, { chromium, env: {}, isLocalRestartRequest: () => true, checkAdminAuth: (req, res) => {
    if (req.get('x-admin-token') === 'test-admin') return true;
    res.status(401).json({ error: 'unauthorized' }); return false;
  } });
  app.get('/', (_req, res) => res.send('<html><title>Extension test</title><button onclick="this.textContent=\'Clicked\'">Click me</button></html>'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.MANA_EXTENSION_TEST_EXECUTABLE, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-gpu'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  const page = await context.newPage();
  await page.goto(url);
  const ids = await worker.evaluate(async () => (await chrome.tabs.query({})).filter(tab => /^http:/.test(tab.url || '')).map(tab => tab.id));
  async function rpc(route, body, token) {
    const response = await fetch(`${url}browser/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin', ...(token ? { 'x-mana-manual-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    return result;
  }
  const personal = await rpc('personal/start', { sessionId: 'chat', origins: [new URL(url).origin] });
  t.after(() => plugin.closeSession());
  const popup = await context.newPage();
  await popup.goto(worker.url().replace(/background\.js$/, 'popup.html'));
  await popup.setViewportSize({ width: 372, height: 520 });
  await popup.locator('#code').fill(personal.connectionCode);
  await popup.locator(`input[name="tab"][value="${ids[0]}"]`).check();
  if (process.env.MANA_BROWSER_EXTENSION_CAPTURE) await popup.screenshot({ path: process.env.MANA_BROWSER_EXTENSION_CAPTURE });
  await popup.getByRole('button', { name: 'Connect selected tabs' }).click();
  for (let i = 0; i < 50 && !(await rpc('personal/status')).connected; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await rpc('personal/status')).connected, true);
  const session = await plugin.getSession({ sessionId: 'chat', env: {} });
  const snapshot = await session.snapshot();
  const ref = /ref=(\w+)/.exec(snapshot.elements.find(line => line.includes('Click me')))?.[1];
  assert.ok(ref);
  assert.ok((await session.screenshot()).length > 100);
  await session.click(ref);
  assert.equal(await page.locator('button').textContent(), 'Clicked');
  const manual = await rpc('manual/start', {});
  await assert.rejects(session.snapshot(), /ownership changed/);
  const frame = await rpc('manual/frame', undefined, manual.token);
  assert.ok(frame.image.length > 100);
  assert.ok(frame.width > 0 && frame.height > 0);
  await rpc('manual/input', { action: 'key', key: 'ArrowDown' }, manual.token);
  await rpc('manual/done', {}, manual.token);
  await assert.rejects(session.snapshot(), /ownership changed/);
  assert.match((await (await plugin.getSession({ sessionId: 'chat', env: {} })).snapshot()).text, /Clicked/);
  await rpc('close', {});
  await worker.evaluate(async () => { await disconnect(); });
  const detached = await worker.evaluate(async tabId => {
    try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }); return false; }
    catch { return true; }
  }, ids[0]);
  assert.equal(detached, true);
  assert.equal(page.isClosed(), false);
  await page.locator('button').click();
});
