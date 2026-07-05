const assert = require("node:assert/strict");
const test = require("node:test");

const { createAcpBackendBridge } = require("../acp-backend-bridge");

function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("backend bridge normalizes base URLs and sends coding replies", async () => {
  const calls = [];
  const bridge = createAcpBackendBridge({
    backendUrl: "http://127.0.0.1:5005/",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createJsonResponse({ reply: "local reply" });
    },
  });

  const reply = await bridge.reply("fix this", "coding");

  assert.equal(reply, "local reply");
  assert.equal(calls[0].url, "http://127.0.0.1:5005/reply");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: "fix this",
    modelProfile: "coding",
    includeContext: false,
  });
});

test("backend bridge exposes workspace editor operations", async () => {
  const calls = [];
  const bridge = createAcpBackendBridge({
    backendUrl: "http://127.0.0.1:5005",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/editors/workspace")) {
        return createJsonResponse({ workspace: { path: "C:\\ManaAI\\Mana" } });
      }
      if (url.includes("/editors/workspace/file")) {
        return createJsonResponse({ relativePath: "app.js", content: "code" });
      }
      if (url.endsWith("/editors/workspace/proposals")) {
        return createJsonResponse({ proposal: { id: "proposal-1" } });
      }
      return createJsonResponse({ proposal: { id: "proposal-1", status: "applied" } });
    },
  });

  assert.equal((await bridge.getWorkspace()).workspace.path, "C:\\ManaAI\\Mana");
  assert.equal((await bridge.readWorkspaceFile("app.js")).content, "code");
  assert.equal((await bridge.createEditProposal({
    path: "app.js",
    proposedContent: "new code",
    summary: "update",
  })).proposal.id, "proposal-1");
  assert.equal((await bridge.approveEditProposal("proposal-1")).proposal.status, "applied");
  assert.equal(calls.some((call) => call.url.includes("path=app.js")), true);
});

test("backend bridge converts HTTP failures into clear errors", async () => {
  const bridge = createAcpBackendBridge({
    backendUrl: "http://127.0.0.1:5005",
    fetchImpl: async () => createJsonResponse({ error: "bad request" }, 400),
  });

  await assert.rejects(
    () => bridge.getWorkspace(),
    /Mana backend request failed: GET .* HTTP 400: bad request/,
  );
});
