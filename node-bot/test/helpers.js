// Shared by every *.test.js that spins up a real http.Server for a test.
// server.close() alone doesn't resolve until every open connection closes,
// and fetch() keeps its socket alive for reuse -- so without
// closeAllConnections() each call here paid Node's ~5s default
// keepAliveTimeout, once per test, across every file using this pattern.
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

module.exports = {
  withServer,
  withRawServer,
};
