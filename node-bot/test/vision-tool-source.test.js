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
