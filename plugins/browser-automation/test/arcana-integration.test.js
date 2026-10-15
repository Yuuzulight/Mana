const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('../../../node-bot/node_modules/express');
const plugin = require('../index');

const executable = process.env.MANA_ARCANA_TEST_CLI;

test('real Arcana: Mana actions, preview, manual takeover, hand-back and cleanup share one browser', { skip: !executable, timeout: 45000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-integration-'));
  const site = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Arcana in Mana</title></head><body>
      <label for="name">Name</label><input id="name" style="position:fixed;left:20px;top:50px;width:200px;height:30px">
      <button style="position:fixed;left:20px;top:100px;width:100px;height:30px" onclick="document.querySelector('p').textContent=document.querySelector('input').value">Apply</button>
      <p>Ready</p><a href="/next">Next</a>
      <script>if(document.cookie.includes('arcana_test=kept')) document.body.append('Persisted cookie state');
        document.cookie='arcana_test=kept; path=/';</script></body></html>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}`;
  const endpoints = [];
  const chromium = require('../../../node-bot/node_modules/playwright-core').chromium;
  const deps = {
    env: { MANA_ARCANA_EXECUTABLE_PATH: executable, MANA_ARCANA_PROFILE_DIR: path.join(temporary, 'profile'), MANA_ARCANA_ALLOW_PRIVATE_NETWORK: '1' },
    ramPercent: () => 50, isGaming: () => false,
    isLocalRestartRequest: () => true, checkAdminAuth: () => true,
    arcanaChromium: { async connectOverCDP(endpoint, options) { endpoints.push(endpoint); return chromium.connectOverCDP(endpoint, options); } },
  };
  const app = express(); app.use(express.json());
  plugin._resetForTests();
  plugin.registerRoutes(app, deps);
  const ui = app.listen(0, '127.0.0.1');
  await new Promise(resolve => ui.once('listening', resolve));
  const base = `http://127.0.0.1:${ui.address().port}`;
  async function request(route, body, token) {
    const response = await fetch(base + '/browser/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Mana-Manual-Token': token } : {}) }, body: JSON.stringify(body || {}),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  try {
    const session = await plugin.getSession(deps);
    const snapshot = await session.navigate(url);
    assert.equal(snapshot.title, 'Arcana in Mana');
    const ref = role => /\[ref=([^\]]+)\]/.exec(snapshot.elements.find(line => line.startsWith(role)))[1];
    await session.type(ref('textbox'), 'Agent input');
    const clicked = await session.click(ref('button'));
    assert.match(clicked.text, /Agent input/);
    assert.ok((await session.screenshot()).length > 100);
    const { token } = await request('manual/start');
    assert.ok(token);
    await assert.rejects(() => session.snapshot(), /user has the browser/);
    const frameResponse = await fetch(base + '/browser/manual/frame', { headers: { 'X-Mana-Manual-Token': token } });
    assert.equal(frameResponse.status, 200);
    const frame = await frameResponse.json();
    assert.ok(frame.width > 0 && frame.height > 0);
    assert.equal(Buffer.from(frame.image, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    await request('manual/input', { action: 'click', x: 80, y: 60 }, token);
    await request('manual/input', { action: 'key', key: 'Control+A' }, token);
    await request('manual/input', { action: 'text', text: 'Manual input' }, token);
    await request('manual/input', { action: 'click', x: 60, y: 110 }, token);
    await request('manual/done', {}, token);
    const oldToken = await fetch(base + '/browser/manual/frame', { headers: { 'X-Mana-Manual-Token': token } });
    assert.equal(oldToken.status, 400);
    const fresh = await plugin.getSession(deps);
    assert.match((await fresh.snapshot()).text, /Manual input/);
    assert.equal(endpoints.length, 1, 'Takeover and hand-back must reuse the same Arcana process');
    await assert.rejects(() => session.snapshot(), /fresh session/);
    await plugin.closeSession();
    const oldEndpoint = endpoints[0].replace('ws:', 'http:').replace('/devtools/browser', '/json/version');
    await assert.rejects(() => fetch(oldEndpoint), /fetch failed/, 'Owned engine must stop, not just disconnect Playwright');
    const stateFile = path.join(temporary, 'profile/credentials.json');
    const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(stored.cookies.some(cookie => cookie.name === 'arcana_test'));
    assert.deepEqual(stored.origins, []);
    const policy = require('../../../node-bot/ai/tool-policy').createToolPolicy({ allowedRoot: path.join(temporary, 'profile') });
    assert.throws(() => policy.executeTool('read_file', { path: 'credentials.json' }), /credential-bearing/);
    assert.deepEqual(plugin.offerFiles([stateFile]), [], 'Saved browser credentials cannot be offered for upload');
    assert.equal(plugin.takeOverStatus().active, false);
    const reopened = await plugin.getSession(deps);
    const restored = await reopened.navigate(url);
    assert.equal(restored.title, 'Arcana in Mana');
    assert.match(restored.text, /Persisted cookie state/);
    assert.equal(endpoints.length, 2);
    const again = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(again.cookies.some(cookie => cookie.name === 'arcana_test'));
  } finally {
    await plugin.closeSession();
    ui.closeAllConnections(); site.closeAllConnections();
    await Promise.all([new Promise(resolve => ui.close(resolve)), new Promise(resolve => site.close(resolve))]);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
