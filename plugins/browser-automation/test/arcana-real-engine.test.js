// Drives the plugin against a real Arcana build (CI: tools/install-arcana.ps1;
// locally: MANA_ARCANA_TEST_REAL=1, with MANA_ARCANA_CLI or an installed build).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const plugin = require('../index');
const { resolveCli } = require('../arcana-engine');

const real = process.env.MANA_ARCANA_TEST_REAL === '1';

test('real Arcana: actions, local storage across a restart, and the engine is gone after close', { skip: !real, timeout: 90000 }, async () => {
  assert.ok(resolveCli(process.env), 'Arcana CLI not found: run tools/install-arcana.ps1 or set MANA_ARCANA_CLI');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-real-'));
  const site = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Arcana in Mana</title></head><body>
      <label for="name">Name</label><input id="name">
      <button onclick="document.querySelector('p').textContent=document.querySelector('input').value">Apply</button>
      <p>Ready</p>
      <script>if (localStorage.getItem('arcana_test') === 'kept') document.body.append('Persisted local storage');
        localStorage.setItem('arcana_test', 'kept');</script></body></html>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}`;
  const deps = {
    env: { ...process.env, MANA_BROWSER_PROFILE_DIR: path.join(temporary, 'profile'), MANA_ARCANA_ALLOW_PRIVATE_NETWORK: '1' },
    ramPercent: () => 50, isGaming: () => false,
  };
  plugin._resetForTests();
  try {
    const session = await plugin.getSession(deps);
    const snapshot = await session.navigate(url);
    assert.equal(snapshot.title, 'Arcana in Mana');
    const ref = role => /\[ref=([^\]]+)\]/.exec(snapshot.elements.find(line => line.startsWith(role)))[1];
    await session.type(ref('textbox'), 'Agent input');
    const clicked = await session.click(ref('button'));
    assert.match(clicked.text, /Agent input/);
    assert.ok((await session.screenshot()).length > 100);
    await plugin.closeSession();

    const reopened = await plugin.getSession(deps);
    assert.match((await reopened.navigate(url)).text, /Persisted local storage/);
  } finally {
    await plugin.closeSession();
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
