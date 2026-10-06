// #1384: improvement proposals check for duplicates, need evidence, and are
// approved as the exact text reviewed. A fake gh, a real approval gate in a
// temp folder; nothing here touches GitHub.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApprovalGate } = require("../approval-gate");
const { IMPROVEMENT_ISSUE_ACTION, createImprovementToolSource, createIssueProposals } = require("../issue-proposals");

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

const BODY = "Transcription websocket reconnect handling stalls whenever laptop hibernation interrupts microphone streaming";

// issues/prs: what the searches return. views: "issue 7" -> issue. fail: "issue list" -> error.
function setup({ issues = [], prs = [], views = {}, fail = {}, lessons = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-proposals-"));
  bases.push(base);
  const roadmap = path.join(base, "repo", "docs", "roadmap");
  fs.mkdirSync(roadmap, { recursive: true });
  fs.writeFileSync(path.join(roadmap, "INDEX.md"), "| Tray icon | done |\n");
  fs.writeFileSync(path.join(roadmap, "active-issues.md"), "# Active\n");
  const calls = [];
  const created = [];
  const gh = async (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    if (fail[key]) throw new Error(fail[key]);
    if (args[1] === "view") {
      const hit = views[`${args[0]} ${args[2]}`];
      if (!hit) throw new Error("not found");
      return JSON.stringify(hit);
    }
    if (key === "issue list") return JSON.stringify(issues);
    if (key === "pr list") return JSON.stringify(prs);
    if (key === "issue create") {
      created.push(args);
      return "https://github.com/Yuuzulight/Mana/issues/9999\n";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const gate = createApprovalGate({ dataDir: path.join(base, "gate") });
  const proposals = createIssueProposals({ gh, repoRoot: path.join(base, "repo"), approvalGate: gate, lessons, env: {} });
  return { proposals, gate, calls, created };
}

const existing = (over) => ({ number: 50, title: "Reconnect after hibernate", state: "OPEN", closedAt: null, url: "https://github.com/x/y/issues/50", body: BODY, ...over });
const fresh = { title: "Mic stalls on resume", body: BODY, evidence: ["test: voice-resume.test.js failed twice"] };

test("a renamed title still matches through its body, and nothing is filed", async () => {
  const { proposals, gate, created } = setup({ issues: [existing()] });
  const r = await proposals.propose(fresh);
  assert.equal(r.status, "not-filed");
  assert.equal(r.decision, "link");
  assert.equal(r.to.number, 50);
  assert.match(r.matches[0].why, /shared words/);
  assert.equal(gate.listPending().length, 0);
  assert.equal(created.length, 0);
});

test("an exact #N reference links to it", async () => {
  const view = { number: 77, title: "Something else", state: "OPEN", url: "https://github.com/x/y/issues/77" };
  const { proposals } = setup({ views: { "issue 77": view } });
  const r = await proposals.findRelated({ title: "Totally different words here", body: "Follow-up to #77" });
  assert.equal(r.decision, "link");
  assert.equal(r.to.number, 77);
  assert.equal(r.to.score, 1);
  assert.equal(r.to.why, "referenced as #77");
});

test("a closed issue that matches is a possible regression, never reopened", async () => {
  const { proposals, calls, created } = setup({ issues: [existing({ number: 31, state: "CLOSED", closedAt: "2026-09-01T00:00:00Z" })] });
  const r = await proposals.propose(fresh);
  assert.equal(r.decision, "reopen-or-regression");
  assert.equal(r.to.number, 31);
  assert.equal(r.status, "not-filed");
  assert.equal(created.length, 0);
  assert.ok(calls.every((c) => !["close", "reopen", "edit", "merge"].includes(c[1])));
});

test("an unrelated proposal is filed after approval, with its evidence and what was checked", async () => {
  const unrelated = existing({ number: 12, title: "Fix tray icon flicker", body: "Tray icon flickers when theme changes" });
  const { proposals, gate, created } = setup({ issues: [unrelated] });
  const r = await proposals.propose({ title: "Cache emoji sprites between renders", body: "Sprite atlas rebuilds every frame wasting GPU time", evidence: ["trace: run 4411"] });
  assert.equal(r.status, "pending-approval");
  assert.equal(r.decision, "new");
  assert.deepEqual(r.limits, []);
  assert.equal(created.length, 0);
  const done = await gate.decide(r.requestId, "allow-once");
  assert.equal(done.status, "approved");
  assert.equal(created.length, 1);
  const args = created[0];
  assert.ok(args.includes("--title=Cache emoji sprites between renders"));
  const body = args.find((a) => a.startsWith("--body="));
  assert.match(body, /## Evidence\n- trace: run 4411/);
  assert.match(body, /## Related/);
});

test("a failed search shows in limits and still allows a new issue", async () => {
  const { proposals } = setup({ fail: { "issue list": "rate limited" } });
  const r = await proposals.propose({ title: "Cache emoji sprites between renders", body: "Sprite atlas rebuilds every frame", evidence: ["log: tts.log"] });
  assert.equal(r.status, "pending-approval");
  assert.equal(r.decision, "new");
  assert.deepEqual(r.limits, ["issue search failed: rate limited"]);
});

test("open lessons that share words show up as matches", async () => {
  const lessons = { listOpen: async () => [{ title: "Websocket reconnect handling", observed: "microphone streaming stalls after laptop hibernation" }] };
  const { proposals } = setup({ lessons });
  const r = await proposals.findRelated(fresh);
  assert.equal(r.matches[0].kind, "lesson");
});

test("no evidence is refused before anything is searched", async () => {
  const { proposals, calls } = setup();
  for (const evidence of [undefined, [], ["  "]]) {
    const r = await proposals.propose({ ...fresh, evidence });
    assert.equal(r.status, "refused");
    assert.match(r.reason, /evidence/);
  }
  assert.equal(calls.length, 0);
});

test("concurrent proposals: the second says it is already proposed", async () => {
  const { proposals, gate } = setup();
  const one = { title: "Cache emoji sprites between renders", body: "Sprite atlas rebuilds every frame", evidence: ["log: a"] };
  const [a, b] = await Promise.all([proposals.propose(one), proposals.propose({ ...one })]);
  assert.deepEqual([a.status, b.status].sort(), ["already-proposed", "pending-approval"]);
  // Reworded, and after the first reached the queue: still the same proposal.
  const c = await proposals.propose({ ...one, title: "Cache emoji sprites between frames" });
  assert.equal(c.status, "already-proposed");
  assert.equal(gate.listPending().length, 1);
});

test("the approval is bound to the reviewed payload", async () => {
  const { proposals, gate, created } = setup();
  const r = await proposals.propose({ title: "Cache emoji sprites between renders", body: "Sprite atlas rebuilds every frame", evidence: ["log: a"] });
  const entry = gate.listPending().find((p) => p.id === r.requestId);
  assert.equal(entry.actionType, IMPROVEMENT_ISSUE_ACTION);
  assert.equal(entry.forceReview, true);
  assert.match(entry.grantKey, /^improvement-issue:[0-9a-f]{64}$/);
  entry.payload.body = "something I never reviewed";
  await assert.rejects(gate.decide(r.requestId, "allow-once"), /changed after it was reviewed/);
  assert.equal(created.length, 0);
});

test("a denied approval files nothing", async () => {
  const { proposals, gate, created } = setup();
  const r = await proposals.propose({ title: "Cache emoji sprites between renders", body: "Sprite atlas rebuilds every frame", evidence: ["log: a"] });
  assert.equal((await gate.decide(r.requestId, "deny")).status, "denied");
  assert.equal(created.length, 0);
});

test("the tool source forwards to propose and reports a refusal", async () => {
  const { proposals } = setup();
  const source = createImprovementToolSource(proposals);
  assert.equal(source.listToolSchemas()[0].function.name, "improvement__propose");
  assert.ok(source.isKnownToolName("improvement__propose"));
  const out = JSON.parse(await source.executeTool("improvement__propose", { title: "t", body: "b", evidence: [] }));
  assert.equal(out.status, "refused");
});
