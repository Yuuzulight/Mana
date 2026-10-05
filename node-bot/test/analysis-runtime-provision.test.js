const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { download } = require('../../desktop-client/scripts/prepare-portable-python');

test('bundle downloads follow redirects without opening an incomplete output file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-runtime-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = https.get;
  t.after(() => { https.get = original; });
  let calls = 0;
  https.get = (_url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    const response = new PassThrough();
    response.statusCode = ++calls === 1 ? 302 : 200;
    response.headers = { location: '/final' };
    queueMicrotask(() => { callback(response); if (response.statusCode === 200) response.end('complete'); });
    return request;
  };
  const file = path.join(root, 'bundle.zip');
  await download('https://example.invalid/start', file);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'complete');
});

test('interrupted bundle downloads close their output before staging cleanup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-runtime-interrupted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = https.get;
  t.after(() => { https.get = original; });
  https.get = (_url, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    const response = new PassThrough();
    response.statusCode = 200;
    queueMicrotask(() => {
      callback(response);
      setImmediate(() => response.destroy(new Error('connection interrupted')));
    });
    return request;
  };
  await assert.rejects(download('https://example.invalid/bundle', path.join(root, 'bundle.zip')), /connection interrupted/);
  fs.rmSync(root, { recursive: true });
  assert.equal(fs.existsSync(root), false);
});
