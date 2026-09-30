// #912: camera snapshot requests only reach clients that said they can take one.
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");

const { createVisionCaptureBridge } = require("../vision-capture-bridge");
const { registerVisionCaptureServer } = require("../vision-capture-server");

test("camera requests go only to ?camera=1 clients, and hasCamera follows them", async (t) => {
  const server = http.createServer();
  const bridge = createVisionCaptureBridge({ timeoutMs: 1000 });
  registerVisionCaptureServer(server, { bridge });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `ws://127.0.0.1:${server.address().port}/ws/vision-capture`;
  const open = (query) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url + query);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  const nextMessage = (ws) => new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw))));

  const screenOnly = await open("");
  assert.equal(bridge.hasCamera(), false);
  await assert.rejects(() => bridge.requestCapture({ camera: true }), /no client connected/);

  const camera = await open("?camera=1");
  // the server sees the new socket a tick after the client does
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.hasCamera(), true);
  let screenOnlyGotOne = false;
  screenOnly.once("message", () => (screenOnlyGotOne = true));
  const received = nextMessage(camera);
  const snapshot = bridge.requestCapture({ camera: true });
  const message = await received;
  assert.equal(message.source, "camera");
  bridge.resolveCapture(message.requestId, "data:image/jpeg;base64,cam");
  assert.equal(await snapshot, "data:image/jpeg;base64,cam");
  assert.equal(screenOnlyGotOne, false);

  camera.close();
  screenOnly.close();
});
