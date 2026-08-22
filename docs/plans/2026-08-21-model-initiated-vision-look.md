# Model-initiated vision look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model call a `vision__look` tool mid-reply to get a fresh screenshot description, instead of vision only being reachable via the `Ctrl+Alt+M` hotkey or the opt-in ambient screen-sensing loop.

**Architecture:** Screenshot capture only happens client-side (Electron's `desktopCapturer`), while the model's tool-calling loop runs server-side (`node-bot`) — so this needs a small request/response bridge, not just a new tool-source module. A new WebSocket channel (`node-bot/vision-capture-bridge.js` for the pure request/response bookkeeping, `node-bot/vision-capture-server.js` for the actual WS transport, mirroring the existing `tray-notifier.js`/`tray-server.js` split) lets the server ask the connected Electron client to capture right now and wait for the result (with a timeout). The result comes back over a plain HTTP POST, not the WebSocket itself, keeping the client-side response leg as ordinary request/response.

**Tech Stack:** Node.js/Express (`node-bot`), the `ws` package (already a `node-bot` dependency, used by `tray-server.js`), Electron IPC (`windows-launcher`).

**Spec:** [docs/specs/2026-08-21-model-initiated-vision-look-design.md](../specs/2026-08-21-model-initiated-vision-look-design.md)

## Global Constraints

- The bridge is a pure module with no dependency on an `http.Server` at construction time — it must be safely `require`-able (and its `requestCapture`/`resolveCapture`/`rejectCapture` functions callable) from anywhere in `node-bot`, including inside `registerRoutes`'s tool-source array construction, which runs *before* the real WebSocket server (created only in `startServer()`, gated on `require.main === module`) ever exists. This avoids the exact "built too early, dependency doesn't exist yet" scoping bug already found and fixed elsewhere in `server.js` this session (see `runOpenAIReplyPublic`).
- No new client/server transport beyond one new WebSocket path (`/ws/vision-capture`) and one new HTTP route (`POST /vision/capture-result`) — reuse `request-validation.js`'s `requireString`/`ValidationError`/`sendValidationError` for the new route, matching every other route in `server-routes.js`.
- Default capture timeout: 10000ms (`DEFAULT_TIMEOUT_MS` in `vision-capture-bridge.js`).
- Tool name: `vision__look` (double-underscore prefix, matching `expression__set`, `skill__view`, etc.).
- Opt-in gate reuses the screen-sensing plugin's existing toggle (`plugins/screen-sensing/index.js`, `key: "screenSensing"`) — no new setting.
- Electron-glue code (`windows-launcher/main.js`, `windows-launcher/renderer/renderer.js`) has no automated test coverage, matching this codebase's existing convention for that layer (e.g. `proactive-notifications.js`'s wiring in `main.js`, `formatPerfStatus` in `renderer.js`). Only the pure Node-side logic (`vision-capture-bridge.js`, `vision-tool-source.js`) and the HTTP/tool-array wiring get automated tests.

---

## Task 1: `node-bot/vision-capture-bridge.js` — pure request/response bridge

**Files:**
- Create: `node-bot/vision-capture-bridge.js`
- Test: `node-bot/test/vision-capture-bridge.test.js`

**Interfaces:**
- Produces: `createVisionCaptureBridge({ timeoutMs = 10000 } = {})` → `{ requestCapture(), resolveCapture(requestId, image), rejectCapture(requestId, reason), setSender(fn) }`. `requestCapture()` returns a `Promise<string>` resolving to the captured image (whatever string `resolveCapture` was called with) or rejecting with an `Error` (message one of: `"no client connected"`, `"capture request timed out"`, or whatever reason string was passed to `rejectCapture`). `setSender(fn)`: `fn` is `(message: {type: "capture-request", requestId: string}) => boolean` — called once per `requestCapture()`, returning `true` if it was actually delivered to at least one connected client, `false` otherwise (triggers an immediate `"no client connected"` rejection rather than waiting out the full timeout).
- Produces (module-level singleton, for the real app to use without deps-threading): `visionCaptureBridge` — a single `createVisionCaptureBridge()` instance created at module load, exported alongside the factory. `DEFAULT_TIMEOUT_MS` (number, `10000`) also exported.
- Consumes: `node:crypto`'s `randomUUID` (Node builtin, no new dependency).

