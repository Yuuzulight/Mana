const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const enginePath = require.resolve('../arcana-engine');
const engine = require('../arcana-engine');
let starts = 0;
const children = [];
require.cache[enginePath].exports = {
  ...engine,
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
    require.cache[enginePath].exports = engine;
  }
});
