let connection = null;
let starting = false;
let lastCleanup = Promise.resolve();

function allowed(url, origins) {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && (!origins.length || origins.includes(u.origin)); }
  catch { return false; }
}

async function disconnect(current = connection, closeSocket = true) {
  if (!current) { await lastCleanup; return; }
  if (current.stopped) { await current.cleanup; return; }
  current.stopped = true;
  if (connection === current) connection = null;
  clearInterval(current.heartbeat);
  current.cleanup = (async () => {
    await Promise.allSettled([...current.attaching]);
    await Promise.allSettled([...current.attached].map(tabId => chrome.debugger.detach({ tabId })));
    current.attached.clear();
    if (!connection) {
      await chrome.storage.session.remove('attachedTabs');
      await chrome.action.setBadgeText({ text: '' });
    }
    if (closeSocket) current.ws.close();
  })();
  lastCleanup = current.cleanup;
  await current.cleanup;
}

async function ensureTab(current, tabId) {
  if (connection !== current || current.stopped || !current.selected.has(tabId)) throw new Error('This tab was not selected for Mana');
  const tab = await chrome.tabs.get(tabId);
  if (!allowed(tab.url, current.origins)) {
    await disconnect(current);
    throw new Error('This tab left the allowed sites');
  }
  if (connection !== current || current.stopped) throw new Error('Browser access ended');
  return tab;
}

async function command(current, { id, method, params }) {
  try {
    if (!Array.isArray(params)) throw new Error('Invalid command');
    if (method === 'extension.disconnect') {
      await disconnect(current, false);
      if (current.ws.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ id, result: { detached: true } }));
      current.ws.close();
      return;
    }
    const target = params[0];
    await ensureTab(current, target?.tabId);
    let result;
    if (method === 'chrome.debugger.attach') {
      const attaching = chrome.debugger.attach({ tabId: target.tabId }, '1.3');
      current.attaching.add(attaching);
      try { await attaching; }
      finally { current.attaching.delete(attaching); }
      current.attached.add(target.tabId);
      if (current.stopped) {
        await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
        throw new Error('Browser access ended');
      }
      await chrome.storage.session.set({ attachedTabs: [...current.attached] });
      result = {};
    } else if (method === 'chrome.debugger.sendCommand') {
      if (!current.attached.has(target.tabId)) throw new Error('This tab is not attached');
      if (params[1] === 'Page.navigate' && !allowed(params[2]?.url, current.origins)) throw new Error('This site is not allowed');
      result = await chrome.debugger.sendCommand(target, params[1], params[2] || {});
    } else throw new Error('Unknown browser command');
    send(current, { id, result: result || {} });
  } catch (error) { send(current, { id, error: error.message }); }
}

function send(current, message) {
  if (!current.stopped && current.ws.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify(message));
}

async function connect(code, tabIds) {
  if (starting) throw new Error('Connection is already changing');
  starting = true;
  try {
    if (typeof code !== 'string' || !/^\d{1,5}:[a-f0-9]{48}$/.test(code)) throw new Error('Enter the connection code shown in Mana');
    const [port, token] = code.split(':');
    if (+port < 1 || +port > 65535) throw new Error('Invalid connection port');
    if (!Array.isArray(tabIds) || !tabIds.length || tabIds.length > 5 || tabIds.some(id => !Number.isSafeInteger(id))) throw new Error('Select between one and five tabs');
    await disconnect();
    // Detach leftovers if Chrome restarted the extension worker.
    const previous = await chrome.storage.session.get('attachedTabs');
    await Promise.allSettled((previous.attachedTabs || []).map(tabId => chrome.debugger.detach({ tabId })));
    const selectedTabs = await Promise.all([...new Set(tabIds)].map(id => chrome.tabs.get(id)));
    if (selectedTabs.some(tab => !allowed(tab.url, []))) throw new Error('Only web tabs can be connected');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, token);
    const current = { ws, selected: new Set(tabIds), attached: new Set(), attaching: new Set(), origins: [], stopped: false, heartbeat: null };
    connection = current;
    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.method === 'extension.configure') {
          if (!Array.isArray(message.params?.origins)) throw new Error('Invalid site configuration');
          current.origins = message.params.origins;
          if (selectedTabs.some(tab => !allowed(tab.url, current.origins))) throw new Error('A selected tab is outside the allowed sites');
          send(current, { method: 'extension.initialized', params: { tabs: selectedTabs.map(tab => ({ id: tab.id, url: tab.url })), userAgent: navigator.userAgent } });
          current.heartbeat = setInterval(() => send(current, { method: 'extension.heartbeat' }), 20000);
          void chrome.action.setBadgeText({ text: 'ON' });
        } else if (Number.isSafeInteger(message.id)) void command(current, message);
        else throw new Error('Invalid browser message');
      } catch { void disconnect(current); }
    };
    ws.onclose = () => { void disconnect(current); };
    ws.onerror = () => { void disconnect(current); };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void disconnect(current); reject(new Error('Mana connection timed out')); }, 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Mana rejected the connection; request a new code')); }, { once: true });
    });
  } finally { starting = false; }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const current = connection;
  if (!current?.attached.has(source.tabId)) return;
  if (method === 'Page.frameNavigated' && !params.frame?.parentId && !allowed(params.frame?.url, current.origins)) { void disconnect(current); return; }
  send(current, { method: 'chrome.debugger.onEvent', params: [source, method, params] });
});
chrome.debugger.onDetach.addListener(source => {
  const current = connection;
  if (current?.attached.has(source.tabId)) void disconnect(current);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const current = connection;
  if (!current?.selected.has(tabId) || !change.url) return;
  if (!allowed(change.url, current.origins)) { void disconnect(current); return; }
  send(current, { method: 'extension.tabUrl', params: { tabId, url: change.url } });
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (connection?.selected.has(tabId)) void disconnect();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  const run = async () => {
    if (message.type === 'status') return { connected: Boolean(connection && !connection.stopped && connection.ws.readyState === WebSocket.OPEN) };
    if (message.type === 'disconnect') await disconnect();
    else if (message.type === 'connect') await connect(message.code, message.tabIds);
    else throw new Error('Unknown extension request');
    return { ok: true };
  };
  run().then(respond, error => respond({ error: error.message }));
  return true;
});
