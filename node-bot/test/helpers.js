// Shared by every *.test.js that spins up a real http.Server for a test.
// server.close() alone doesn't resolve until every open connection closes,
// and fetch() keeps its socket alive for reuse -- so without
// closeAllConnections() each call here paid Node's ~5s default
// keepAliveTimeout, once per test, across every file using this pattern.
const fs = require("node:fs");
const http = require("node:http");

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

module.exports = {
  withServer,
  withRawServer,
  waitForPendingFile,
};
