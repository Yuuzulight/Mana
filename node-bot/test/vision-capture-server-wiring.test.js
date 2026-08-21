const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");
const { visionCaptureBridge } = require("../vision-capture-bridge");

test("POST /vision/capture-result resolves a pending requestCapture() promise", async () => {
  const app = createApp({});
  let capturedRequestId = null;
  visionCaptureBridge.setSender((message) => {
    capturedRequestId = message.requestId;
    return true;
  });

  const capturePromise = visionCaptureBridge.requestCapture();
  assert.ok(capturedRequestId);

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/vision/capture-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: capturedRequestId, image: "data:image/png;base64,abc" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  assert.equal(await capturePromise, "data:image/png;base64,abc");
});

test("POST /vision/capture-result rejects a missing requestId or image with a 400", async () => {
  const app = createApp({});
  await withServer(app, async (baseUrl) => {
    const missingRequestId = await fetch(`${baseUrl}/vision/capture-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "data:image/png;base64,abc" }),
    });
    assert.equal(missingRequestId.status, 400);

    const missingImage = await fetch(`${baseUrl}/vision/capture-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "some-id" }),
    });
    assert.equal(missingImage.status, 400);
  });
});

test("POST /vision/capture-result for an unknown/already-settled requestId reports ok:false, not a crash", async () => {
  const app = createApp({});
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/vision/capture-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "never-requested", image: "data:image/png;base64,abc" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
  });
});

test("buildAssistantReply does not throw while constructing the tool-source array (vision__look wiring compiles)", async () => {
  // The tool-source array (including createVisionToolSource(...)) is only
  // built inside buildAssistantReply itself, not at createApp() time --
  // stub local completion so this exercises that array-construction line
  // without needing a real local/remote model, same technique
  // test/server-build-assistant-reply-streaming.test.js already uses.
  const app = createApp({ runLocalAssistantReply: async () => "stub reply" });
  const reply = await app.locals.buildAssistantReply("hi", "", "", "default", null);
  assert.equal(reply, "stub reply");
});
