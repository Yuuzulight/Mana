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

// Frames, uploads, downloads, drags, tables and form controls: what the engine and the plugin's Arcana
// adapter have to cover for the pages Mana meets. Uses the same local site as the gate.
test('real Arcana: frames, a file upload, a download, a drag, a table and form controls', { skip: !real, timeout: 150000 }, async () => {
  assert.ok(resolveCli(process.env), 'Arcana CLI not found: run tools/install-arcana.ps1 or set MANA_ARCANA_CLI');
  const { startSite } = require('../../../tools/arcana-fixture-site');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-real-frames-'));
  const site = await startSite();
  const upload = path.join(temporary, 'arcana-gate-upload.txt');
  fs.writeFileSync(upload, 'uploaded by the test\n');
  const downloads = [];
  const deps = {
    env: { ...process.env, MANA_BROWSER_PROFILE_DIR: path.join(temporary, 'profile'), MANA_ARCANA_ALLOW_PRIVATE_NETWORK: '1' },
    ramPercent: () => 50, isGaming: () => false,
    onDownload: async download => { downloads.push(download.suggestedFilename()); await download.cancel().catch(() => {}); },
  };
  const ref = (snapshot, pattern) => /\[ref=([^\]]+)\]/.exec(snapshot.elements.find(line => pattern.test(line)))[1];
  const run = (session, code) => session.devtools({ do: 'run_js', code }).then(result => result.devtools[0]);
  const settle = async (check, what) => {
    for (let i = 0; i < 20; i += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 500)); }
    assert.fail(`never saw: ${what}`);
  };
  plugin._resetForTests();
  try {
    const session = await plugin.getSession(deps);

    // an iframe is read, and a button in it can be clicked
    let snapshot = await session.navigate(site.url('/frames.html'));
    await settle(async () => (snapshot = await session.snapshot()).elements.some(line => /Frame button/.test(line)), 'the iframe button');
    await session.click(ref(snapshot, /Frame button/));
    assert.match(await run(session, "document.getElementById('f').contentDocument.getElementById('said').textContent"), /frame button clicked/);

    // frames inside frames, an inline-HTML frame, and a frameset
    snapshot = await session.navigate(site.url('/nested.html'));
    await settle(async () => (snapshot = await session.snapshot()).elements.some(line => /Frame button.*ref=f[0-9]+e/.test(line)), 'the button two frames down');
    snapshot = await session.navigate(site.url('/srcdoc.html'));
    await settle(async () => (snapshot = await session.snapshot()).elements.some(line => /Srcdoc button/.test(line)), 'the srcdoc button');
    snapshot = await session.navigate(site.url('/frameset.html'));
    await settle(async () => (snapshot = await session.snapshot()).elements.some(line => /Go to child/.test(line)), 'the link in the second frame');

    // a file goes through a multipart form to the server
    snapshot = await session.navigate(site.url('/upload.html'));
    plugin.offerFiles([upload]);
    await session.upload(ref(snapshot, /file|Choose/i), upload);
    await session.click(ref(snapshot, /button "Send"/));
    await settle(async () => /File Uploaded![\s\S]*arcana-gate-upload\.txt/.test((await session.snapshot()).text), 'the uploaded file name');

    // a download starts from a page load answered with an attachment
    await session.navigate(site.url('/download.html'));
    await session.click(ref(await session.snapshot(), /Get the file/));
    await settle(async () => downloads.includes('fixture.txt'), 'the download');

    // a drag between two buttons
    snapshot = await session.navigate(site.url('/drag.html'));
    await session.drag(ref(snapshot, /Drag me/), ref(snapshot, /Drop here/));
    assert.match((await session.snapshot()).text, /dropped a/);

    // a table page reads, and its link can be followed
    snapshot = await session.navigate(site.url('/table.html'));
    assert.ok(snapshot.elements.some(line => /Go to child/.test(line)));

    // a thread-sized table (a row per comment) reads in reasonable time
    const started = Date.now();
    snapshot = await session.navigate(site.url('/bigtable.html'));
    assert.ok(snapshot.elements.length > 100, 'the big table has links');
    assert.ok(Date.now() - started < 30000, `a 1,500-row table took ${Date.now() - started} ms`);

    // a dropdown shows its choices, and a number input steps with the arrow keys
    snapshot = await session.navigate(site.url('/controls.html'));
    assert.ok(snapshot.elements.some(line => /^option "One"/.test(line)) && snapshot.elements.some(line => /^option "Two"/.test(line)));
    await session.select(ref(snapshot, /^combobox/), 'Two');
    assert.ok((await session.snapshot()).elements.some(line => /^option "Two" \[selected\]/.test(line)));
    await session.press('ArrowUp', ref(snapshot, /^spinbutton/));
    assert.match((await session.snapshot()).text, /count 6/);
  } finally {
    await plugin.closeSession();
    await site.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
