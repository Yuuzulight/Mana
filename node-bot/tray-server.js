const WebSocket = require('ws');

let wss_tray = null;
let trayClients = new Set();

function registerTrayServer(httpServer, options = {}) {
  const path = options.path || '/ws/tray';
  if (wss_tray) return;
  wss_tray = new WebSocket.Server({ server: httpServer, path });
  wss_tray.on('connection', (socket, req) => {
    try {
      trayClients.add(socket);
      socket.on('close', () => trayClients.delete(socket));
      socket.on('error', () => trayClients.delete(socket));
    } catch (e) {}
  });
}

function broadcastTrayNotification(payload) {
  try {
    const msg = JSON.stringify(payload);
    for (const c of trayClients) {
      try {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
      } catch (e) {}
    }
  } catch (e) {}
}

module.exports = { registerTrayServer, broadcastTrayNotification };
