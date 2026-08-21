const assert = require("node:assert/strict");
const test = require("node:test");

const { createVisionCaptureBridge } = require("../vision-capture-bridge");

test("requestCapture rejects immediately when no sender is set (no client connected)", async () => {
  const bridge = createVisionCaptureBridge({ timeoutMs: 100 });
  await assert.rejects(() => bridge.requestCapture(), /no client connected/);
});

test("requestCapture resolves with the image once resolveCapture is called with the same requestId", async () => {
  const bridge = createVisionCaptureBridge({ timeoutMs: 1000 });
  let capturedRequestId = null;
  bridge.setSender((message) => {
    capturedRequestId = message.requestId;
    return true;
  });

  const capturePromise = bridge.requestCapture();
  assert.ok(capturedRequestId);
  const resolved = bridge.resolveCapture(capturedRequestId, "data:image/png;base64,abc");
  assert.equal(resolved, true);
  const image = await capturePromise;
  assert.equal(image, "data:image/png;base64,abc");
});

test("requestCapture rejects with the given reason when rejectCapture is called", async () => {
  const bridge = createVisionCaptureBridge({ timeoutMs: 1000 });
  let capturedRequestId = null;
  bridge.setSender((message) => {
    capturedRequestId = message.requestId;
    return true;
  });

  const capturePromise = bridge.requestCapture();
  const rejected = bridge.rejectCapture(capturedRequestId, "permission denied");
  assert.equal(rejected, true);
  await assert.rejects(() => capturePromise, /permission denied/);
});

test("requestCapture rejects on its own after timeoutMs if nothing responds", async () => {
  const bridge = createVisionCaptureBridge({ timeoutMs: 50 });
  bridge.setSender(() => true);
  await assert.rejects(() => bridge.requestCapture(), /capture request timed out/);
});

test("requestCapture rejects when the sender reports it could not deliver (e.g. no socket open)", async () => {
  const bridge = createVisionCaptureBridge({ timeoutMs: 1000 });
  bridge.setSender(() => false);
  await assert.rejects(() => bridge.requestCapture(), /no client connected/);
});

test("resolveCapture/rejectCapture return false for an unknown or already-settled requestId", () => {
  const bridge = createVisionCaptureBridge();
  assert.equal(bridge.resolveCapture("does-not-exist", "img"), false);
  assert.equal(bridge.rejectCapture("does-not-exist", "reason"), false);
});

test("a settled request cannot be resolved or rejected a second time", async () => {
  const bridge = createVisionCaptureBridge({ timeoutMs: 1000 });
  let capturedRequestId = null;
  bridge.setSender((message) => {
    capturedRequestId = message.requestId;
    return true;
  });

  const capturePromise = bridge.requestCapture();
  bridge.resolveCapture(capturedRequestId, "first-image");
  const secondAttempt = bridge.resolveCapture(capturedRequestId, "second-image");
  assert.equal(secondAttempt, false);
  assert.equal(await capturePromise, "first-image");
});

test("each requestCapture call gets its own requestId, so concurrent calls don't cross-resolve", async () => {
  const bridge = createVisionCaptureBridge({ timeoutMs: 1000 });
  const requestIds = [];
  bridge.setSender((message) => {
    requestIds.push(message.requestId);
    return true;
  });

  const first = bridge.requestCapture();
  const second = bridge.requestCapture();
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
  bridge.resolveCapture(requestIds[0], "image-1");
  bridge.resolveCapture(requestIds[1], "image-2");
  assert.equal(await first, "image-1");
  assert.equal(await second, "image-2");
});

test("the module-level visionCaptureBridge singleton is a working bridge instance", async () => {
  const { visionCaptureBridge } = require("../vision-capture-bridge");
  await assert.rejects(() => visionCaptureBridge.requestCapture(), /no client connected/);
});
