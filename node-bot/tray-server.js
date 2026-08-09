const WebSocket = require('ws');

let wss_tray = null;
let trayClients = new Set();

function registerTrayServer(httpServer, options = {}) {
  const path = options.path || '/ws/tray';
  if (wss_tray) return;
  // noServer + a manual path check before handing off to handleUpgrade --
  // NOT `{ server: httpServer, path }`. That shorthand makes ws attach its
  // own 'upgrade' listener that calls abortHandshake(socket, 400) for any
  // path it doesn't own, rather than leaving the socket alone for the next
  // listener. With caption-server.js's identical shorthand also attached to
  // this same httpServer and registered first, every /ws/tray upgrade was
  // getting killed with a 400 before this module ever saw it (confirmed
  // live -- issue #325).
  wss_tray = new WebSocket.Server({ noServer: true });
  wss_tray.on('connection', (socket, req) => {
    try {
      trayClients.add(socket);
      socket.on('close', () => trayClients.delete(socket));
      socket.on('error', () => trayClients.delete(socket));
    } catch (e) {}
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== path) return;
    wss_tray.handleUpgrade(req, socket, head, (ws) => {
      wss_tray.emit('connection', ws, req);
    });
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
