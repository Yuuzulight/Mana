const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApprovalGate } = require("../../../node-bot/approval-gate");
const {
  APPROVAL_ACTION_TYPE,
  TOOL_SCHEMAS,
  isBrowserAutomationToolName,
  createBrowserAutomationToolSource,
  buildToolPolicyWithBrowserAutomation,
} = require("../browser-automation-tool-source");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-browser-tool-source-"));
}

// A fake page-like object matching browser-automation.js's own {goto,
// evaluate, click, type, title, url} shape -- same fake the plugin's own
// unit tests already use, so createBrowserSession's real logic runs
// unmodified; only the underlying page is fake.
function createFakePage() {
  let currentUrl = "about:blank";
  return {
    async goto(url) {
      currentUrl = url;
    },
    async evaluate(fn) {
      return typeof fn === "function" && fn.name === "extractTextInPage" ? "page text" : [];
    },
    async click() {},
    async type() {},
    async title() {
      return "Fake Page";
    },
    async url() {
      return currentUrl;
    },
  };
}

function createSource(overrides = {}) {
  const approvalGate = overrides.approvalGate || createApprovalGate({ dataDir: createTempDir() });
  const { createBrowserSession } = require("../browser-automation");
  const session = overrides.session || createBrowserSession({ page: createFakePage() });
  const getSession = overrides.getSession || (async () => session);
  return { source: createBrowserAutomationToolSource({ getSession, approvalGate }), approvalGate, session };
}

test("listToolSchemas exposes navigate/snapshot/click/type as OpenAI-shaped tool schemas", () => {
  const { source } = createSource();
  const schemas = source.listToolSchemas();
  assert.deepEqual(
    schemas.map((s) => s.function.name).sort(),
    ["browser_automation__click", "browser_automation__navigate", "browser_automation__snapshot", "browser_automation__type"],
  );
  assert.equal(schemas.length, TOOL_SCHEMAS.length);
  for (const schema of schemas) {
    assert.equal(schema.type, "function");
    assert.equal(typeof schema.function.description, "string");
  }
});

test("isBrowserAutomationToolName distinguishes this source's names from anything else", () => {
  assert.equal(isBrowserAutomationToolName("browser_automation__navigate"), true);
  assert.equal(isBrowserAutomationToolName("read_file"), false);
  assert.equal(isBrowserAutomationToolName("mcp__docs__search"), false);
});

test("executeTool requires approval on first use and does not touch the browser until approved", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  let sessionRequested = false;
  const { source } = createSource({
    approvalGate,
    getSession: async () => {
      sessionRequested = true;
      throw new Error("should not be called before approval");
    },
  });

  await assert.rejects(
    () => source.executeTool("browser_automation__navigate", { url: "https://example.com" }),
    /needs approval first/,
  );
  assert.equal(sessionRequested, false);
  assert.equal(approvalGate.listPending().length, 1);
  assert.equal(approvalGate.listPending()[0].actionType, APPROVAL_ACTION_TYPE);
});

test("executeTool runs the real session action once the approval gate always-allows it", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const { source } = createSource({ approvalGate });

  // First call requests approval and fails.
  await assert.rejects(() => source.executeTool("browser_automation__navigate", { url: "https://example.com" }));
  const [pending] = approvalGate.listPending();
  await approvalGate.decide(pending.id, "always-allow");

  const navigateResult = JSON.parse(await source.executeTool("browser_automation__navigate", { url: "https://example.com" }));
  assert.equal(navigateResult.url, "https://example.com/");
  assert.equal(navigateResult.title, "Fake Page");

  const snapshotResult = JSON.parse(await source.executeTool("browser_automation__snapshot", {}));
  assert.equal(snapshotResult.title, "Fake Page");

  // No further approval needed -- already-trusted actionType.
  assert.equal(approvalGate.listPending().length, 0);
});

test("executeTool rejects an unrecognized browser-automation tool name even when approved", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const { source } = createSource({ approvalGate });
  await source.executeTool("browser_automation__navigate", { url: "https://example.com" }).catch(() => {});
  const [pending] = approvalGate.listPending();
  await approvalGate.decide(pending.id, "always-allow");

  await assert.rejects(
    () => source.executeTool("browser_automation__teleport", {}),
    /unknown browser-automation tool/,
  );
});

test("buildToolPolicyWithBrowserAutomation merges base and browser-automation tools and routes correctly", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const { source } = createSource({ approvalGate });
  await source.executeTool("browser_automation__navigate", { url: "https://example.com" }).catch(() => {});
  const [pending] = approvalGate.listPending();
  await approvalGate.decide(pending.id, "always-allow");

  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name) => `local:${name}`,
  };
  const merged = await buildToolPolicyWithBrowserAutomation(basePolicy, source);
  assert.equal(merged.tools.length, 1 + TOOL_SCHEMAS.length);
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool("browser_automation__click"), true);
  assert.equal(merged.isKnownTool("nope"), false);

  assert.equal(await merged.executeTool("read_file", {}), "local:read_file");
  const snapshotResult = JSON.parse(await merged.executeTool("browser_automation__snapshot", {}));
  assert.equal(snapshotResult.title, "Fake Page");
});
