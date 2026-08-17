// Issue #362: node-bot has broadcast captions on /ws/captions since
// caption-server.js landed, and nothing has ever listened. Spoken output
// had no on-screen equivalent reaching the user -- the server side was
// already done, only the consumer was missing.
//
// Parsing is separated from the socket so it can be tested without one,
// the same split speech-filters.js already uses in this renderer.

// A caption frame is { type: 'caption', ts, payload: { text, words[], ... } }.
// Anything else on the socket is ignored rather than thrown on: this is a
// display feed, and a malformed frame should cost a caption, not the
// connection.
function parseCaptionMessage(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
  if (!parsed || parsed.type !== "caption") return null;
  const text = String(parsed.payload?.text || "").trim();
  if (!text) return null;
  return { text, source: parsed.payload?.source || null };
}

// options.WebSocketImpl: injectable so tests never open a real socket.
// options.reconnectMs: 0 disables reconnection (used by tests).
function createCaptionClient(options = {}) {
  const url = options.url || "ws://127.0.0.1:5005/ws/captions";
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const onCaption = typeof options.onCaption === "function" ? options.onCaption : () => {};
  const reconnectMs = options.reconnectMs === undefined ? 3000 : options.reconnectMs;

  let socket = null;
  let closed = false;
  let reconnectTimer = null;

  function connect() {
    if (closed || !WebSocketImpl) return null;
    socket = new WebSocketImpl(url);
    socket.onmessage = (event) => {
      const caption = parseCaptionMessage(event?.data);
      if (caption) onCaption(caption);
    };
    // Captions are additive: losing the feed must never surface as an error
    // to the user or interfere with the conversation itself.
    socket.onclose = () => {
      if (closed || !reconnectMs) return;
      reconnectTimer = setTimeout(connect, reconnectMs);
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch (e) {}
    };
    return socket;
  }

  function stop() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      if (socket) socket.close();
    } catch (e) {}
  }

  return { connect, stop, parseCaptionMessage };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCaptionMessage, createCaptionClient };
}