- [ ] **Step 1: Write the failing tests**

Create `node-bot/test/vision-capture-bridge.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd node-bot && node --test test/vision-capture-bridge.test.js`
Expected: FAIL — `Cannot find module '../vision-capture-bridge'`

- [ ] **Step 3: Write the implementation**

Create `node-bot/vision-capture-bridge.js`:

```js
// Issue #417: a request/response bridge between the server's tool-calling
// loop and the Electron client's screenshot capture. Screenshot capture
// only happens client-side (windows-launcher's desktopCapturer, via the
// existing "screen:capture-primary" IPC handler) -- node-bot has no way to
// take one itself, so a vision__look tool call mid-reply needs something
// that can ask the client to capture right now and wait for the answer.
//
// Deliberately separate from tray-notifier.js/tray-server.js -- that
// channel is fire-and-forget broadcast (server -> client only, no response
// expected). Bolting correlation IDs and pending-promise bookkeeping onto
// it would blur its single "notify, don't wait" purpose. Split the same
// way tray-notifier.js/tray-server.js are split: this module is pure
// request/response bookkeeping, safely requirable (and callable) from
// anywhere with no http.Server dependency -- the actual WebSocket
// transport (vision-capture-server.js) is created later, only once a real
// server starts (startServer(), gated on require.main === module, never
// runs under createApp()-only tests), and wires its "send to the
// connected client" function in via setSender(), mirroring
// tray-notifier.js's setBroadcaster().
const { randomUUID } = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 10000;

function createVisionCaptureBridge({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let sender = null;
  const pending = new Map();

  function setSender(fn) {
    sender = typeof fn === "function" ? fn : null;
  }

  function clearPending(requestId) {
    const entry = pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
    }
  }

  function requestCapture() {
    return new Promise((resolve, reject) => {
      if (typeof sender !== "function") {
        reject(new Error("no client connected"));
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("capture request timed out"));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      const sent = sender({ type: "capture-request", requestId });
      if (!sent) {
        clearPending(requestId);
        reject(new Error("no client connected"));
      }
    });
  }

  function resolveCapture(requestId, image) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearPending(requestId);
    entry.resolve(image);
    return true;
  }

  function rejectCapture(requestId, reason) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearPending(requestId);
    entry.reject(new Error(reason || "capture rejected"));
    return true;
  }

  return { requestCapture, resolveCapture, rejectCapture, setSender };
}

const visionCaptureBridge = createVisionCaptureBridge();

module.exports = { createVisionCaptureBridge, visionCaptureBridge, DEFAULT_TIMEOUT_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd node-bot && node --test test/vision-capture-bridge.test.js`
Expected: PASS, 9 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add node-bot/vision-capture-bridge.js node-bot/test/vision-capture-bridge.test.js
git commit -m "Add vision-capture-bridge.js: request/response bridge for model-initiated vision look (#417)"
```

---

## Task 2: `node-bot/ai/vision-tool-source.js` — the `vision__look` tool

**Files:**
- Create: `node-bot/ai/vision-tool-source.js`
- Test: `node-bot/test/vision-tool-source.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 directly in its own code (the bridge is injected as a constructor option, not required directly — keeps this module testable with a fake bridge, matching `expression-tool-source.js`'s no-hard-dependencies style). Consumes `isPluginEnabled(capability, pluginSettingsStore)` from `../capabilities/registry` (existing, exported at `node-bot/capabilities/registry.js:115`).
- Produces: `VISION_TOOL_PREFIX` (string, `"vision__"`), `TOOL_SCHEMAS` (array), `isVisionToolName(name)` (boolean), `createVisionToolSource({ getVisionStatus, runVisionReply, visionCaptureBridge, screenSensingPlugin, pluginSettingsStore })` → `{ listToolSchemas(), executeTool(qualifiedName, args), isKnownToolName }` — the standard tool-source shape from `node-bot/ai/tool-source.js`'s contract (`listToolSchemas(): Array`, `isKnownToolName(name): boolean`, `executeTool(name, args): Promise<string>`).
  - `getVisionStatus()` returns `{ available: boolean, reason?: string }` (matches `server-routes.js`'s existing `/vision/describe` usage).
  - `runVisionReply(prompt, images)` returns `Promise<string>` (the description text).
  - `visionCaptureBridge` is anything shaped like Task 1's bridge: `{ requestCapture(): Promise<string> }` is all this module actually calls.
  - `screenSensingPlugin` is the plugin module object (needs `.key`, `.category`, `.defaultEnabled`) — `plugins/screen-sensing/index.js`'s existing export.
  - `pluginSettingsStore` is anything with `.isEnabled(key, defaultEnabled): boolean` (matches `isPluginEnabled`'s contract).

- [ ] **Step 1: Write the failing tests**

Create `node-bot/test/vision-tool-source.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  VISION_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isVisionToolName,
  createVisionToolSource,
} = require("../ai/vision-tool-source");

const screenSensingPlugin = { key: "screenSensing", category: "Vision", defaultEnabled: false };

function fakePluginSettingsStore(enabled) {
  return { isEnabled: () => enabled };
}

function baseOptions(overrides = {}) {
  return {
    getVisionStatus: () => ({ available: true }),
    runVisionReply: async () => "a description of the screen",
    visionCaptureBridge: { requestCapture: async () => "data:image/png;base64,abc" },
    screenSensingPlugin,
    pluginSettingsStore: fakePluginSettingsStore(true),
    ...overrides,
  };
}

test("isVisionToolName distinguishes vision tool names from anything else", () => {
  assert.equal(isVisionToolName(`${VISION_TOOL_PREFIX}look`), true);
  assert.equal(isVisionToolName("read_file"), false);
  assert.equal(isVisionToolName("expression__set"), false);
  assert.equal(isVisionToolName(undefined), false);
});

test("listToolSchemas returns the look tool schema, requiring no per-call options", () => {
  const source = createVisionToolSource(baseOptions());
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
});

test("executeTool returns a description on success", async () => {
  const source = createVisionToolSource(baseOptions());
  const result = await source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "what's open?" });
  assert.deepEqual(JSON.parse(result), { status: "ok", description: "a description of the screen" });
});

test("executeTool passes the model's prompt and the captured image through to runVisionReply", async () => {
  let seenArgs = null;
  const source = createVisionToolSource(
    baseOptions({
      runVisionReply: async (prompt, images) => {
        seenArgs = { prompt, images };
        return "ok";
      },
    }),
  );
  await source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "what's open?" });
  assert.equal(seenArgs.prompt, "what's open?");
  assert.deepEqual(seenArgs.images, ["data:image/png;base64,abc"]);
});

test("executeTool rejects a missing or empty prompt", async () => {
  const source = createVisionToolSource(baseOptions());
  await assert.rejects(
    () => source.executeTool(`${VISION_TOOL_PREFIX}look`, {}),
    /prompt is required/,
  );
  await assert.rejects(
    () => source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "   " }),
    /prompt is required/,
  );
});

test("executeTool rejects an unrecognized vision tool name", async () => {
  const source = createVisionToolSource(baseOptions());
  await assert.rejects(
    () => source.executeTool(`${VISION_TOOL_PREFIX}reset-everything`, {}),
    /unknown vision tool/,
  );
});

test("executeTool returns a graceful error when no local vision model is available", async () => {
  const source = createVisionToolSource(
    baseOptions({ getVisionStatus: () => ({ available: false, reason: "no model file" }) }),
  );
  const result = await source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "what's open?" });
  assert.deepEqual(JSON.parse(result), {
    status: "error",
    error: "no local vision model available",
  });
});

test("executeTool returns a graceful error when the screen-sensing plugin is disabled", async () => {
  const source = createVisionToolSource(
    baseOptions({ pluginSettingsStore: fakePluginSettingsStore(false) }),
  );
  const result = await source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "what's open?" });
  assert.deepEqual(JSON.parse(result), {
    status: "error",
    error: "vision look requires the screen-sensing plugin to be enabled",
  });
});

test("executeTool returns a graceful error when the capture bridge rejects (e.g. timeout, no client)", async () => {
  const source = createVisionToolSource(
    baseOptions({
      visionCaptureBridge: {
        requestCapture: async () => {
          throw new Error("capture request timed out");
        },
      },
    }),
  );
  const result = await source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "what's open?" });
  const parsed = JSON.parse(result);
  assert.equal(parsed.status, "error");
  assert.match(parsed.error, /could not capture the screen: capture request timed out/);
});

test("the vision model check runs before the plugin-enabled check (order doesn't matter for correctness, but both are independently reachable)", async () => {
  const source = createVisionToolSource(
    baseOptions({
      getVisionStatus: () => ({ available: false, reason: "no model file" }),
      pluginSettingsStore: fakePluginSettingsStore(false),
    }),
  );
  const result = await source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "what's open?" });
  assert.equal(JSON.parse(result).status, "error");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd node-bot && node --test test/vision-tool-source.test.js`
Expected: FAIL — `Cannot find module '../ai/vision-tool-source'`

- [ ] **Step 3: Write the implementation**

Create `node-bot/ai/vision-tool-source.js`:

```js
// Issue #417: lets the model itself decide, mid-reply, that seeing the
// screen would help -- instead of vision only being reachable via the
// Ctrl+Alt+M hotkey or the opt-in ambient screen-sensing loop. Same
// tool-source shape as expression-tool-source.js (ai/tool-source.js's
// contract): listToolSchemas/executeTool/isKnownToolName.
//
// Three ways this can fail before ever reaching a real description, each
// returned as a {status:"error", error} JSON string (never thrown -- these
// are expected, user-facing conditions, not programmer errors), matching
// skill-tool-source.js's error-return convention:
//   1. No local vision model installed (same getVisionStatus() check
//      /vision/describe already applies).
//   2. The screen-sensing plugin isn't enabled -- reusing that toggle
//      rather than adding a new one, since both this and the ambient
//      glance loop are "let Mana see the screen without a hotkey."
//   3. The capture bridge couldn't get an image in time (no client
//      connected, or the client never responded within its timeout).
const { isPluginEnabled } = require("../capabilities/registry");

const VISION_TOOL_PREFIX = "vision__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${VISION_TOOL_PREFIX}look`,
      description:
        "Look at the user's screen right now and describe what's on it. Use this when seeing the screen would genuinely help answer the question -- not for every turn.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to look for or ask about the screen.",
          },
        },
        required: ["prompt"],
      },
    },
  },
];

