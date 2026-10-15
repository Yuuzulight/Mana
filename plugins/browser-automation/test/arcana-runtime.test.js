const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createArcanaBrowserType, resolveArcanaPath } = require('../arcana-runtime');

test('Arcana discovery never selects an old managed Edge/Chrome setting', () => {
  assert.equal(resolveArcanaPath({ MANA_BROWSER_EXECUTABLE_PATH: 'msedge.exe' }, { existsSync: () => false }), null);
  const files = { existsSync: file => file.endsWith(path.join('runtime', 'arcana', 'Arcana.Cli.dll')) };
  assert.match(resolveArcanaPath({}, files), /Arcana\.Cli\.dll$/);
});

test('Arcana refuses separate-window takeover and invalid CLI paths before starting a browser', async () => {
  const type = createArcanaBrowserType({ chromium: { connectOverCDP() { throw new Error('must not connect'); } }, env: {} });
  await assert.rejects(() => type.launchPersistentContext(os.tmpdir(), { headless: false }), /inside Mana/);
  await assert.rejects(() => type.launchPersistentContext(os.tmpdir(), { executablePath: 'relative.dll' }), /not installed/);
});

test('Arcana startup errors release the profile; a live profile owner is never overwritten', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-startup-'));
  const file = path.join(directory, 'mana-arcana.lock');
  const type = createArcanaBrowserType({ chromium: {}, env: {} });
  try {
    const lock = JSON.stringify({ pid: process.pid, nonce: 'other-owner' });
    fs.writeFileSync(file, lock);
    await assert.rejects(() => type.launchPersistentContext(directory, { executablePath: process.execPath }), /already in use/);
    assert.equal(fs.readFileSync(file, 'utf8'), lock);
    fs.unlinkSync(file);
    // Node is a real executable but not an Arcana CLI; startup must fail cleanly.
    await assert.rejects(() => type.launchPersistentContext(directory, { executablePath: process.execPath }), /Arcana exited during startup/);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
