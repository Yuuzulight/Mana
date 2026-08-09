const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocketClient = require("ws");

// Issue #325: caption-server.js and tray-server.js both used to attach
// `new WebSocket.Server({ server: httpServer, path })` directly to the same
// httpServer. ws's internal upgrade handler calls abortHandshake(socket,
// 400) for any path it doesn't own, rather than leaving the socket for the
// next listener -- so whichever module registered first (caption-server)
// killed every upgrade for the other module's path (/ws/tray) before it
// ever got a chance to handle it. Confirmed live while implementing #325;
// this reproduces it against the real modules so it can't silently recur.

function freshModule(id) {
  delete require.cache[require.resolve(id)];
  return require(id);
}

async function withCoexistingServers(fn) {
  // Both modules keep module-level singleton state (wss/wss_tray), so a
  // fresh require per test avoids one test's registration leaking into the
  // next.
  const captionServer = freshModule("../caption-server");
  const trayServer = freshModule("../tray-server");

  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  captionServer.registerCaptionServer(server, { path: "/ws/captions" });
  trayServer.registerTrayServer(server, { path: "/ws/tray" });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn({ port, trayServer, captionServer });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

function connect(port, path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClient(`ws://127.0.0.1:${port}${path}`);
    socket.on("open", () => resolve(socket));
    socket.on("unexpected-response", (req, res) => {
      reject(new Error(`unexpected status ${res.statusCode}`));
    });
    socket.on("error", reject);
  });
}

test("caption-server registered first no longer 400s /ws/tray upgrades", async () => {
  await withCoexistingServers(async ({ port }) => {
    const socket = await connect(port, "/ws/tray");
    socket.close();
  });
});

test("/ws/captions still works when tray-server is registered after it", async () => {
  await withCoexistingServers(async ({ port }) => {
    const socket = await connect(port, "/ws/captions");
    socket.close();
  });
});

test("a broadcast on /ws/tray reaches a connected client without touching /ws/captions clients", async () => {
  await withCoexistingServers(async ({ port, trayServer }) => {
    const traySocket = await connect(port, "/ws/tray");
    const captionSocket = await connect(port, "/ws/captions");

    const received = new Promise((resolve) => {
      traySocket.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    let captionGotSomething = false;
    captionSocket.on("message", () => {
      captionGotSomething = true;
    });

    trayServer.broadcastTrayNotification({ type: "doctor", title: "t", text: "x" });
    const payload = await received;
    assert.equal(payload.title, "t");
    assert.equal(captionGotSomething, false);

    traySocket.close();
    captionSocket.close();
  });
});
