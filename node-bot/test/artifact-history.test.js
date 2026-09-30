const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { artifactOf, artifactsOf, titleOf, MAX_ARTIFACT_CHARS } = require("../artifact-history");
const { createAcpMemoryStore } = require("../acp-memory-store");
const { sessionsCapability } = require("../capabilities/sessions-capability");
const { withServer } = require("./helpers");

const page = (title, body) => `<html><head><title>${title}</title></head><body>\n<h1>${title}</h1>\n${body}\n</body></html>`;
const reply = (language, content) => `Here you go:\n\n\`\`\`${language}\n${content}\n\`\`\`\n\nEnjoy!`;

test("artifactOf keeps the reply's first artifact verbatim, like the detector", () => {
  assert.deepEqual(artifactOf(reply("html", "<p>a</p>\n  <p>b</p>  ")), { language: "html", content: "<p>a</p>\n  <p>b</p>" });
  assert.equal(artifactOf(reply("python", "print(1)")), null); // short code stays in the bubble
  assert.equal(artifactOf(reply("", "x".repeat(400))).language, "text");
  assert.equal(artifactOf(reply("html", "x".repeat(MAX_ARTIFACT_CHARS + 1))), null);
  assert.equal(artifactOf(undefined), null);
});

test("titleOf is an HTML page's title, else the first line", () => {
  assert.equal(titleOf({ language: "html", content: "<title> Tom &amp; Jerry </title>" }), "Tom & Jerry");
  assert.equal(titleOf({ language: "python", content: "\n  def add(a, b):\n    return a + b" }), "def add(a, b):");
  assert.equal(titleOf({ language: "text", content: "y".repeat(70) }), `${"y".repeat(60)}…`);
});

test("artifactsOf lists a chat's artifacts with versions, without content, before a time", () => {
  const session = {
    turns: [
      { at: "2026-10-01T10:00:00.000Z", assistant: "hi" },
      { at: "2026-10-01T10:01:00.000Z", artifact: { language: "html", content: page("Plan", "<p>one</p>") } },
      { at: "2026-10-01T10:02:00.000Z", artifact: { language: "mermaid", content: "flowchart TD\nA-->B" } },
      { at: "2026-10-01T10:03:00.000Z", artifact: { language: "html", content: page("Plan", "<p>one</p>\n<p>two</p>") } },
      { at: "2026-10-01T10:04:00.000Z", artifact: { language: "html", content: "<p>something else entirely</p>" } },
    ],
  };

  assert.deepEqual(artifactsOf(session), [
    { turn: 1, at: "2026-10-01T10:01:00.000Z", language: "html", title: "Plan", threadId: "html-0", versionIndex: 1 },
    { turn: 2, at: "2026-10-01T10:02:00.000Z", language: "mermaid", title: "flowchart TD", threadId: "mermaid-1", versionIndex: 1 },
    { turn: 3, at: "2026-10-01T10:03:00.000Z", language: "html", title: "Plan", threadId: "html-0", versionIndex: 2 },
    { turn: 4, at: "2026-10-01T10:04:00.000Z", language: "html", title: "<p>something else entirely</p>", threadId: "html-2", versionIndex: 1 },
  ]);
  // Later turns are left out, but still count for the versions before them.
  assert.deepEqual(artifactsOf(session, { before: Date.parse("2026-10-01T10:03:00.000Z") }).map((a) => a.turn), [1, 2]);
  assert.deepEqual(artifactsOf(null), []);
});

test("appendTurn saves the reply's artifact on the turn, with secrets redacted", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-artifact-history-"));
  const store = createAcpMemoryStore({ dataDir, now: () => "2026-10-01T10:00:00.000Z" });
  const html = page("Keys", "<p>token: sk-abcdefghijklmnopqrstuvwxyz0123456789</p>");
  await store.appendTurn({ sessionId: "chat-1", user: "make a page", assistant: reply("html", html) });
  await store.appendTurn({ sessionId: "chat-1", user: "thanks", assistant: "You're welcome!" });

  const turns = createAcpMemoryStore({ dataDir }).getSession("chat-1").turns;
  assert.equal(turns[0].artifact.language, "html");
  assert.match(turns[0].artifact.content, /<body>\n<h1>Keys<\/h1>\n/); // line breaks kept
  assert.doesNotMatch(turns[0].artifact.content, /sk-abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.equal(turns[1].artifact, undefined);
});

test("sessions capability lists a chat's artifacts and serves one's content", async () => {
  const session = {
    sessionId: "chat-1",
    turns: [
      { at: "2026-10-01T10:00:00.000Z", artifact: { language: "html", content: page("Plan", "<p>one</p>") } },
      { at: "2026-10-01T12:00:00.000Z", artifact: { language: "mermaid", content: "flowchart TD\nA-->B" } },
    ],
  };
  const app = express();
  app.use(express.json());
  sessionsCapability.registerRoutes(app, {
    acpMemoryStore: {
      listSessions: () => [],
      getSession: (id) => (id === "chat-1" ? structuredClone(session) : null),
    },
  });

  await withServer(app, async (baseUrl) => {
    const all = await (await fetch(`${baseUrl}/sessions/chat-1/artifacts`)).json();
    assert.deepEqual(all.artifacts.map((a) => [a.turn, a.title]), [[0, "Plan"], [1, "flowchart TD"]]);
    assert.equal("content" in all.artifacts[0], false);

    const before = await (await fetch(`${baseUrl}/sessions/chat-1/artifacts?before=2026-10-01T11:00:00.000Z`)).json();
    assert.deepEqual(before.artifacts.map((a) => a.turn), [0]);

    const one = await fetch(`${baseUrl}/sessions/chat-1/artifacts/1`);
    assert.deepEqual(await one.json(), { language: "mermaid", content: "flowchart TD\nA-->B" });

    assert.equal((await fetch(`${baseUrl}/sessions/chat-1/artifacts/5`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/sessions/chat-1/artifacts/length`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/sessions/other/artifacts`)).status, 404);
  });
});
