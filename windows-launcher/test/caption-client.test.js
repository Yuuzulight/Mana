const assert = require("node:assert/strict");
const test = require("node:test");

const { parseCaptionMessage, createCaptionClient } = require("../renderer/caption-client");

test("parses a caption frame", () => {
  const frame = JSON.stringify({
    type: "caption",
    ts: 1,
    payload: { text: "hello there", words: [], source: "tts" },
  });
  assert.deepEqual(parseCaptionMessage(frame), { text: "hello there", source: "tts" });
});

test("ignores frames that are not captions", () => {
  assert.equal(parseCaptionMessage(JSON.stringify({ type: "tray", payload: {} })), null);
});

test("ignores malformed json rather than throwing", () => {
  // A display feed should cost a caption on a bad frame, not the connection.
  assert.equal(parseCaptionMessage("{not json"), null);
});

test("ignores a caption with no text", () => {
  assert.equal(parseCaptionMessage(JSON.stringify({ type: "caption", payload: { text: "  " } })), null);
});

test("delivers parsed captions to the handler", () => {
  const received = [];
  class FakeSocket {
    constructor() {
      FakeSocket.last = this;
    }
    close() {}
  }
  const client = createCaptionClient({
    WebSocketImpl: FakeSocket,
    reconnectMs: 0,
    onCaption: (caption) => received.push(caption),
  });
  client.connect();
  FakeSocket.last.onmessage({
    data: JSON.stringify({ type: "caption", payload: { text: "spoken line" } }),
  });
  assert.deepEqual(received, [{ text: "spoken line", source: null }]);
  client.stop();
});

test("a closed socket does not reconnect after stop()", () => {
  let constructed = 0;
  class FakeSocket {
    constructor() {
      constructed += 1;
      FakeSocket.last = this;
    }
    close() {}
  }
  const client = createCaptionClient({
    WebSocketImpl: FakeSocket,
    reconnectMs: 1,
    onCaption: () => {},
  });
  client.connect();
  client.stop();
  FakeSocket.last.onclose();
  assert.equal(constructed, 1);
});

test("the backend key goes in the socket URL (browser WebSockets cannot send headers)", () => {
  class FakeSocket {
    constructor(url) {
      FakeSocket.url = url;
    }
    close() {}
  }
  createCaptionClient({ WebSocketImpl: FakeSocket, reconnectMs: 0, key: "k+1" }).connect();
  assert.equal(FakeSocket.url, "ws://127.0.0.1:5005/ws/captions?key=k%2B1");
  createCaptionClient({ WebSocketImpl: FakeSocket, reconnectMs: 0, key: "" }).connect();
  assert.equal(FakeSocket.url, "ws://127.0.0.1:5005/ws/captions");
});
