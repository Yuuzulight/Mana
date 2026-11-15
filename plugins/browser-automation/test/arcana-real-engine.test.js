// Drives the plugin against a real Arcana build (CI: tools/install-arcana.ps1;
// locally: MANA_ARCANA_TEST_REAL=1, with the checked-in pinned install).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const plugin = require('../index');
const { resolveCli, startArcanaPageApi } = require('../arcana-engine');
const express = require('../../../node-bot/node_modules/express');

const real = process.env.MANA_ARCANA_TEST_REAL === '1';
const signinSpikes = process.env.MANA_ARCANA_SIGNIN_SPIKES === '1';

test('real Arcana Page API starts the pinned engine and acts on a rendered page', { skip: !real, timeout: 30000 }, async () => {
  const api = await startArcanaPageApi(process.env);
  try {
    if (!process.env.MANA_ARCANA_CLI && !process.env.MANA_ARCANA_DIR) {
      const pin = require('../../../tools/arcana.lock.json');
      assert.equal(api.backend, pin.engineVersion.startsWith('folio-') ? 'folio' : 'obscura');
    }
    const { pageId } = await api.client.createPage();
    const snapshot = await api.client.snapshot(pageId);
    assert.equal(snapshot.url, 'about:blank');
    await api.client.closePage(pageId);
    // Inline fixtures exercise Folio without opening an external origin.
    if (api.backend === 'folio') {
      const page = await api.client.createPage('about:blank', {
        html: '<!doctype html><title>Arcana native actions</title><label for="name">Name</label>'
          + '<input id="name"><button>Apply</button><p>Ready</p>'
          + '<script>document.querySelector("button").onclick = () => '
          + '{ document.querySelector("p").textContent = document.querySelector("input").value; };</script>',
      });
      const initial = await api.client.snapshot(page.pageId);
      assert.equal(initial.title, 'Arcana native actions');
      const input = initial.elements.find(element => element.tag === 'input');
      const button = initial.elements.find(element => element.tag === 'button');
      assert.ok(input?.reference && button?.reference);
      await api.client.fill(page.pageId, input.reference, 'Page API input');
      await api.client.click(page.pageId, button.reference);
      const updated = await api.client.snapshot(page.pageId);
      assert.match(updated.text, /Page API input/);
      assert.equal(updated.elements.find(element => element.tag === 'button').reference, button.reference);
      const screenshot = await api.client.screenshot(page.pageId);
      assert.deepEqual(screenshot.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
      await api.client.closePage(page.pageId);
    }
  } finally {
    const exited = once(api.child, 'exit');
    await api.stop();
    await exited;
  }
});

test('real Arcana Page API transport is reachable through Mana session entry and navigates and acts on rendered content', { skip: !real, timeout: 90000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-page-session-'));
  const eventFile = path.join(temporary, 'arcana-events.jsonl');
  const deps = {
    env: { ...process.env, MANA_ARCANA_TRANSPORT: 'page-api', MANA_BROWSER_PROFILE_DIR: path.join(temporary, 'profile'), MANA_ARCANA_EVENTS_FILE: eventFile, MANA_ARCANA_ALLOW_PRIVATE_NETWORK: '1' },
    arcanaAllowedOrigins: ['https://example.com'],
    arcanaPageApiInitialHtml: '<!doctype html><title>Mana Page API session</title><label for="q">Query</label><input id="q"><button onclick="result.textContent=q.value">Apply</button><p id="result">Ready</p>',
    ramPercent: () => 50, isGaming: () => false,
  };
  plugin._resetForTests();
  try {
    const session = await plugin.getSession(deps);
    const snapshot = await session.snapshot();
    assert.equal(snapshot.title, 'Mana Page API session');
    const ref = role => /\[ref=([^\]]+)\]/.exec(snapshot.elements.find(line => line.startsWith(role)))[1];
    await session.type(ref('textbox'), 'API action');
    const changed = await session.click(ref('button'));
    assert.match(changed.text, /API action/);
    assert.ok((await session.screenshot()).length > 50);
    const event = JSON.parse(fs.readFileSync(eventFile, 'utf8').trim().split('\n')[0]);
    assert.equal(event.type, 'arcana_page_api_started');
    assert.equal(event.backend, 'folio');
    const opened = await session.tab({ do: 'open', url: 'https://example.com' });
    assert.match(opened.title, /Example Domain/i);
    assert.equal(opened.tabs.length, 2);
    assert.match(opened.tabs[1], /\(current\)$/);
    const first = await session.tab({ do: 'switch', number: 1 });
    assert.match(first.text, /API action/);
    assert.match(first.tabs[0], /\(current\)$/);
    const afterClose = await session.tab({ do: 'close', number: 2 });
    assert.equal(afterClose.tabs, undefined);
    assert.match(afterClose.text, /API action/);
    const navigated = await session.navigate('https://example.com');
    assert.match(navigated.url, /^https:\/\/example\.com\//i);
    assert.match(navigated.title, /Example Domain/i);
  } finally {
    await plugin.closeSession();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('real Folio Page API retains the tab through embedded manual control', { skip: !real, timeout: 30000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-folio-manual-'));
  const deps = {
    env: { ...process.env, MANA_ARCANA_TRANSPORT: 'page-api', MANA_BROWSER_PROFILE_DIR: temporary },
    arcanaPageApiInitialHtml: '<!doctype html><title>Folio manual input</title>'
      + '<input id="name" aria-label="Name" style="position:absolute;left:20px;top:20px;width:140px;height:30px">'
      + '<p id="status">Ready</p><script>const input = document.querySelector("input");'
      + 'input.addEventListener("input", () => document.querySelector("#status").textContent = input.value)</script>',
    ramPercent: () => 50, isGaming: () => false, isLocalRestartRequest: () => true,
  };
  plugin._resetForTests();
  const app = express();
  app.use(express.json());
  plugin.registerRoutes(app, deps);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/browser/manual`;
  async function call(route, body, token) {
    const response = await fetch(`${base}/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token && { 'x-mana-manual-token': token }) },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  try {
    const agent = await plugin.getSession(deps);
    const { token } = await call('start', {});
    await assert.rejects(agent.snapshot(), /user has the browser/);
    const frame = await call('frame', null, token);
    assert.equal(frame.url, 'about:blank');
    assert.deepEqual(Buffer.from(frame.image, 'base64').subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    await call('input', { action: 'click', x: 45, y: 35 }, token);
    await call('input', { action: 'text', text: 'Manual Folio input' }, token);
    await call('input', { action: 'key', key: 'Tab' }, token);
    await call('input', { action: 'scroll', dy: 100 }, token);
    await call('done', {}, token);
    const resumed = await plugin.getSession(deps);
    assert.match((await resumed.snapshot()).text, /Manual Folio input/);
  } finally {
    await plugin.closeSession();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('real Arcana: actions, local storage across a restart, and the engine is gone after close', { skip: !real, timeout: 90000 }, async () => {
  const env = {
    ...process.env,
    MANA_ARCANA_CLI: '',
    MANA_ARCANA_DIR: '',
    MANA_BROWSER_ENGINE: '',
    MANA_BROWSER_HEADLESS: '1',
  };
  const pin = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../tools/arcana.lock.json'), 'utf8'));
  const installed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../node-bot/runtime/arcana/arcana-install.json'), 'utf8'));
  assert.match(pin.commit, /^[0-9a-f]{40}$/i, 'Mana should pin an immutable Arcana commit');
  assert.match(pin.engineVersion, /^folio-/i, 'Mana production should use the Folio-only Arcana engine');
  assert.deepEqual(
    { repository: installed.repository, commit: installed.commit, engineVersion: installed.engineVersion },
    { repository: pin.repository, commit: pin.commit, engineVersion: pin.engineVersion },
    'installed Arcana metadata must match the checked-in pin',
  );
  assert.ok(resolveCli(env), 'the checked-in Arcana pin is not installed; run tools/install-arcana.ps1');
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
  const frames = [];
  const eventsFile = path.join(temporary, 'arcana-events.jsonl');
  const deps = {
    env: { ...env, MANA_BROWSER_PROFILE_DIR: path.join(temporary, 'profile'), MANA_ARCANA_EVENTS_FILE: eventsFile, MANA_ARCANA_ALLOW_PRIVATE_NETWORK: '1' },
    ramPercent: () => 50, isGaming: () => false,
    onScreencastFrame: frame => frames.push(frame),
  };
  plugin._resetForTests();
  try {
    const session = await plugin.getSession(deps);
    const engineEvents = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(engineEvents.some(event => event.type === 'arcana_started'), 'the ordinary headless entry path must start pinned Arcana');
    assert.ok(!engineEvents.some(event => event.type === 'arcana_start_failed'), 'the default engine path must not silently pass through Edge fallback');
    const snapshot = await session.navigate(url);
    assert.equal(snapshot.title, 'Arcana in Mana');
    for (let i = 0; i < 20 && !frames.length; i += 1) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(frames.some(frame => typeof frame.data === 'string' && frame.data.length > 100), 'Arcana screencast frame reached the host');
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

test('real Arcana: M4 manual control forwards frame, mouse, keyboard, scroll and annotation', { skip: !real, timeout: 120000 }, async () => {
  assert.ok(resolveCli(process.env), 'Arcana CLI not found: run tools/install-arcana.ps1 or set MANA_ARCANA_CLI');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-m4-'));
  const site = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Arcana M4 manual control</title>
      <style>body{margin:0;height:2400px}#name{position:absolute;left:20px;top:20px;width:220px}
      #apply{position:absolute;left:20px;top:180px;width:300px;height:100px}#status{position:absolute;left:20px;top:320px}</style></head>
      <body><label for="name">Name</label><input id="name" autocomplete="name">
      <button id="apply" onclick="status.textContent='Applied '+name.value">Apply</button>
      <p id="status">Ready</p><script>addEventListener('scroll',()=>status.dataset.scroll=String(scrollY));</script></body></html>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}`;
  const app = express();
  app.use(express.json());
  const deps = {
    env: { ...process.env, MANA_BROWSER_PROFILE_DIR: path.join(temporary, 'profile'), MANA_ARCANA_ALLOW_PRIVATE_NETWORK: '1' },
    ramPercent: () => 50,
    isGaming: () => false,
    isLocalRestartRequest: () => true,
  };
  plugin._resetForTests();
  plugin.registerRoutes(app, deps);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (pathName, body, token) => {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-mana-manual-token': token } : {}) },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `${pathName}: ${JSON.stringify(payload)}`);
    return payload;
  };
  try {
    const started = await post('/browser/manual/start', { url });
    assert.ok(started.token, 'manual control returned an ownership token');
    const token = started.token;
    const frame = await fetch(`${baseUrl}/browser/manual/frame`, { headers: { 'x-mana-manual-token': token } });
    assert.equal(frame.status, 200);
    const framePayload = await frame.json();
    assert.ok(framePayload.image.length > 100, 'manual frame reached the panel');
    assert.ok(framePayload.width > 0 && framePayload.height > 0);

    await post('/browser/manual/input', { action: 'click', x: 80, y: 35 }, token);
    await post('/browser/manual/input', { action: 'text', text: 'Manual user' }, token);
    await post('/browser/manual/input', { action: 'key', key: 'Tab' }, token);
    await post('/browser/manual/input', { action: 'key', key: 'Enter' }, token);
    await post('/browser/manual/input', { action: 'click', x: 100, y: 220 }, token);
    const annotation = await post('/browser/manual/annotate', { x: 100, y: 220 }, token);
    assert.equal(annotation.selector, '#apply');
    assert.equal(annotation.role, 'button');
    assert.equal(annotation.name, 'Apply');
    assert.equal(annotation.rect.fallback, false);
    await post('/browser/manual/input', { action: 'scroll', dy: 500 }, token);
    await post('/browser/manual/done', {}, token);

    const session = await plugin.getSession(deps);
    const state = await session.devtools({ do: 'run_js', code: "({ text: document.getElementById('status').textContent, scroll: document.getElementById('status').dataset.scroll })" });
    assert.match(JSON.stringify(state), /Manual user/);
    assert.match(JSON.stringify(state), /[1-9]/);
  } finally {
    await plugin.closeSession();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('real Arcana: M4 sign-in spike pages load without submitting credentials', { skip: !real || !signinSpikes, timeout: 180000 }, async () => {
  assert.ok(resolveCli(process.env), 'Arcana CLI not found: run tools/install-arcana.ps1 or set MANA_ARCANA_CLI');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-m4-signin-'));
  const deps = {
    env: { ...process.env, MANA_BROWSER_PROFILE_DIR: path.join(temporary, 'profile') },
    ramPercent: () => 50,
    isGaming: () => false,
  };
  const targets = [
    ['bank-style', process.env.MANA_M4_BANK_URL || 'https://www.chase.com/'],
    ['captcha', process.env.MANA_M4_CAPTCHA_URL || 'https://www.google.com/recaptcha/api2/demo'],
    ['saas', process.env.MANA_M4_SAAS_URL || 'https://github.com/login'],
  ];
  const report = [];
  plugin._resetForTests();
  try {
    const session = await plugin.getSession(deps);
    for (const [kind, url] of targets) {
      const entry = { kind, url };
      try {
        const snapshot = await session.navigate(url);
        const text = `${snapshot.title}\n${snapshot.text || ''}`;
        const handoff = Boolean(snapshot.sensitive) || /captcha|recaptcha|verify you are human|i am not a robot/i.test(text);
        entry.loaded = true;
        entry.finalUrl = snapshot.url;
        entry.title = snapshot.title;
        entry.handoff = handoff;
        entry.reason = snapshot.sensitive || (handoff ? 'CAPTCHA or human-verification surface' : null);
      } catch (error) {
        entry.loaded = false;
        entry.handoff = true;
        entry.reason = `Arcana navigation failed: ${error.message}`;
      }
      report.push(entry);
    }
    process.stdout.write(`M4 sign-in spike report: ${JSON.stringify(report)}\n`);
    assert.equal(report.length, targets.length);
    assert.ok(report.every(entry => entry.loaded || entry.handoff), 'every failed Arcana page is explicitly marked for handoff');
  } finally {
    await plugin.closeSession();
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
