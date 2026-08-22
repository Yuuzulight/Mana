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
    async screenshot() {
      return Buffer.from("fake-jpeg-bytes");
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

// Issue #418: the human-facing activity feed, entirely separate from what
// executeTool returns to the model.
test("executeTool records a successful action and its screenshot in the activity log", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const { source } = createSource({ approvalGate });
  await source.executeTool("browser_automation__navigate", { url: "https://example.com" }).catch(() => {});
  const [pending] = approvalGate.listPending();
  await approvalGate.decide(pending.id, "always-allow");

  await source.executeTool("browser_automation__navigate", { url: "https://example.com" });

  const activity = source.activityLog.getActivity();
  assert.equal(activity.log.length, 1);
  assert.equal(activity.log[0].action, "navigate");
  assert.equal(activity.log[0].status, "ok");
  assert.match(activity.log[0].summary, /Navigating to https:\/\/example\.com/);
  assert.equal(activity.screenshot.base64, Buffer.from("fake-jpeg-bytes").toString("base64"));
});

test("executeTool records a failed action in the activity log and still rejects with the real error", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const failingSession = {
    navigate: async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
    screenshot: async () => Buffer.from("unused"),
  };
  const { source } = createSource({ approvalGate, getSession: async () => failingSession });
  await source.executeTool("browser_automation__navigate", { url: "https://bad.test" }).catch(() => {});
  const [pending] = approvalGate.listPending();
  await approvalGate.decide(pending.id, "always-allow");

  await assert.rejects(
    () => source.executeTool("browser_automation__navigate", { url: "https://bad.test" }),
    /net::ERR_NAME_NOT_RESOLVED/,
  );

  const activity = source.activityLog.getActivity();
  assert.equal(activity.log.length, 1);
  assert.equal(activity.log[0].status, "error");
  assert.match(activity.log[0].summary, /failed: net::ERR_NAME_NOT_RESOLVED/);
  // A failed action's page state is irrelevant -- no screenshot is captured.
  assert.equal(activity.screenshot, null);
});

// Regression: session.screenshot().catch(() => null) alone would not have
// caught this -- calling a missing method throws synchronously, before
// .catch ever attaches, and would fail the whole executeTool call even
// though the real action (navigate) already succeeded.
test("executeTool still succeeds when the session has no screenshot function at all", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const sessionWithNoScreenshot = {
    navigate: async (url) => ({ url, title: "ok" }),
  };
  const { source } = createSource({ approvalGate, getSession: async () => sessionWithNoScreenshot });
  await source.executeTool("browser_automation__navigate", { url: "https://example.com" }).catch(() => {});
  const [pending] = approvalGate.listPending();
  await approvalGate.decide(pending.id, "always-allow");

  const result = JSON.parse(
    await source.executeTool("browser_automation__navigate", { url: "https://example.com" }),
  );
  assert.equal(result.url, "https://example.com");

  const activity = source.activityLog.getActivity();
  assert.equal(activity.log[0].status, "ok");
  assert.equal(activity.screenshot, null);
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
