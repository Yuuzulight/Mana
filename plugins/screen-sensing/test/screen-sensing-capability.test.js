const assert = require("node:assert/strict");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const screenSensingPlugin = require("../index");
const { createAttentionGate } = require("../screen-sensing");

async function withServer(app, fn) {
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json();
  return { response, payload };
}

function buildApp(deps) {
  const app = express();
  app.use(express.json());
  screenSensingPlugin.registerRoutes(app, deps);
  return app;
}

test("has the expected plugin metadata shape (off by default, Vision category)", () => {
  assert.equal(screenSensingPlugin.key, "screenSensing");
  assert.equal(screenSensingPlugin.category, "Vision");
  assert.equal(screenSensingPlugin.defaultEnabled, false);
  assert.equal(typeof screenSensingPlugin.registerRoutes, "function");
});

test("POST /screen-sensing/glance requires an image or text", async () => {
  const app = buildApp({ runVisionReply: async () => "irrelevant" });
  await withServer(app, async (baseUrl) => {
    for (const body of [{}, { text: "   " }]) {
      const { response, payload } = await postJson(`${baseUrl}/screen-sensing/glance`, body);
      assert.equal(response.status, 400);
      assert.match(payload.error, /image or text is required/);
    }
  });
});

test("POST /screen-sensing/glance summarizes window text with the loaded model, not vision (#690)", async () => {
  const localCalls = [];
  const app = buildApp({
    runVisionReply: async () => {
      throw new Error("vision must not run for a text glance");
    },
    runLocalReply: async (prompt, maxTokens) => {
      localCalls.push({ prompt, maxTokens });
      return "The user is editing VoiceLoop.cs in VS Code.";
    },
    attentionGate: createAttentionGate({ now: () => 1000 }),
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/screen-sensing/glance`, {
      text: "VoiceLoop.cs - Visual Studio Code",
      image: "data:image/png;base64,ignoredwhentextispresent",
    });
    assert.equal(response.status, 200);
    assert.equal(payload.shouldSurface, true);
    assert.equal(payload.summary, "The user is editing VoiceLoop.cs in VS Code.");
    assert.equal(localCalls.length, 1);
    assert.match(localCalls[0].prompt, /<screen_text>\nVoiceLoop\.cs - Visual Studio Code\n<\/screen_text>/);
  });
});

test("POST /screen-sensing/glance skips a text glance when no model is loaded", async () => {
  const app = buildApp({ runLocalReply: async () => null });
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/screen-sensing/glance`, {
      text: "Some window text that is long enough.",
    });
    assert.equal(response.status, 200);
    assert.equal(payload.shouldSurface, false);
    assert.equal(payload.reason, "no-model-loaded");
  });
});

test("POST /screen-sensing/glance hands window text to the standing-intent check, even with no model (#1283)", async () => {
  const checked = [];
  const app = buildApp({ runLocalReply: async () => null, checkScreenIntents: (screen) => checked.push(screen) });
  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/screen-sensing/glance`, { text: "Party Finder - raid tonight", gamingModeActive: true });
    await postJson(`${baseUrl}/screen-sensing/glance`, { image: "data:image/png;base64,fakeimagedata" }).catch(() => {});
  });
  assert.deepEqual(checked, [{ text: "Party Finder - raid tonight", gaming: true }]);
});

test("POST /screen-sensing/glance summarizes via runVisionReply and surfaces a genuine glance", async () => {
  const calls = [];
  const runVisionReply = async (prompt, images) => {
    calls.push({ prompt, images });
    return "The user is writing code in a text editor.";
  };
  const app = buildApp({ runVisionReply, attentionGate: createAttentionGate({ now: () => 1000 }) });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/screen-sensing/glance`, {
      image: "data:image/png;base64,fakeimagedata",
    });
    assert.equal(response.status, 200);
    assert.equal(payload.shouldSurface, true);
    assert.equal(payload.summary, "The user is writing code in a text editor.");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].images, ["data:image/png;base64,fakeimagedata"]);
  });
});

test("POST /screen-sensing/glance omits summary from the response when the gate says not to surface", async () => {
  const runVisionReply = async () => "The user is writing code.";
  const app = buildApp({
    runVisionReply,
    attentionGate: createAttentionGate({ now: () => 1000 }),
  });

  await withServer(app, async (baseUrl) => {
    const { payload } = await postJson(`${baseUrl}/screen-sensing/glance`, {
      image: "data:image/png;base64,fakeimagedata",
      gamingModeActive: true,
    });
    assert.equal(payload.shouldSurface, false);
    assert.equal(payload.reason, "gaming-mode-active");
    assert.equal("summary" in payload, false);
  });
});

test("POST /screen-sensing/glance returns 500 (not a crash) when runVisionReply throws", async () => {
  const runVisionReply = async () => {
    throw new Error("vision model unavailable");
  };
  const app = buildApp({ runVisionReply });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/screen-sensing/glance`, {
      image: "data:image/png;base64,fakeimagedata",
    });
    assert.equal(response.status, 500);
    assert.match(payload.error, /vision model unavailable/);
  });
});
