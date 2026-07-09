const WebSocket = require('ws');

let wss = null;
let clients = new Set();

function registerCaptionServer(httpServer, options = {}) {
  const path = options.path || '/ws/captions';
  if (wss) return;
  wss = new WebSocket.Server({ server: httpServer, path });
  wss.on('connection', (socket, req) => {
    try {
      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
      socket.on('error', () => clients.delete(socket));
    } catch (e) {}
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
