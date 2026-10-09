const { randomBytes } = require('node:crypto');
const { createExtensionTransport } = require('./extension-transport');
const { createBrowserSession } = require('./browser-automation');

async function createPersonalBrowser({ sessionId, origins, chromium, runAgent, isPaused }) {
  const bridge = await createExtensionTransport({ sessionId, origins });
  const identity = randomBytes(16).toString('hex');
  let browser = null;
  let connecting = null;
  let context = null;
  let page = null;
  let generation = 0;
  let closing = false;
  let closingTask = null;
  const pageSessions = new Map();
  const invalidated = new Set();
  function invalidate() {
    generation += 1;
    const listeners = [...invalidated];
    invalidated.clear();
    for (const listener of listeners) listener();
  }

  async function connect() {
    if (!bridge.isConnected()) throw new Error('Connect the selected Chrome tabs using the code in Mana');
    if (browser) return;
    connecting ||= (async () => {
      const result = await chromium.connectOverCDP(bridge.transport, { noDefaults: true, timeout: 15000 });
      if (closing || bridge.isClosed()) { await result.close(); throw new Error('Personal-browser access ended'); }
      browser = result;
      context = result.contexts()[0];
      page = context?.pages()[0];
      if (!page) { bridge.close(); await result.close(); throw new Error('No selected Chrome tab is available'); }
    })().finally(() => { connecting = null; });
    await connecting;
  }
  async function close() {
    if (closing) return closingTask;
    closing = true;
    invalidate();
    closingTask = (async () => {
      await bridge.shutdown().catch(() => {});
      if (connecting) await connecting.catch(() => {});
      // CDP Browser.close() disconnects the transport, not the user's Chrome.
      if (browser) await browser.close().catch(() => {});
      browser = null; context = null; page = null;
      pageSessions.clear();
    })();
    await closingTask;
  }
  async function withTabs(result) {
    if (!result || typeof result !== 'object' || !context || context.pages().length < 2) return result;
    const pages = context.pages();
    return { ...result, tabs: await Promise.all(pages.map(async (tab, i) => `${i + 1}. ${await tab.title()} -- ${tab.url()}${tab === page ? ' (current)' : ''}`)) };
  }
  async function getSession(deps) {
    if (closing || bridge.isClosed()) throw new Error('Personal-browser access ended');
    if (deps.sessionId !== sessionId) throw new Error('Your personal browser is connected to a different chat');
    await connect();
    const before = generation;
    const boundPage = page;
    if (!pageSessions.has(boundPage)) pageSessions.set(boundPage, createBrowserSession({ page: boundPage, cursor: () => Boolean(deps.isWatched?.()) }));
    const core = pageSessions.get(boundPage);
    function assertActive() {
      if (closing || bridge.isClosed() || before !== generation || page !== boundPage || boundPage.isClosed() || isPaused()) throw new Error('Browser ownership changed; get a fresh page snapshot');
    }
    const facade = {
      personal: true, identity, sessionId,
      onInvalidated(callback) {
        if (before !== generation || closing || bridge.isClosed()) callback();
        else invalidated.add(callback);
        return () => invalidated.delete(callback);
      },
    };
    for (const name of ['navigate', 'click', 'type', 'select', 'scroll', 'hover', 'press', 'drag', 'back', 'find', 'snapshot', 'screenshot', 'url', 'lookAndClick']) {
      if (typeof core[name] !== 'function') continue;
      facade[name] = (...args) => runAgent(async () => { assertActive(); return withTabs(await core[name](...args)); });
    }
    facade.tab = args => runAgent(async () => {
      assertActive();
      if (args?.do !== 'switch') throw new Error('Select personal tabs in the extension; Mana does not create or close your tabs');
      const pages = context.pages();
      if (!Number.isInteger(args.number) || args.number < 1 || args.number > pages.length) throw new Error('Unknown selected tab');
      page = pages[args.number - 1];
      invalidate();
      if (!pageSessions.has(page)) pageSessions.set(page, createBrowserSession({ page }));
      return withTabs(await pageSessions.get(page).snapshot());
    });
    facade.devtools = async () => { throw new Error('Use the dedicated Mana browser for developer tools and site tests'); };
    facade.testPage = facade.devtools;
    facade.upload = async () => { throw new Error('Take over to upload files in your personal browser'); };
    return facade;
  }
  bridge.setOnEnded(() => { void close().catch(() => {}); });
  return {
    ...bridge, identity, getSession, close,
    getContext: () => bridge.isClosed() ? null : context,
    getPage: () => bridge.isClosed() ? null : page,
    invalidate,
  };
}

module.exports = { createPersonalBrowser };
