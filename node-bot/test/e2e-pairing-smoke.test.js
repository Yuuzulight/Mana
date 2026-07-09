const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { MobileDeviceStore } = require('../mobile-device-store');

async function run() {
  // use a temp file for devices
  const tmp = path.join(__dirname, 'tmp-e2e-devices.json');
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const deviceStore = new MobileDeviceStore(tmp);
  const app = createApp({ deviceStore });
  const server = http.createServer(app);

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  // 1) request pairing code (admin local)
  let res = await fetch(base + '/mobile/pair/request', { method: 'POST' });
  assert.equal(res.status, 200, 'pair request ok');
  const j = await res.json();
  assert.ok(j.code, 'code provided');

  // 2) complete pairing
  res = await fetch(base + '/mobile/pair/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: j.code, deviceName: 'e2e-phone' }) });
  assert.equal(res.status, 200, 'pair complete ok');
  const j2 = await res.json();
  assert.ok(j2.token, 'token returned');
  const token = j2.token;

  // 3) use token to ping
  res = await fetch(base + '/mobile/ping', { method: 'GET', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(res.status, 200, 'ping ok');
  const j3 = await res.json();
  assert.ok(j3.device && j3.device.name === 'e2e-phone', 'ping returns device info');

  // 4) admin list shows device and lastSeen
  res = await fetch(base + '/mobile/devices');
  assert.equal(res.status, 200, 'devices list ok');
  const j4 = await res.json();
  assert.ok(Array.isArray(j4.devices) && j4.devices.length >= 1, 'devices list contains at least one device');
  const found = j4.devices.find(d => d.name === 'e2e-phone');
  assert.ok(found && found.lastSeenAt, 'device lastSeen updated');

  // cleanup
  server.close();
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log('pairing e2e smoke test passed');
}

run().catch(err => { console.error(err); process.exit(1); });
