const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const enginePath = require.resolve('../arcana-engine');
const engine = require('../arcana-engine');
let starts = 0;
const children = [];
const handoffs = [];
require.cache[enginePath].exports = {
  ...engine,
  async openArcanaDefaultBrowser(_env, url) { handoffs.push(url); },
  async startArcanaPageApi() {
    starts += 1;
    const child = new EventEmitter();
    child.exitCode = null;
    children.push(child);
    const pageId = `page-${starts}`;
    return {
      backend: 'folio', child,
      client: {
        async createPage() { return { pageId }; },
        async closePage() {},
        async snapshot() { return { url: 'about:blank', title: `Page ${pageId}`, text: 'Ready', elements: [] }; },
        async evaluate() { return null; },
      },
      async stop() { child.exitCode = 0; child.emit('exit', 0, null); },
    };
  },
};
const plugin = require('../index');

test('unexpected Arcana Page API exit invalidates the cached session and next call restarts', async () => {
  const deps = {
    env: { MANA_ARCANA_TRANSPORT: 'page-api', MANA_BROWSER_PROFILE_DIR: require('node:os').tmpdir() },
    ramPercent: () => 20, isGaming: () => false,
  };
  plugin._resetForTests();
  try {
    const stale = await plugin.getSession(deps);
    assert.equal((await stale.snapshot()).title, 'Page page-1');
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    await assert.rejects(stale.snapshot(), /session has closed/);
    const restarted = await plugin.getSession(deps);
    assert.equal((await restarted.snapshot()).title, 'Page page-2');
    assert.equal(starts, 2);
  } finally {
    await plugin.closeSession();
  }
});

test('explicit Page API takeover hands the requested URL to the OS browser and closes the managed session', async () => {
  const deps = {
    env: { MANA_ARCANA_TRANSPORT: 'page-api', MANA_BROWSER_PROFILE_DIR: require('node:os').tmpdir() },
    ramPercent: () => 20, isGaming: () => false,
  };
  plugin._resetForTests();
  try {
    const managed = await plugin.getSession(deps);
    const activeChild = children.at(-1);
    plugin.requestHandOver('Folio refused navigation', { ...deps, isGaming: () => true }, 'https://example.test/login');
    assert.equal(handoffs.length, 0);
    await plugin.takeOver(deps, 'https://old-page.test/');
    assert.deepEqual(handoffs, ['https://example.test/login']);
    assert.equal(activeChild.exitCode, 0);
    await assert.rejects(managed.snapshot(), /session has closed/);
    assert.deepEqual(plugin.takeOverStatus(), { active: false, needsYou: null });
  } finally {
    await plugin.closeSession();
    require.cache[enginePath].exports = engine;
  }
});