function isVisionToolName(name) {
  return typeof name === "string" && name.startsWith(VISION_TOOL_PREFIX);
}

function createVisionToolSource({
  getVisionStatus,
  runVisionReply,
  visionCaptureBridge,
  screenSensingPlugin,
  pluginSettingsStore,
}) {
  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(VISION_TOOL_PREFIX.length);
    if (action !== "look") {
      throw new Error(`unknown vision tool: ${qualifiedName}`);
    }
    const prompt = String(args?.prompt || "").trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }

    const vision = typeof getVisionStatus === "function" ? getVisionStatus() : null;
    if (!vision || !vision.available) {
      return JSON.stringify({ status: "error", error: "no local vision model available" });
    }

    if (!isPluginEnabled(screenSensingPlugin, pluginSettingsStore)) {
      return JSON.stringify({
        status: "error",
        error: "vision look requires the screen-sensing plugin to be enabled",
      });
    }

    let image;
    try {
      image = await visionCaptureBridge.requestCapture();
    } catch (e) {
      return JSON.stringify({
        status: "error",
        error: `could not capture the screen: ${e.message || e}`,
      });
    }

    const description = await runVisionReply(prompt, [image]);
    return JSON.stringify({ status: "ok", description: description || "" });
  }

  return { listToolSchemas, executeTool, isKnownToolName: isVisionToolName };
}

