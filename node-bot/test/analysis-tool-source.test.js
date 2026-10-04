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
    await assert.rejects(source.executeTool(TOOL_NAME, { code: "pass", files: [secret] }), /credential file/);
    await assert.rejects(source.executeTool(TOOL_NAME, { code: "pass", files: [path.join(dir, "not-offered.csv")] }), /explicitly named/);
    await assert.rejects(source.executeTool(TOOL_NAME, { code: "pass", files: [data, data] }), /unique/);
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
  await assert.rejects(unavailable.executeTool(TOOL_NAME, { code: "pass" }), /AppContainer helper is missing/);
});

test('Python failures propagate with untrusted output instead of appearing successful', async () => {
  const source = createAnalysisToolSource({ env: { MANA_ANALYSIS_ENABLED: '1' },
    runSandbox: async () => ({ logs: 'before failure', error: 'ValueError: expected', charts: [] }) });
  await assert.rejects(source.executeTool(TOOL_NAME, { code: 'raise ValueError()' }), error => {
    assert.match(error.message, /untrusted-.*analysis failure/);
    assert.match(error.message, /before failure/);
    assert.match(error.message, /ValueError/);
    return true;
  });
});

test('analysis rejects credential configuration and reserved input names before execution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-analysis-private-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['.npmrc', 'NuGet.Config', 'worker.py', 'request.json']) {
    const file = path.join(root, name);
    fs.writeFileSync(file, 'private');
    const source = createAnalysisToolSource({ env: { MANA_ANALYSIS_ENABLED: '1' }, userMessage: `Analyze "${file}"`,
      runSandbox: () => assert.fail('must not execute') });
    await assert.rejects(source.executeTool(TOOL_NAME, { code: 'pass', files: [file] }), /credential file|unsupported input filename/);
  }
  const source = createAnalysisToolSource({ env: { MANA_ANALYSIS_ENABLED: '1' }, runSandbox: () => assert.fail('must not execute') });
  await assert.rejects(source.executeTool(TOOL_NAME, { code: ' ' }), /code must contain/);
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

test('chat activity shows Python code, output and failure status', async () => {
  const { createApp } = require('../server');
  const events = [];
  const code = "print('before failure')\nraise ValueError('expected')";
  const app = createApp({ env: { ...process.env, MANA_ANALYSIS_ENABLED: '1' },
    isLlamaServerEnabled: () => true,
    runAnalysisSandbox: async () => ({ logs: 'before failure', error: 'ValueError: expected', charts: [] }),
    runToolAwareReply: async (_prompt, policy) => {
      await assert.rejects(policy.executeTool(TOOL_NAME, { code }), /ValueError/);
      return { content: 'The analysis failed with a ValueError.', toolCalls: [{ name: TOOL_NAME, args: { code }, ok: false }], rounds: 1 };
    },
  });
  await app.locals.buildAssistantReply('run the calculation', '', '', 'default', null, null, null,
    { wrapToolPolicy: policy => policy, onToolCall: event => events.push(event) });
  const end = events.find(event => event.name === TOOL_NAME && event.phase === 'end');
  assert.equal(end.status, 'failed');
  assert.equal(end.detail.command, code);
  assert.match(end.detail.resultPreview, /before failure/);
  assert.match(end.detail.resultPreview, /ValueError/);
});
