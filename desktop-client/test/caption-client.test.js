const assert = require("node:assert/strict");
const test = require("node:test");

const { createCaptionClient } = require("../renderer/caption-client");

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
