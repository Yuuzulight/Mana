const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { createAnalysisToolSource, chartArtifact, TOOL_NAME } = require("../ai/analysis-tool-source");

test("analysis can be disabled and copies only explicitly offered non-secret files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-analysis-"));
  try {
    const data = path.join(dir, "data.csv");
    const secret = path.join(dir, ".env");
    fs.writeFileSync(data, "x\n1\n2\n");
    fs.writeFileSync(secret, "TOKEN=secret");
    assert.deepEqual(createAnalysisToolSource({ env: { MANA_ANALYSIS_ENABLED: "0" } }).listToolSchemas(), []);
    assert.deepEqual(createAnalysisToolSource({ env: { MANA_ANALYSIS_HELPER: path.join(dir, "missing-helper.exe") } }).listToolSchemas(), []);
    let called = 0;
    const source = createAnalysisToolSource({
      env: { MANA_ANALYSIS_ENABLED: "1" }, userMessage: `Analyze "${data}" and "${secret}"`,
      runSandbox: async (payload) => {
        called++;
        assert.equal(payload.files[0].name, "data.csv");
        assert.equal(Buffer.from(payload.files[0].data, "base64").toString(), "x\n1\n2\n");
        return { logs: "mean=1.5", charts: [], error: null };
      },
    });
    assert.equal(source.listToolSchemas()[0].function.name, TOOL_NAME);
    assert.match(await source.executeTool(TOOL_NAME, { code: "pass", files: [data] }), /untrusted-.*analysis output/);
    assert.match(await source.executeTool(TOOL_NAME, { code: "pass", files: [secret] }), /credential file/);
    assert.match(await source.executeTool(TOOL_NAME, { code: "pass", files: [path.join(dir, "not-offered.csv")] }), /explicitly named/);
    assert.match(await source.executeTool(TOOL_NAME, { code: "pass", files: [data, data] }), /unique/);
    assert.equal(called, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("analysis delivers charts out of model context and reports unavailable runtime", async () => {
  let delivered;
  const charts = [{ dataUrl: "data:image/png;base64,example" }];
  const source = createAnalysisToolSource({
    env: { MANA_ANALYSIS_ENABLED: "1" }, onCharts: (value) => { delivered = value; },
    runSandbox: async () => ({ logs: "done", charts, error: null }),
  });
  const result = await source.executeTool(TOOL_NAME, { code: "pass" });
  assert.deepEqual(delivered, charts);
  assert.ok(!result.includes("base64"));
  assert.match(chartArtifact(charts), /```html\n<img alt="Analysis chart"/);
  assert.equal(chartArtifact([]), "");
  const unavailable = createAnalysisToolSource({ env: { MANA_ANALYSIS_ENABLED: "1" }, runSandbox: async () => { throw new Error("AppContainer helper is missing"); } });
  assert.match(await unavailable.executeTool(TOOL_NAME, { code: "pass" }), /AppContainer helper is missing/);
});

test("chat wires analysis into the tool policy and appends charts after the model reply", async () => {
  const { createApp } = require("../server");
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const app = createApp({
    env: { ...process.env, MANA_ANALYSIS_ENABLED: "1" },
    isLlamaServerEnabled: () => true,
    runAnalysisSandbox: async () => ({ logs: "mean=2", error: null, charts: [{ dataUrl }] }),
    runToolAwareReply: async (prompt, policy) => {
      assert.ok(policy.tools.some((schema) => schema.function.name === TOOL_NAME));
      const result = await policy.executeTool(TOOL_NAME, { code: "print(2)" });
      assert.match(result, /mean=2/);
      return { content: "The mean is 2.", toolCalls: [{ name: TOOL_NAME, args: { code: "print(2)" }, ok: true }], rounds: 1 };
    },
  });
  const meta = { wrapToolPolicy: (policy) => policy };
  const reply = await app.locals.buildAssistantReply("calculate a mean", "", "", "default", null, null, null, meta);
  assert.match(reply, /The mean is 2/);
  assert.ok(reply.includes(dataUrl));
  assert.match(reply, /```html/);
});
