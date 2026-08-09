const WebSocket = require('ws');

let wss = null;
let clients = new Set();

function registerCaptionServer(httpServer, options = {}) {
  const path = options.path || '/ws/captions';
  if (wss) return;
  // noServer + a manual path check before handing off to handleUpgrade --
  // see tray-server.js's identical fix (issue #325) for why: the
  // `{ server: httpServer, path }` shorthand makes ws attach its own
  // 'upgrade' listener that aborts the handshake with 400 for any path it
  // doesn't own, instead of leaving the socket for the next listener --
  // which broke /ws/tray whenever this module was registered first.
  wss = new WebSocket.Server({ noServer: true });
  wss.on('connection', (socket, req) => {
    try {
      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
      socket.on('error', () => clients.delete(socket));
    } catch (e) {}
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
}

function broadcastCaption(captionObj) {
  // captionObj: { text, words: [{word,startMs,endMs}], sessionId?, source? }
  if (!wss) return;
  const payload = JSON.stringify({ type: 'caption', ts: Date.now(), payload: captionObj });
  for (const c of Array.from(clients)) {
    try {
      if (c.readyState === WebSocket.OPEN) c.send(payload);
    } catch (e) {}
  }
}

module.exports = { registerCaptionServer, broadcastCaption };
