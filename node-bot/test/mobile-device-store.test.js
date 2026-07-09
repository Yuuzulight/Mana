import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { MobileDeviceStore, sha256Hex } from '../mobile-device-store.js';

const TMP = path.join(__dirname, 'tmp-test-devices.json');

function cleanup(){ if (fs.existsSync(TMP)) fs.unlinkSync(TMP); }

cleanup();
const s = new MobileDeviceStore(TMP);

// pairing code
const { code } = s.generatePairingCode(1);
assert.equal(typeof code, 'string');
assert.ok(s.consumePairingCode(code), 'should consume code');
assert.equal(s.consumePairingCode(code), false, 'code is single-use');

// add device
const token = 'tok-' + Math.random();
const dev = s.addDevice({ name: 'test-phone', token });
assert.ok(dev.id, 'device has id');
assert.equal(dev.name, 'test-phone');

// find by token
const found = s.findDeviceByToken(token);
assert.ok(found && found.id === dev.id, 'found by token');

// last seen
s.updateLastSeen(dev.id);
const list = s.listDevices();
assert.ok(list[0].lastSeenAt, 'lastSeen set');

// rotate token
const newTok = 'tok2-' + Math.random();
const okRot = s.rotateToken(dev.id, newTok);
assert.ok(okRot, 'rotate ok');
assert.equal(s.findDeviceByToken(token), null, 'old token invalid');
assert.ok(s.findDeviceByToken(newTok), 'new token valid');

// revoke
s.revokeDevice(dev.id);
assert.equal(s.findDeviceByToken(newTok), null, 'revoked token invalid');

cleanup();
console.log('mobile-device-store test passed');
