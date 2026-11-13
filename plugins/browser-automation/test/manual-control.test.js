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

test('annotation rejects points outside the live viewport', async () => {
  const { control } = fixture();
  const { token } = await control.takeOver({});
  await assert.rejects(() => control.annotate(token, { x: 800, y: 1 }), /outside the page/);
});

test('annotation scrubs the selected form control itself before returning markup', async () => {
  class FakeHTMLElement {}
  class FakeControl extends FakeHTMLElement {
    constructor(tagName, attributes = {}, text = '', value = '', children = []) {
      super();
      this.tagName = tagName.toUpperCase();
      this.attributes = { ...attributes };
      this._text = text;
      this.value = value;
      this.isContentEditable = false;
      this.id = '';
      this.children = children;
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    getBoundingClientRect() { return { x: 1, y: 1, width: 20, height: 10 }; }
    matches(selector) { return selector.split(',').some(part => part.trim() === this.tagName.toLowerCase() || (part.trim() === '[contenteditable]' && Object.hasOwn(this.attributes, 'contenteditable'))); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    cloneNode() { return new FakeControl(this.tagName, this.attributes, this._text, this.value, this.children.map(child => child.cloneNode(true))); }
    get outerHTML() {
      const attrs = Object.entries(this.attributes).map(([name, value]) => ` ${name}="${value}"`).join('');
      const text = this.tagName === 'TEXTAREA' ? this.textContent : this._text + this.children.map(child => child.outerHTML).join('');
      return `<${this.tagName.toLowerCase()}${attrs}>${text}</${this.tagName.toLowerCase()}>`;
    }
  }

  const originalHTMLElement = global.HTMLElement;
  const originalDocument = global.document;
  try {
    global.HTMLElement = FakeHTMLElement;
    const inheritedEditable = new FakeControl('div', {}, 'private editable text');
    inheritedEditable.isContentEditable = true;
    for (const element of [
      new FakeControl('textarea', {}, 'private text entered by the user', 'private text entered by the user'),
      new FakeControl('input', { name: 'search', value: 'private query entered by the user' }, '', 'private query entered by the user'),
      inheritedEditable,
      new FakeControl('div', {}, 'Comment: ', '', [new FakeControl('textarea', {}, 'nested private text')]),
    ]) {
      global.document = { elementFromPoint: () => element };
      const { control, page } = fixture();
      page.evaluate = async (fn, point) => fn(point);
      const { token } = await control.takeOver({});
      const result = await control.annotate(token, { x: 2, y: 2 });
      assert.doesNotMatch(result.markup, /private text entered by the user|private query entered by the user|private editable text|nested private text/);
      assert.doesNotMatch(result.name, /private text entered by the user|private query entered by the user|private editable text|nested private text/);
      if (element.tagName === 'DIV' && element.children.length) assert.equal(result.name, 'Comment:');
    }
  } finally {
    if (originalHTMLElement === undefined) delete global.HTMLElement;
    else global.HTMLElement = originalHTMLElement;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
});
