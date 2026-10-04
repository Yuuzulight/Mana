const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('extension shutdown waits for in-flight attachment and detaches before acknowledging', async () => {
  let finishAttach;
  const attaching = new Promise(resolve => { finishAttach = resolve; });
  const calls = [];
  const event = { addListener() {} };
  const chrome = {
    debugger: { onEvent: event, onDetach: event, attach: () => attaching, detach: async target => calls.push(['detach', target.tabId]) },
    tabs: { onUpdated: event, onRemoved: event, get: async id => ({ id, url: 'https://site.test' }) },
    storage: { session: { set: async () => calls.push(['store']), remove: async () => calls.push(['remove']) } },
    action: { setBadgeText: async () => {} }, runtime: { onMessage: event },
  };
  const context = vm.createContext({ chrome, URL, WebSocket: { OPEN: 1 }, clearInterval, setInterval });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../browser-control-extension/background.js'), 'utf8'), context);
  context.calls = calls;
  vm.runInContext(`connection = { selected: new Set([1]), attached: new Set(), attaching: new Set(), origins: [], stopped: false, heartbeat: null, ws: { readyState: 1, close() { calls.push(['close']); }, send(text) { calls.push(['send', JSON.parse(text)]); } } };`, context);
  const attach = vm.runInContext(`command(connection, {id:1, method:'chrome.debugger.attach', params:[{tabId:1}]})`, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('connection.attaching.size', context), 1);
  const stopped = vm.runInContext(`command(connection, {id:2, method:'extension.disconnect', params:[]})`, context);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  finishAttach();
  await attach; await stopped;
  assert.ok(calls.find(entry => entry[0] === 'detach' && entry[1] === 1));
  assert.equal(calls.some(entry => entry[0] === 'store'), false);
  const ack = calls.findIndex(entry => entry[0] === 'send' && entry[1].id === 2);
  assert.ok(ack > calls.findIndex(entry => entry[0] === 'detach'));
  assert.equal(calls.at(-1)[0], 'close');
});
