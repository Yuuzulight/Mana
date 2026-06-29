const assert = require("node:assert/strict");
const test = require("node:test");

const { createVTubeRuntime } = require("../vtube-runtime");

test("vtube runtime picks phrase reactions before default", () => {
  const runtime = createVTubeRuntime({
    env: {
      VTUBE_STUDIO_REACTIONS_JSON: JSON.stringify({
        hello: "Wave",
        default: "Idle",
      }),
    },
    vtubeStudio: {},
  });

  assert.equal(runtime.pickVTubeReaction("well hello there"), "Wave");
  assert.equal(runtime.pickVTubeReaction("nothing matched"), "Idle");
});

test("vtube runtime treats invalid reaction JSON as no reaction", () => {
  const runtime = createVTubeRuntime({
    env: {
      VTUBE_STUDIO_REACTIONS_JSON: "{bad json",
    },
    vtubeStudio: {},
  });

  assert.equal(runtime.pickVTubeReaction("hello"), null);
});

test("vtube runtime queues no reaction when integration is disabled", async () => {
  const runtime = createVTubeRuntime({
    vtubeStudio: null,
  });

  assert.equal(await runtime.triggerVTubeReactionForReply("hello"), null);
  assert.doesNotThrow(() => runtime.queueVTubeReaction("hello"));
});

test("vtube runtime triggers matching hotkey", async () => {
  const calls = [];
  const runtime = createVTubeRuntime({
    env: {
      VTUBE_STUDIO_REACTIONS_JSON: JSON.stringify({ thanks: "Smile" }),
    },
    vtubeStudio: {
      triggerHotkey: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    },
  });

  const result = await runtime.triggerVTubeReactionForReply("thanks");

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ hotkeyName: "Smile" }]);
});