module.exports = {
  VISION_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isVisionToolName,
  createVisionToolSource,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd node-bot && node --test test/vision-tool-source.test.js`
Expected: PASS, 10 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add node-bot/ai/vision-tool-source.js node-bot/test/vision-tool-source.test.js
git commit -m "Add vision-tool-source.js: the vision__look tool (#417)"
```

---

## Task 3: Wire the bridge into `server.js`/`server-routes.js`

**Files:**
- Create: `node-bot/vision-capture-server.js`
- Modify: `node-bot/server-routes.js` (add `POST /vision/capture-result`)
- Modify: `node-bot/server.js` (register the tool source in `buildAssistantReply`'s array, thread `resolveVisionCapture` into `registerCoreRoutes`'s deps, register the WS transport in `startServer()`)
- Test: `node-bot/test/vision-capture-server-wiring.test.js`

**Interfaces:**
- Consumes: `createVisionCaptureBridge`/`visionCaptureBridge` from Task 1 (`node-bot/vision-capture-bridge.js`), `createVisionToolSource` from Task 2 (`node-bot/ai/vision-tool-source.js`).
- Produces: `registerVisionCaptureServer(httpServer, { path = "/ws/vision-capture", bridge })` in `node-bot/vision-capture-server.js` — mirrors `tray-server.js`'s `registerTrayServer` shape exactly (`noServer: true` + manual `upgrade` listener + path check, **not** the `{server, path}` shorthand, which issue #325 already proved breaks other WS servers sharing the same `httpServer`). New route `POST /vision/capture-result` in `server-routes.js`, registered inside the existing `registerCoreRoutes(app, upload, deps)` function.

- [ ] **Step 1: Write the failing tests**

Create `node-bot/test/vision-capture-server-wiring.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd node-bot && node --test test/vision-capture-server-wiring.test.js`
Expected: FAIL — the first three tests fail with 404 (the route doesn't exist yet). The fourth test passes trivially at this point (it's exercising the existing, unmodified `buildAssistantReply`, which doesn't include `vision__look` yet — nothing new to break); it becomes a meaningful check only after Step 5 wires the new tool source into that same array, which is why it's included here rather than skipped as "already passing."

- [ ] **Step 3: Create `node-bot/vision-capture-server.js`**

```js
// Issue #417: the actual WebSocket transport for vision-capture-bridge.js's
// request/response bookkeeping. Mirrors tray-server.js's shape exactly --
// noServer: true plus a manual path check before handing off to
// handleUpgrade, NOT the `{server, path}` shorthand. That shorthand makes
// `ws` attach its own 'upgrade' listener that aborts any path it doesn't
// own, which killed every other WS server sharing the same httpServer
// (issue #325, already fixed once for tray-server.js/caption-server.js --
// same trap, same fix, for a third WS server on this same httpServer).
const WebSocket = require("ws");

function registerVisionCaptureServer(httpServer, { path = "/ws/vision-capture", bridge } = {}) {
  const wss = new WebSocket.Server({ noServer: true });
  const clients = new Set();

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if ((req.url || "").split("?")[0] !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  bridge.setSender((message) => {
    const raw = JSON.stringify(message);
    let sent = false;
    for (const client of clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(raw);
          sent = true;
        }
      } catch (e) {
        // ignore a single bad client; others may still be reachable
      }
    }
    return sent;
  });

  return { wss };
}

module.exports = { registerVisionCaptureServer };
```

- [ ] **Step 4: Add the route to `node-bot/server-routes.js`**

Find the existing `app.post("/vision/describe", ...)` route (around line 164) and add the new route directly after it (still inside `registerCoreRoutes`):

```js
  app.post("/vision/capture-result", (req, res) => {
    try {
      const requestId = requireString(req.body?.requestId, "requestId");
      const image = requireString(req.body?.image, "image");
      const resolved = resolveVisionCapture(requestId, image);
      return res.json({ ok: resolved });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
```

`registerCoreRoutes(app, upload, deps)` destructures everything it needs from `deps` in one block at the top of the function (`const { UNIVERSALIS_DEFAULT_WORLD, TTS_PROVIDER, ..., runVisionReply, getVisionStatus, ... } = deps;`, around line 57). Add `resolveVisionCapture` to that same destructuring list:

```js
    runVisionReply,
    getVisionStatus,
    resolveVisionCapture,
```

(insert the new line directly after the existing `getVisionStatus,` entry)

- [ ] **Step 5: Wire everything into `node-bot/server.js`**

At the top of `server.js`, alongside the existing `const { createExpressionToolSource, isExpressionToolName } = require("./ai/expression-tool-source");` (line 148), add:

```js
const { createVisionToolSource } = require("./ai/vision-tool-source");
const { visionCaptureBridge } = require("./vision-capture-bridge");
```

Inside `buildAssistantReply`, in the tool-source array (the `buildToolPolicy(activeToolPolicy, [...])` call, right after `createExpressionToolSource(),`), add:

```js
            // Issue #417: lets Mana decide mid-reply that seeing the screen
            // would help, instead of vision only being reachable via the
            // hotkey or the ambient screen-sensing loop. Same
            // deps.X || fallback resolution registerCoreRoutes's deps use
            // for these two below (server.js:4742-4747) -- no single
            // shared local exists at this point in registerRoutes to reuse.
            createVisionToolSource({
              getVisionStatus:
                deps.getVisionStatus || (() => llamaServerRuntime.getVisionStatus()),
              runVisionReply:
                deps.runVisionReply ||
                ((prompt, images, maxTokens) =>
                  llamaServerRuntime.runVisionReply(prompt, images, maxTokens)),
              visionCaptureBridge,
              screenSensingPlugin,
              pluginSettingsStore: activePluginSettingsStore,
            }),
```

In the `registerCoreRoutes(app, upload, { ... })` call (around line 4692), add a line alongside the other `deps.X || fallback` entries:

```js
    resolveVisionCapture:
      deps.resolveVisionCapture || visionCaptureBridge.resolveCapture,
```

In `startServer()` (around line 5187, right after the existing tray-server registration block), add:

```js
  // attach vision-capture websocket server (issue #417: lets the model
  // request a fresh screenshot mid-reply)
  try {
    const { registerVisionCaptureServer } = require("./vision-capture-server");
    registerVisionCaptureServer(server, { path: "/ws/vision-capture", bridge: visionCaptureBridge });
  } catch (e) {
    console.warn("Failed to register vision-capture server:", e?.message || e);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd node-bot && node --test test/vision-capture-server-wiring.test.js`
Expected: PASS, 4 tests, 0 failures

- [ ] **Step 7: Run the full node-bot regression suite**

Run: `cd node-bot && npm test`
Expected: PASS, all test files, 0 failures (this touches shared files — `server.js`, `server-routes.js` — so the full suite must stay green, not just the new tests)

- [ ] **Step 8: Commit**

```bash
git add node-bot/vision-capture-server.js node-bot/server-routes.js node-bot/server.js node-bot/test/vision-capture-server-wiring.test.js
git commit -m "Wire vision-capture bridge into server.js: WS transport, capture-result route, tool-source registration (#417)"
```

---

## Task 4: `windows-launcher/main.js` — relay capture requests to the renderer

**Files:**
- Modify: `windows-launcher/main.js`

**Interfaces:**
- Consumes: the existing `getBackendBaseUrl()` function (already defined in `main.js`, used by `getTrayWebSocketUrl()`), the existing global `WebSocket`/`Notification` etc. from the `require("electron")` destructure at the top of the file, `mainWindow` (existing module-level variable).
- Produces: `getVisionCaptureWebSocketUrl()`, `connectVisionCaptureBridge()` — no other file depends on these directly; `connectVisionCaptureBridge()` is called once during app startup, matching `connectTrayNotifications()`.

No automated test for this task (Electron-glue code, matching this codebase's established convention — see Global Constraints).

- [ ] **Step 1: Add the WebSocket URL helper**

Find `function getTrayWebSocketUrl()` in `windows-launcher/main.js` (around line 34) and add directly after it:

```js
function getVisionCaptureWebSocketUrl() {
  return `${getBackendBaseUrl().replace(/^http/, "ws")}/ws/vision-capture`;
}
```

- [ ] **Step 2: Add the relay function**

Find `function connectTrayNotifications()` (around line 1204) and add a new function directly after its closing brace:

```js
// Issue #417: lets the model request a fresh screenshot mid-reply --
// node-bot pushes a "capture-request" over this socket, the renderer
// captures (the same screen:capture-primary IPC the hotkey/ambient-glance
// flows already use) and POSTs the image back to
// POST /vision/capture-result. Same reconnect-on-close shape as
// connectTrayNotifications() just above.
const VISION_CAPTURE_SOCKET_RECONNECT_DELAY_MS = 15000;

function connectVisionCaptureBridge() {
  let socket;
  try {
    socket = new WebSocket(getVisionCaptureWebSocketUrl());
  } catch (error) {
    setTimeout(connectVisionCaptureBridge, VISION_CAPTURE_SOCKET_RECONNECT_DELAY_MS);
    return;
  }

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (
      payload &&
      payload.type === "capture-request" &&
      payload.requestId &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.webContents.send("vision:capture-request", payload.requestId);
    }
  });
  socket.addEventListener("close", () => {
    setTimeout(connectVisionCaptureBridge, VISION_CAPTURE_SOCKET_RECONNECT_DELAY_MS);
  });
}
```

- [ ] **Step 3: Call it during startup**

Find the `app.whenReady().then(() => { ... connectTrayNotifications(); ... })` block (around line 1136) and add the new call directly after `connectTrayNotifications();`:

```js
  connectTrayNotifications();
  connectVisionCaptureBridge();
```

- [ ] **Step 4: Syntax-check**

Run: `cd windows-launcher && node -c main.js`
Expected: no output (valid syntax)

- [ ] **Step 5: Commit**

```bash
git add windows-launcher/main.js
git commit -m "Relay vision-capture requests from node-bot to the renderer (#417)"
```

---

## Task 5: `windows-launcher/renderer/renderer.js` — capture and respond

**Files:**
- Modify: `windows-launcher/renderer/renderer.js`

**Interfaces:**
- Consumes: the existing `ipcRenderer` (from `backend-config.js`'s top-level destructure, already used throughout this file), the existing `ipcRenderer.invoke("screen:capture-primary")` IPC call (already used by `handleVisionHotkey`/the ambient-glance loop), the existing `BACKEND_BASE_URL` module-level constant.
- Produces: nothing another file depends on — this is the terminal leg of the round trip (captures and POSTs the result back).

No automated test for this task (Electron-glue code, matching this codebase's established convention — see Global Constraints).

- [ ] **Step 1: Add the capture-request handler**

Find `ipcRenderer.on("vision:hotkey", () => { handleVisionHotkey(); });` (around line 2799) and add a new handler directly after it:

```js
// Issue #417: node-bot asks (over vision-capture-bridge.js's WebSocket,
// relayed here by main.js) for a fresh screenshot when the model decides
// mid-reply that seeing the screen would help. Captures the same way the
// hotkey/ambient-glance flows already do, then POSTs the result back so
// the server's pending requestCapture() promise resolves. A capture
// failure here is deliberately not reported back explicitly -- it's
// swallowed into a console warning, and the server's own request timeout
// (vision-capture-bridge.js's DEFAULT_TIMEOUT_MS) is what eventually
// surfaces the failure to the model, same as "no client connected" at all.
ipcRenderer.on("vision:capture-request", async (event, requestId) => {
  try {
    const image = await ipcRenderer.invoke("screen:capture-primary");
    await fetch(`${BACKEND_BASE_URL}/vision/capture-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, image }),
    });
  } catch (error) {
    console.warn("Mana vision capture-request failed:", error);
  }
});
```

- [ ] **Step 2: Syntax-check**

Run: `cd windows-launcher && node -c renderer/renderer.js`
Expected: no output (valid syntax)

- [ ] **Step 3: Run the full windows-launcher test suite**

Run: `cd windows-launcher && npm test`
Expected: PASS, all test files, 0 failures (confirms this addition didn't break any existing renderer.js-adjacent test, e.g. `renderer-script-scope.test.js`)

- [ ] **Step 4: Commit**

```bash
git add windows-launcher/renderer/renderer.js
git commit -m "Capture and respond to model-initiated vision-look requests (#417)"
```

---

## Manual end-to-end verification (after all 5 tasks)

Automated tests cover the pure logic and the server-side wiring; the full round trip (a real screenshot, a real Electron window, a real local vision model) needs a manual check once all tasks are merged:

1. Start `node-bot` with a local vision model configured (`getVisionStatus()` reports `available: true`).
2. Start `windows-launcher`, enable the screen-sensing plugin in Settings.
3. Confirm in devtools/console that `connectVisionCaptureBridge()` connected (no repeated "connection failed, retrying" warnings).
4. Trigger a reply where the model would plausibly call `vision__look` (e.g. ask "what am I looking at right now?").
5. Confirm: a screenshot is captured, `POST /vision/capture-result` succeeds, and the model's reply reflects an actual description of the screen content.
6. Disable the screen-sensing plugin and repeat step 4 — confirm the model gets a graceful `"vision look requires the screen-sensing plugin to be enabled"` result, not a crash or hang.
