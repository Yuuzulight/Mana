// Shared by every *.test.js that spins up a real http.Server for a test.
// server.close() alone doesn't resolve until every open connection closes,
// and fetch() keeps its socket alive for reuse -- so without
// closeAllConnections() each call here paid Node's ~5s default
// keepAliveTimeout, once per test, across every file using this pattern.
const fs = require("node:fs");
const http = require("node:http");
const zlib = require("node:zlib");

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

async function withRawServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn({ port, url: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

// Polls `dir` for the pending-approval request file a background
// createPendingRequest() write produces -- excludes the .rejected.json/
// .approved.json marker files a decision later writes next to it. Shared
// by acp-autonomous-loop.test.js's file_write/snapshot_restore approval
// tests, which each drive this same real filesystem-based approval flow.
function waitForPendingFile(dir, { timeoutMs = 1000, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.includes(".rejected.") && !f.includes(".approved."));
      if (files.length) {
        resolve(files[0]);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`waitForPendingFile: no pending file in ${dir} after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// #842: with no MANA_ADMIN_SECRET, admin routes need ADMIN_TOKEN (or the
// native launcher's key). A test file that exercises them shadows fetch
// with this, which sends the token on every request.
function useTestAdminToken() {
  process.env.ADMIN_TOKEN = "test-admin-token";
  return (url, init = {}) =>
    globalThis.fetch(url, { ...init, headers: { "x-admin-token": "test-admin-token", ...init.headers } });
}

// #664 (Q21): a minimal zip writer (stored or deflated entries, no CRC --
// the reader doesn't check it), so the tests can also build hostile zips.
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, stored = false } of entries) {
    const raw = Buffer.from(data);
    const body = stored ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, body);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

module.exports = {
  useTestAdminToken,
  makeZip,
  withServer,
  withRawServer,
  waitForPendingFile,
};
