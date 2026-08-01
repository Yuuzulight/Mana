const assert = require("node:assert/strict");
const test = require("node:test");

const { judgeActionRisk } = require("../ai/guardian-precheck");

test("judgeActionRisk resolves safe:true when the model answers SAFE", async () => {
  const verdict = await judgeActionRisk({
    actionType: "skill-write",
    summary: "fix a typo in a skill description",
    payload: { text: "small change" },
    runLocalReply: async () => "SAFE",
  });
  assert.deepEqual(verdict, { safe: true, reason: "" });
});

test("judgeActionRisk resolves safe:false when the model answers RISKY", async () => {
  const verdict = await judgeActionRisk({
    actionType: "generated-script-run",
    summary: "run a script",
    payload: {},
    runLocalReply: async () => "RISKY",
  });
  assert.equal(verdict.safe, false);
});

test("judgeActionRisk is case-insensitive and tolerates surrounding whitespace", async () => {
  const verdict = await judgeActionRisk({
    actionType: "skill-write",
    payload: {},
    runLocalReply: async () => "  safe\n",
  });
  assert.equal(verdict.safe, true);
});

test("judgeActionRisk resolves safe:false on an unclear/empty model reply", async () => {
  const verdict = await judgeActionRisk({
    actionType: "skill-write",
    payload: {},
    runLocalReply: async () => "unsure, maybe?",
  });
  assert.equal(verdict.safe, false);
  assert.equal(verdict.reason, "unclear guardian verdict");
});

test("judgeActionRisk resolves safe:false when runLocalReply throws", async () => {
  const verdict = await judgeActionRisk({
    actionType: "skill-write",
    payload: {},
    runLocalReply: async () => {
      throw new Error("model unavailable");
    },
  });
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /model unavailable/);
});

test("judgeActionRisk falls back to serializing the payload when scanText is absent", async () => {
  let capturedPrompt = "";
  await judgeActionRisk({
    actionType: "skill-write",
    payload: { key: "some very specific payload marker" },
    runLocalReply: async (prompt) => {
      capturedPrompt = prompt;
      return "SAFE";
    },
  });
  assert.match(capturedPrompt, /some very specific payload marker/);
});

test("judgeActionRisk prefers scanText over the serialized payload when both are given", async () => {
  let capturedPrompt = "";
  await judgeActionRisk({
    actionType: "skill-write",
    payload: { key: "payload marker" },
    scanText: "scan text marker",
    runLocalReply: async (prompt) => {
      capturedPrompt = prompt;
      return "SAFE";
    },
  });
  assert.match(capturedPrompt, /scan text marker/);
  assert.doesNotMatch(capturedPrompt, /payload marker/);
});

test("judgeActionRisk never throws even when payload can't be serialized", async () => {
  const circular = {};
  circular.self = circular;
  const verdict = await judgeActionRisk({
    actionType: "skill-write",
    payload: circular,
    runLocalReply: async () => "SAFE",
  });
  assert.equal(verdict.safe, true);
});
