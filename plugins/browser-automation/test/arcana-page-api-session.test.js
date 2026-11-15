const test = require('node:test');
const assert = require('node:assert/strict');
const { createArcanaPageApiSession } = require('../arcana-page-api-session');

function clientFor(overrides = {}) {
  const calls = [];
  let sensitive = null;
  let current = { url: 'about:blank', title: '', text: '', elements: [] };
  const client = {
    calls,
    setSnapshot(value) { current = value; },
    setSensitive(value) { sensitive = value; },
    async snapshot() { return current; },
    async evaluate(_pageId, expression) { calls.push(['evaluate', expression]); return sensitive; },
    async navigate(_pageId, url) { calls.push(['navigate', url]); current = { ...current, url }; },
    async click(_pageId, ref) { calls.push(['click', ref]); },
    async fill(_pageId, ref, value) { calls.push(['fill', ref, value]); },
    async select(_pageId, ref, value) { calls.push(['select', ref, value]); },
    async press(_pageId, key) { calls.push(['press', key]); },
    async scroll(_pageId, dx, dy) { calls.push(['scroll', dx, dy]); },
    async back() { calls.push(['back']); },
    async screenshot() { return Buffer.from('image'); },
    ...overrides,
  };
  return client;
}

test('Page API session formats snapshots and routes supported actions by ref', async () => {
  const client = clientFor();
  client.setSnapshot({ url: 'https://example.test', title: 'Example', text: 'Hello', elements: [
    { role: 'textbox', name: 'Search', reference: 'e1' },
    { role: 'button', name: 'Go', reference: 'e2' },
  ] });
  const session = createArcanaPageApiSession(client, 'page-1');
  const view = await session.snapshot();
  assert.deepEqual(view.elements, ['textbox "Search" [ref=e1]', 'button "Go" [ref=e2]']);
  assert.deepEqual((await session.find('Go button')).matches, ['button "Go" [ref=e2]']);
  await session.navigate('https://example.test/path');
  await session.click('e2');
  await session.type('e1', 'query', true);
  await session.select('e1', 'all');
  await session.scroll('down');
  await session.back();
  assert.ok(client.calls.some(call => call[0] === 'navigate' && call[1] === 'https://example.test/path'));
  assert.ok(client.calls.some(call => call[0] === 'click' && call[1] === 'e2'));
  assert.ok(client.calls.some(call => call[0] === 'fill' && call[1] === 'e1' && call[2] === 'query'));
  assert.ok(client.calls.some(call => call[0] === 'press' && call[1] === 'Enter'));
  await assert.rejects(async () => session.hover('e1'), /not supported by the Arcana Page API session/);
});

test('Page API session keeps the fresh sensitive-page credential gate fail closed', async () => {
  const client = clientFor();
  client.setSensitive('a password');
  const session = createArcanaPageApiSession(client, 'page-1');
  await assert.rejects(session.type('e1', 'secret'), /the user's to do/);
  await assert.rejects(session.click('e2'), /the user's to do/);
  assert.equal(client.calls.some(call => ['click', 'fill'].includes(call[0])), false);
});

test('Page API session acts only on references in its latest snapshot', async () => {
  const client = clientFor();
  client.setSnapshot({ url: 'about:blank', title: '', text: '', elements: [{ role: 'button', name: 'Old', reference: 'e1' }] });
  const session = createArcanaPageApiSession(client, 'page-1');
  await session.snapshot();
  client.setSnapshot({ url: 'about:blank', title: '', text: '', elements: [{ role: 'button', name: 'New', reference: 'e2' }] });
  await session.snapshot();
  await assert.rejects(session.click('e1'), /isn't a ref from the latest page snapshot/);
  assert.equal(client.calls.some(call => call[0] === 'click'), false);
});
