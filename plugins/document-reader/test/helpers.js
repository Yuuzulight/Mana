// Local copy of node-bot/test/helpers.js's withServer -- duplicated rather
// than required across the node-bot/plugins boundary so this plugin's tests
// don't depend on the main package's internals. See node-bot/test/helpers.js
// for why closeAllConnections() matters here.
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

module.exports = { withServer };
