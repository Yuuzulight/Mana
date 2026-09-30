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

// #787: an unusable tool isn't offered -- goal mode spent rounds retrying it.
test("listToolSchemas offers nothing without a vision model or with screen sensing off", () => {
  assert.deepEqual(createVisionToolSource(baseOptions({ getVisionStatus: () => ({ available: false }) })).listToolSchemas(), []);
  assert.deepEqual(createVisionToolSource(baseOptions({ pluginSettingsStore: fakePluginSettingsStore(false) })).listToolSchemas(), []);
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

test("executeTool returns a graceful error when runVisionReply rejects, instead of throwing", async () => {
  // Finding 2 (issue #417 whole-branch review): runVisionReply sits outside
  // any try/catch, which broke this module's own documented contract that
  // every failure comes back as {status:"error"} JSON, never a thrown
  // exception -- e.g. a llama-server vision reply failure (bad status,
  // empty reply, retry cooldown) used to propagate straight up uncaught.
  const source = createVisionToolSource(
    baseOptions({
      runVisionReply: async () => {
        throw new Error("llama-server vision reply failed (400): bad request");
      },
    }),
  );
  const result = await source.executeTool(`${VISION_TOOL_PREFIX}look`, { prompt: "what's open?" });
  const parsed = JSON.parse(result);
  assert.equal(parsed.status, "error");
  assert.match(
    parsed.error,
    /could not describe the screen: llama-server vision reply failed \(400\): bad request/,
  );
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

// #912: vision__camera is offered only with a camera-capable client, not
// tied to screen sensing, and asks the bridge for a camera snapshot.
test("the camera tool follows the camera client, not screen sensing", async () => {
  let seenOptions = null;
  const cameraBridge = (hasCamera) => ({
    hasCamera: () => hasCamera,
    requestCapture: async (options) => {
      seenOptions = options;
      return "data:image/jpeg;base64,cam";
    },
  });
  const names = (source) => source.listToolSchemas().map((t) => t.function.name);

  assert.deepEqual(names(createVisionToolSource(baseOptions({ visionCaptureBridge: cameraBridge(false) }))), [`${VISION_TOOL_PREFIX}look`]);
  const source = createVisionToolSource(
    baseOptions({ visionCaptureBridge: cameraBridge(true), pluginSettingsStore: fakePluginSettingsStore(false) }),
  );
  assert.deepEqual(names(source), [`${VISION_TOOL_PREFIX}camera`, `${VISION_TOOL_PREFIX}save_snapshot`]);

  const result = await source.executeTool(`${VISION_TOOL_PREFIX}camera`, { prompt: "what am I holding?" });
  assert.equal(JSON.parse(result).status, "ok");
  assert.deepEqual(seenOptions, { camera: true });
});

// #962: saving the last snapshot is offered with a camera client (even
// without a vision model), asks the launcher to save, and is write tier.
test("the save-snapshot tool asks the launcher to save and reports the file", async () => {
  const { classifyToolCall } = require("../ai/tool-risk");
  let answer = "C:\Users\me\Pictures\Mana\Mana 2026-09-30 12-00-00.jpg";
  let seenOptions = null;
  const bridge = {
    hasCamera: () => true,
    requestCapture: async (options) => {
      seenOptions = options;
      return answer;
    },
  };
  const source = createVisionToolSource(baseOptions({ visionCaptureBridge: bridge, getVisionStatus: () => ({ available: false }) }));
  assert.deepEqual(source.listToolSchemas().map((t) => t.function.name), [`${VISION_TOOL_PREFIX}save_snapshot`]);

  const result = JSON.parse(await source.executeTool(`${VISION_TOOL_PREFIX}save_snapshot`, {}));
  assert.deepEqual(result, { status: "ok", saved: answer });
  assert.deepEqual(seenOptions, { save: true });
  assert.equal(classifyToolCall(`${VISION_TOOL_PREFIX}save_snapshot`, {}).tier, "write");

  // An older launcher answers a screenshot instead of a path.
  answer = "data:image/jpeg;base64,screen";
  assert.match(JSON.parse(await source.executeTool(`${VISION_TOOL_PREFIX}save_snapshot`, {})).error, /can't save snapshots/);
});
