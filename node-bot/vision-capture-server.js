// Issue #417: the actual WebSocket transport for vision-capture-bridge.js's
// request/response bookkeeping. Mirrors tray-server.js's shape exactly --
// noServer: true plus a manual path check before handing off to
// handleUpgrade, NOT the `{server, path}` shorthand. That shorthand makes
// `ws` attach its own 'upgrade' listener that aborts any path it doesn't
// own, which killed every other WS server sharing the same httpServer
// (issue #325, already fixed once for tray-server.js/caption-server.js --
// same trap, same fix, for a third WS server on this same httpServer).
const WebSocket = require("ws");

function registerVisionCaptureServer(httpServer, { path = "/ws/vision-capture", bridge } = {}) {
  const wss = new WebSocket.Server({ noServer: true });
  const clients = new Set();

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if ((req.url || "").split("?")[0] !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  bridge.setSender((message) => {
    const raw = JSON.stringify(message);
    let sent = false;
    for (const client of clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(raw);
          sent = true;
        }
      } catch (e) {
        // ignore a single bad client; others may still be reachable
      }
    }
    return sent;
  });

  return { wss };
}

module.exports = { registerVisionCaptureServer };
