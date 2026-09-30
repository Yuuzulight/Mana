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

test("backend bridge sends acceptedHunkIds only when the caller passes them (issue #427)", async () => {
  const calls = [];
  const bridge = createAcpBackendBridge({
    backendUrl: "http://127.0.0.1:5005",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return createJsonResponse({ proposal: { id: "proposal-1", status: "applied" } });
    },
  });

  await bridge.approveEditProposal("proposal-1");
  assert.equal(calls[0].options.body, undefined);

  await bridge.approveEditProposal("proposal-1", ["hunk-0"]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { acceptedHunkIds: ["hunk-0"] });
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

// #842: the editor routes are admin-only, so the bridge sends ADMIN_TOKEN.
test("backend bridge sends the admin token as x-admin-token when it has one", async () => {
  const headers = [];
  const fetchImpl = async (url, options) => {
    headers.push(options.headers);
    return createJsonResponse({ workspace: null });
  };
  await createAcpBackendBridge({ fetchImpl, adminToken: "tok" }).getWorkspace();
  await createAcpBackendBridge({ fetchImpl, adminToken: "" }).getWorkspace();
  assert.equal(headers[0]["x-admin-token"], "tok");
  assert.equal(headers[1]["x-admin-token"], undefined);
});

test("#838: reviewEdit posts the write to /editors/review and returns the review", async () => {
  const calls = [];
  const bridge = createAcpBackendBridge({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return createJsonResponse({ review: { verdict: "refuted", failingCase: "x" } });
    },
  });

  const review = await bridge.reviewEdit({ path: "src/a.js", before: "a", after: "b", summary: "s" });

  assert.deepEqual(review, { verdict: "refuted", failingCase: "x" });
  assert.equal(calls[0].url, "http://127.0.0.1:5005/editors/review");
  assert.deepEqual(calls[0].body, { path: "src/a.js", before: "a", after: "b", summary: "s" });
});
