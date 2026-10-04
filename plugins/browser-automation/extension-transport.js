const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer } = require('../../node-bot/node_modules/ws');

const PAIR_MS = 5 * 60 * 1000;
const IDLE_MS = 5 * 60 * 1000;
const COMMAND_MS = 15000;
const MAX_PENDING = 64;

function allowedUrl(url, origins) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && (!origins.length || origins.includes(parsed.origin));
  } catch { return false; }
}

// Adapt chrome.debugger's tab-scoped CDP to Playwright's public transport API.
// Only tabs explicitly selected in the extension become visible to Playwright.
async function createExtensionTransport({ sessionId, origins = [], now = Date.now, commandMs = COMMAND_MS, idleMs = IDLE_MS }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Choose a chat before connecting your browser');
  if (!Array.isArray(origins) || origins.length > 32 || origins.some(origin => !allowedUrl(origin, []) || new URL(origin).origin !== origin)) throw new Error('Allowed sites must be exact http(s) origins');
  origins = [...new Set(origins)];
  const secret = randomBytes(24).toString('hex');
  const expires = now() + PAIR_MS;
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  let peer = null;
  let ready = false;
  let closed = false;
  let nextId = 0;
  let lastUsed = now();
  let attaching = null;
  let browserVersion = { protocolVersion: '1.3', product: 'Chrome/125.0.0.0', userAgent: 'Mana Chrome connection' };
  const pending = new Map();
  const tabs = new Map();
  const children = new Map();
  const commandQueues = new Map();
  let queuedCommands = 0;
  let cleanupTimer;
  let onEnded = () => {};
  let resolveReady;
  let rejectReady;
  const connected = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A user may cancel before any caller awaits the connection.
  connected.catch(() => {});

  const transport = {
    onmessage: undefined,
    onclose: undefined,
    send(message) {
      if (closed) return;
      if (queuedCommands >= MAX_PENDING) { close('Too many pending browser commands'); return; }
      queuedCommands += 1;
      const key = message.sessionId || 'root';
      // chrome.debugger calls are asynchronous; preserve CDP's per-session
      // ordering so Runtime events cannot overtake Page.getFrameTree's reply.
      const running = (commandQueues.get(key) || Promise.resolve()).then(async () => {
        try { emit({ id: message.id, sessionId: message.sessionId, result: await dispatch(message) }); }
        catch (error) { emit({ id: message.id, sessionId: message.sessionId, error: { message: error.message } }); }
      }).finally(() => {
        queuedCommands -= 1;
        if (commandQueues.get(key) === running) commandQueues.delete(key);
      });
      commandQueues.set(key, running);
    },
    close: () => close('Mana disconnected'),
  };
  function emit(message) { if (!closed) transport.onmessage?.(message); }
  function close(reason = 'Browser access ended') {
    if (closed) return;
    closed = true;
    ready = false;
    clearInterval(cleanupTimer);
    rejectReady(new Error(reason));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
    tabs.clear();
    children.clear();
    commandQueues.clear();
    if (peer) { peer.close(1000, reason.slice(0, 100)); peer.terminate(); peer = null; }
    sockets.close();
    server.close();
    server.closeAllConnections();
    transport.onclose?.(reason);
    onEnded(reason);
  }
  function call(method, params = [], timeoutMs = commandMs) {
    if (closed || !ready || !peer || peer.readyState !== 1) return Promise.reject(new Error('Your Chrome extension is not connected'));
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending browser commands'));
    lastUsed = now();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { close('Browser command timed out'); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      peer.send(JSON.stringify({ id, method, params }));
    });
  }
  async function attachAll() {
    for (const tab of tabs.values()) {
      if (tab.attached) continue;
      await call('chrome.debugger.attach', [{ tabId: tab.id }, '1.3']);
      const result = await call('chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.getTargetInfo', {}]);
      tab.info = { ...result.targetInfo, type: 'page', attached: true };
      tab.attached = true;
      emit({ method: 'Target.attachedToTarget', params: { sessionId: tab.session, targetInfo: tab.info, waitingForDebugger: false } });
    }
  }
  async function dispatch({ method, params = {}, sessionId: cdpSession }) {
    if (closed || !ready) throw new Error('Your Chrome extension is not connected');
    if (!cdpSession) {
      if (method === 'Browser.getVersion') return browserVersion;
      if (method === 'Browser.setDownloadBehavior') return {};
      if (method === 'Target.setAutoAttach') { attaching ||= attachAll(); await attaching; return {}; }
      if (method === 'Target.getTargets') return { targetInfos: [...tabs.values()].filter(t => t.info).map(t => t.info) };
      if (method === 'Target.getTargetInfo') return { targetInfo: [...tabs.values()].find(t => t.info)?.info };
      if (method === 'Target.setDiscoverTargets') return {};
      if (method === 'Browser.close') { close(); return {}; }
      throw new Error('Personal-browser access is limited to the tabs you selected');
    }
    const tab = [...tabs.values()].find(t => t.session === cdpSession) || tabs.get(children.get(cdpSession));
    if (!tab || !tab.attached || !allowedUrl(tab.url, origins)) throw new Error('This tab is no longer authorized');
    if (method === 'Target.getTargetInfo') return { targetInfo: tab.info };
    if (method === 'Page.navigate' && !allowedUrl(params.url, origins)) throw new Error('That site is outside your browser allowlist');
    if (method === 'Target.setAutoAttach') params = { ...params, filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }] };
    if (['Browser', 'Storage'].includes(method.split('.')[0]) || ['Network.getAllCookies', 'Network.getCookies', 'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies', 'Page.setDownloadBehavior'].includes(method)) throw new Error('Personal-browser cookies and global browser settings are not available to Mana');
    return call('chrome.debugger.sendCommand', [{ tabId: tab.id, ...(cdpSession !== tab.session ? { sessionId: cdpSession } : {}) }, method, params]);
  }
  function event({ method, params }) {
    if (method === 'extension.initialized') {
      if (ready || !Array.isArray(params?.tabs) || params.tabs.length < 1 || params.tabs.length > 5) throw new Error('Select between one and five tabs');
      if (typeof params.userAgent === 'string') {
        const version = /(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(params.userAgent.slice(0, 1024));
        if (!version || Number(version[1].split('.')[0]) < 125) throw new Error('Chrome 125 or later is required');
        browserVersion = { protocolVersion: '1.3', product: `Chrome/${version[1]}`, userAgent: params.userAgent.slice(0, 1024) };
      }
      for (const tab of params.tabs) {
        if (!Number.isSafeInteger(tab.id) || tab.id < 0 || tabs.has(tab.id) || !allowedUrl(tab.url, origins)) throw new Error('Selected tab is not authorized');
        tabs.set(tab.id, { id: tab.id, url: tab.url, session: `mana-tab-${tab.id}`, attached: false });
      }
      ready = true;
      resolveReady(transport);
      return;
    }
    if (method === 'extension.heartbeat') return;
    if (method === 'extension.tabUrl') {
      const tab = tabs.get(params?.tabId);
      if (!tab) return;
      if (!allowedUrl(params.url, origins)) { close('The selected tab left your allowed sites'); return; }
      tab.url = params.url;
      if (tab.info) tab.info.url = params.url;
      return;
    }
    if (method === 'chrome.debugger.onDetach') { close('Chrome detached Mana from the selected tab'); return; }
    if (method !== 'chrome.debugger.onEvent' || !Array.isArray(params)) throw new Error('Unknown extension event');
    const [source, cdpMethod, cdpParams] = params;
    const tab = tabs.get(source?.tabId);
    if (!tab?.attached) return;
    if (cdpMethod === 'Page.frameNavigated' && !cdpParams.frame?.parentId && !allowedUrl(cdpParams.frame?.url, origins)) { close('The selected tab left your allowed sites'); return; }
    if (cdpMethod === 'Target.attachedToTarget') {
      if (!['iframe', 'worker'].includes(cdpParams.targetInfo?.type)) {
        void (async () => {
          if (cdpParams.waitingForDebugger) await call('chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: cdpParams.sessionId }, 'Runtime.runIfWaitingForDebugger', {}]);
          await call('chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.detachFromTarget', { sessionId: cdpParams.sessionId }]);
        })().catch(() => close('Unexpected personal-browser target'));
        return;
      }
      children.set(cdpParams.sessionId, tab.id);
    }
    if (cdpMethod === 'Target.detachedFromTarget') children.delete(cdpParams.sessionId);
    if (source.sessionId && children.get(source.sessionId) !== tab.id) return;
    emit({ sessionId: source.sessionId || tab.session, method: cdpMethod, params: cdpParams });
  }
  server.on('upgrade', (req, socket, head) => {
    const presented = Buffer.from(String(req.headers['sec-websocket-protocol'] || ''));
    const expected = Buffer.from(secret);
    const valid = !closed && !peer && now() < expires && req.url === '/extension' && /^chrome-extension:\/\/[a-p]{32}$/.test(String(req.headers.origin || '')) && presented.length === expected.length && timingSafeEqual(presented, expected);
    if (!valid) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      peer = ws;
      ws.on('error', () => close('Chrome connection failed'));
      ws.on('close', () => close('Chrome connection ended'));
      ws.on('message', data => {
        try {
          const message = JSON.parse(data.toString());
          if (Number.isSafeInteger(message.id)) {
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error(String(message.error).slice(0, 500)));
            else entry.resolve(message.result);
          } else event(message);
        } catch { close('Invalid Chrome connection message'); }
      });
      ws.send(JSON.stringify({ method: 'extension.configure', params: { origins } }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanupTimer = setInterval(() => { if ((!ready && now() >= expires) || (ready && now() - lastUsed >= idleMs)) close('Browser access expired'); }, 1000);
  cleanupTimer.unref();
  return {
    sessionId, origins, transport, connected, close,
    setOnEnded: callback => { onEnded = callback; },
    async shutdown() {
      if (!closed && ready) {
        try { await call('extension.disconnect', [], Math.min(commandMs, 2000)); }
        finally { close(); }
      } else close();
    },
    connectionCode: `${server.address().port}:${secret}`,
    isConnected: () => ready && !closed,
    isClosed: () => closed,
  };
}

module.exports = { createExtensionTransport, allowedUrl };
