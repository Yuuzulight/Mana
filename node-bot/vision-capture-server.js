// Issue #417: the actual WebSocket transport for vision-capture-bridge.js's
// request/response bookkeeping. Mirrors tray-server.js's shape exactly --
// noServer: true plus a manual path check before handing off to
// handleUpgrade, NOT the `{server, path}` shorthand. That shorthand makes
// `ws` attach its own 'upgrade' listener that aborts any path it doesn't
// own, which killed every other WS server sharing the same httpServer
// (issue #325, already fixed once for tray-server.js/caption-server.js --
// same trap, same fix, for a third WS server on this same httpServer).
const WebSocket = require("ws");

function registerVisionCaptureServer(httpServer, { path = "/ws/vision-capture", bridge, requestGuard } = {}) {
  const wss = new WebSocket.Server({ noServer: true });
  const clients = new Set();
  // #912: clients that connected with ?camera=1 can take camera snapshots.
  const cameraClients = new WeakSet();

  wss.on("connection", (socket, req) => {
    clients.add(socket);
    if (new URL(req?.url || "/", "http://localhost").searchParams.get("camera") === "1") {
      cameraClients.add(socket);
    }
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  const isOpen = (client) => client.readyState === WebSocket.OPEN;

  httpServer.on("upgrade", (req, socket, head) => {
    if ((req.url || "").split("?")[0] !== path) return;
    // Issue #670: a cross-site page must not answer capture requests.
    if (requestGuard?.rejectUpgrade(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  bridge.setSender((message) => {
    const raw = JSON.stringify(message);
    let sent = false;
    for (const client of clients) {
      if (message.source === "camera" && !cameraClients.has(client)) continue;
      try {
        if (isOpen(client)) {
          client.send(raw);
          sent = true;
        }
      } catch (e) {
        // ignore a single bad client; others may still be reachable
      }
    }
    return sent;
  }, () => [...clients].some((client) => cameraClients.has(client) && isOpen(client)));

  return { wss };
}

module.exports = { registerVisionCaptureServer };
