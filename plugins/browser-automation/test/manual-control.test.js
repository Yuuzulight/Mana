const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createManualControl } = require('../manual-control');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  const ctx = {};
  const events = [];
  const page = {
    viewportSize: () => ({ width: 800, height: 600 }), url: () => 'https://site.test',
    screenshot: async () => Buffer.from('image'),
    mouse: { click: async (...args) => events.push(args), wheel: async (...args) => events.push(args) },
    keyboard: { insertText: async text => events.push(text), press: async key => events.push(key) },
  };
  const control = createManualControl({ prepare: async () => {}, getContext: () => ctx, getPage: () => page, resume: async () => events.push('resume'), ...overrides });
  return { control, events, page };
}

test('manual tokens expire on Done and never accept missing or forged tokens', async () => {
  const { control, events } = fixture();
  const { token } = await control.takeOver({});
  await assert.rejects(control.input('', { action: 'click', x: 1, y: 2 }));
  await assert.rejects(control.frame('bad'));
  assert.equal((await control.frame(token)).width, 800);
  await control.input(token, { action: 'text', text: 'private login' });
  await control.handBack(token);
  assert.equal(control.isActive(), false);
  await assert.rejects(control.input(token, { action: 'text', text: 'late' }));
  assert.deepEqual(events, ['private login', 'resume']);
});

test('takeover reserves ownership before asynchronous preparation and cancellation cannot resurrect it', async () => {
  const wait = deferred();
  const { control } = fixture({ prepare: () => wait.promise });
  const start = control.takeOver({});
  assert.equal(control.isActive(), true);
  await assert.rejects(control.takeOver({}), /changing/);
  control.clear();
  wait.resolve();
  await assert.rejects(start, /No page/);
  assert.equal(control.isActive(), false);
});

test('Done rejects queued input and pauses the agent until the current input finishes', async () => {
  const wait = deferred();
  const { control, page, events } = fixture();
  const { token } = await control.takeOver({});
  page.mouse.click = () => wait.promise;
  const first = control.input(token, { action: 'click', x: 1, y: 2 });
  await Promise.resolve();
  const queued = control.input(token, { action: 'text', text: 'cancel me' });
  const rejected = assert.rejects(queued, /no longer active/);
  const done = control.handBack(token);
  assert.equal(control.isActive(), true);
  assert.deepEqual(events, []);
  wait.resolve();
  await first;
  await rejected;
  await done;
  assert.deepEqual(events, ['resume']);
  assert.equal(control.isActive(), false);
});

test('invalid viewport coordinates and unbounded key or text input are rejected', async () => {
  const { control } = fixture();
  const { token } = await control.takeOver({});
  for (const command of [{ action: 'click', x: 800, y: 1 }, { action: 'click', x: NaN, y: 1 }, { action: 'scroll', dy: 2001 }, { action: 'key', key: 'F99' }, { action: 'text', text: 'x'.repeat(4097) }]) await assert.rejects(control.input(token, command));
});
