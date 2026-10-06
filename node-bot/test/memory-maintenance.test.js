// #1390: memory maintenance, always against a temp dir.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore } = require("../acp-memory-store");
const { createMemoryGraph } = require("../memory-graph");
const { createMemoryMaintenance } = require("../memory-maintenance");
const { createSessionSearchIndex } = require("../session-search-index");

const NOW = "2026-10-06T00:00:00.000Z";
const OLD = "2024-01-01T00:00:00.000Z";
const RECENT = "2026-09-30T00:00:00.000Z";

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-maint-"));
  const searchIndex = createSessionSearchIndex({ dbPath: path.join(dir, "session-search.db") });
  const memoryGraph = createMemoryGraph({ dbPath: path.join(dir, "memory-graph.db"), maxDegree: 1, now: () => OLD });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const w = {
    dir, searchIndex, memoryGraph,
    session(id, updatedAt, more = {}) {
      const file = path.join(dir, "sessions", `${Buffer.from(id).toString("base64url")}.json`);
      fs.writeFileSync(file, JSON.stringify({ sessionId: id, updatedAt, turns: [], ...more }));
      return file;
    },
    facts: (facts) => fs.writeFileSync(path.join(dir, "facts.json"), JSON.stringify({ facts })),
    maint: (opts = {}) =>
      createMemoryMaintenance({ store: { dataDir: dir }, searchIndex, memoryGraph, now: () => NOW, ...extra, ...opts }),
    inSessions: (id) => fs.existsSync(path.join(dir, "sessions", `${Buffer.from(id).toString("base64url")}.json`)),
    inArchive: (id) => fs.existsSync(path.join(dir, "archive", "sessions", `${Buffer.from(id).toString("base64url")}.json`)),
    cleanup() {
      searchIndex.close();
      memoryGraph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return w;
}

test("a session a live fact needs is kept, an unneeded old one is archived (never deleted) only when approved", async () => {
  const w = setup();
  try {
    for (const id of ["s-active", "s-pinned", "s-intent", "s-pending", "s-origin", "s-free", "s-archived-fact", "s-parent"]) {
      w.session(id, OLD);
    }
    w.session("s-new", RECENT);
    w.session("s-fork", RECENT, { forkedFrom: "s-parent" });
    w.facts([
      { key: "a", status: "active", sessionId: "s-active" },
      { key: "b", status: "archived", pinned: true, sessionId: "s-pinned" },
      { key: "c", status: "archived", trigger: "when X", sessionId: "s-intent" },
      { key: "d", status: "pending", sessionId: "s-pending" },
      { key: "e", status: "active", origin: { sessionId: "s-origin" } },
      { key: "f", status: "archived", sessionId: "s-archived-fact" },
    ]);
    const m = w.maint();

    const plan = m.plan();
    const step = plan.steps.find((s) => s.id === "archive-session");
    assert.equal(step.kind, "needs-approval");
    assert.equal(step.target, "2 sessions");
    const why = Object.fromEntries(plan.kept.map((k) => [k.what, k.why]));
    assert.match(why["s-pinned"], /pinned fact/);
    assert.match(why["s-intent"], /standing intent/);
    assert.match(why["s-pending"], /pending fact/);
    assert.match(why["s-parent"], /parent of retained fork s-fork/);

    const auto = await m.run({ mode: "auto" });
    assert.ok(auto.proposed.some((s) => s.id === "archive-session"));
    assert.ok(w.inSessions("s-free"), "auto mode never archives a session");

    const done = await m.run({ mode: "approved", approve: ["archive-session"] });
    assert.deepEqual(done.done, ["archive-session"]);
    assert.equal(done.archived, 2);
    for (const id of ["s-free", "s-archived-fact"]) assert.ok(w.inArchive(id) && !w.inSessions(id), id);
    for (const id of ["s-active", "s-pinned", "s-intent", "s-pending", "s-origin", "s-new", "s-parent", "s-fork"]) {
      assert.ok(w.inSessions(id), id);
    }
  } finally {
    w.cleanup();
  }
});

test("corrupt facts-log lines, a corrupt session and an unreadable facts.json are reported, not dropped", async () => {
  const w = setup();
  try {
    const corruptSession = w.session("s-bad", OLD);
    fs.writeFileSync(corruptSession, "{not json");
    const goodLine = JSON.stringify({ at: OLD, op: "add", key: "k" });
    fs.writeFileSync(path.join(w.dir, "facts-log.jsonl"), `${goodLine}\n{torn\n${JSON.stringify({ op: "add", key: "k" })}\n`);
    const m = w.maint();

    const kept = m.plan().kept;
    assert.ok(kept.some((k) => k.what === "s-bad" && /corrupt/.test(k.why)));
    assert.ok(kept.some((k) => k.store === "facts-log" && /unparseable/.test(k.what)));

    await m.run({ mode: "approved", approve: ["archive-session"] });
    assert.ok(w.inSessions("s-bad"), "a corrupt session is left where it is");
    const live = fs.readFileSync(path.join(w.dir, "facts-log.jsonl"), "utf8");
    assert.ok(live.includes("{torn") && !live.includes(goodLine), "only the parseable old line moved");
    assert.ok(live.includes('"op":"add","key":"k"}'), "a line without `at` stays live");

    fs.writeFileSync(path.join(w.dir, "facts.json"), "{broken");
    const plan = m.plan();
    assert.ok(!plan.steps.some((s) => s.id === "archive-session"));
    assert.ok(plan.kept.some((k) => /facts.json unreadable/.test(k.why)));
  } finally {
    w.cleanup();
  }
});

test("search and entity reconcile drop rows of a deleted session only", async () => {
  const w = setup();
  try {
    w.session("alive", RECENT);
    w.searchIndex.indexTurn({ sessionId: "alive", turn: { user: "walrus question", at: RECENT } });
    w.searchIndex.indexTurn({ sessionId: "gone", turn: { user: "walrus gossip", at: RECENT } });
    fs.writeFileSync(
      path.join(w.dir, "entity-index.json"),
      JSON.stringify({
        walrus: [{ sessionId: "alive", at: RECENT }, { sessionId: "gone", at: RECENT }],
        ghost: [{ sessionId: "gone", at: RECENT }],
      }),
    );
    const report = await w.maint().run({ mode: "auto" });
    assert.deepEqual(report.done, ["reconcile-search", "reconcile-entities"]);
    assert.equal(report.reconciled, 3);
    assert.deepEqual(w.searchIndex.search({ query: "walrus" }).map((r) => r.sessionId), ["alive"]);
    const index = JSON.parse(fs.readFileSync(path.join(w.dir, "entity-index.json"), "utf8"));
    assert.deepEqual(Object.keys(index), ["walrus"]);
    assert.equal(index.walrus.length, 1);
  } finally {
    w.cleanup();
  }
});

test("an empty sessions dir never wipes the search index", async () => {
  const w = setup();
  try {
    w.searchIndex.indexTurn({ sessionId: "x", turn: { user: "keep me", at: RECENT } });
    const m = w.maint();
    assert.ok(!m.plan().steps.some((s) => s.id === "reconcile-search"));
    await m.run({ mode: "auto" });
    assert.equal(w.searchIndex.search({ query: "keep" }).length, 1);
  } finally {
    w.cleanup();
  }
});

test("archiving the facts log keeps getFactHistory complete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-maint-"));
  let clock = OLD;
  const store = createAcpMemoryStore({ dataDir: dir, now: () => clock });
  try {
    const human = { source: "human", origin: { kind: "user_stated" } };
    store.rememberFact({ key: "color", text: "blue", ...human });
    clock = RECENT;
    store.rememberFact({ key: "color", text: "green", action: "patch", ...human });
    const before = store.getFactHistory("color");
    assert.ok(before.some((e) => e.at === OLD) && before.some((e) => e.at === RECENT));

    const m = createMemoryMaintenance({ store, dataDir: dir, now: () => NOW });
    const report = await m.run({ mode: "auto" });
    assert.deepEqual(report.done, ["archive-facts-log"]);
    assert.ok(fs.existsSync(path.join(dir, "archive", "facts-log-2024.jsonl")));
    const live = fs.readFileSync(path.join(dir, "facts-log.jsonl"), "utf8").trim().split("\n");
    assert.equal(live.length, before.filter((e) => e.at === RECENT).length, "only the recent lines stay live");
    assert.deepEqual(store.getFactHistory("color"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling between steps leaves a checkpoint and the next run resumes it", async () => {
  const w = setup();
  try {
    w.session("alive", RECENT);
    w.searchIndex.indexTurn({ sessionId: "gone", turn: { user: "walrus", at: RECENT } });
    fs.writeFileSync(path.join(w.dir, "entity-index.json"), JSON.stringify({ walrus: [{ sessionId: "gone" }] }));
    const controller = new AbortController();
    // Cancel as the first step finishes.
    const searchIndex = new Proxy(w.searchIndex, {
      get: (target, prop) => prop === "removeSessions" ? (ids) => { const n = target.removeSessions(ids); controller.abort(); return n; } : target[prop],
    });
    const m = w.maint({ searchIndex });

    const first = await m.run({ mode: "auto", signal: controller.signal });
    assert.equal(first.aborted, true);
    assert.deepEqual(first.done, ["reconcile-search"]);
    assert.equal(m.status().incomplete, true);
    assert.ok(fs.existsSync(path.join(w.dir, "entity-index.json")), "entities not reconciled yet");
    assert.match(fs.readFileSync(path.join(w.dir, "entity-index.json"), "utf8"), /gone/);

    const second = await m.run({ mode: "auto" });
    assert.equal(second.planId, first.planId, "the same pass is resumed");
    assert.deepEqual(second.done, ["reconcile-search", "reconcile-entities"]);
    assert.equal(m.status().incomplete, false);
    assert.doesNotMatch(fs.readFileSync(path.join(w.dir, "entity-index.json"), "utf8"), /gone/);
  } finally {
    w.cleanup();
  }
});

test("a step that throws is restored from its backup and stops the pass", async () => {
  const w = setup();
  const realRename = fs.renameSync;
  try {
    w.session("alive", RECENT);
    const entities = JSON.stringify({ walrus: [{ sessionId: "gone", at: RECENT }] });
    fs.writeFileSync(path.join(w.dir, "entity-index.json"), entities);
    const logLine = `${JSON.stringify({ at: OLD, op: "add", key: "k" })}\n`;
    fs.writeFileSync(path.join(w.dir, "facts-log.jsonl"), logLine);
    const m = w.maint();

    // The write lands, then fails: the backup has to put the old file back.
    fs.renameSync = (from, to) => {
      realRename(from, to);
      if (String(to).endsWith("entity-index.json")) throw new Error("disk went away");
    };
    const report = await m.run({ mode: "auto" });
    fs.renameSync = realRename;

    assert.deepEqual(report.failed.map((f) => f.id), ["reconcile-entities"]);
    assert.match(report.failed[0].error, /disk went away/);
    assert.equal(fs.readFileSync(path.join(w.dir, "entity-index.json"), "utf8"), entities);
    assert.equal(fs.readFileSync(path.join(w.dir, "facts-log.jsonl"), "utf8"), logLine, "later steps did not run");
    assert.deepEqual(report.skipped, ["archive-facts-log"]);
    assert.equal(m.status().failed[0].id, "reconcile-entities");

    const retry = await m.run({ mode: "auto" });
    assert.deepEqual(retry.failed, []);
    assert.deepEqual(retry.done, ["reconcile-entities", "archive-facts-log"]);
  } finally {
    fs.renameSync = realRename;
    w.cleanup();
  }
});

test("an interrupted step (process died mid-way) is restored and redone on the next run", async () => {
  const w = setup();
  try {
    w.session("alive", RECENT);
    const entities = JSON.stringify({ walrus: [{ sessionId: "gone", at: RECENT }] });
    fs.writeFileSync(path.join(w.dir, "entity-index.json"), entities);
    const backup = path.join(w.dir, "maintenance", "backup", "p1");
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, "entity-index.json"), entities);
    fs.writeFileSync(path.join(w.dir, "entity-index.json"), "half written");
    fs.writeFileSync(
      path.join(w.dir, "maintenance", "checkpoint.json"),
      JSON.stringify({ planId: "p1", steps: [{ id: "reconcile-entities", state: "started", backup: true }] }),
    );
    const report = await w.maint().run({ mode: "auto" });
    assert.equal(report.planId, "p1");
    assert.deepEqual(report.done, ["reconcile-entities"]);
    assert.equal(report.reconciled, 1, "redone from the restored file, not the half-written one");
  } finally {
    w.cleanup();
  }
});

test("graph history prune needs approval and backs the db up first", async () => {
  const w = setup();
  try {
    w.memoryGraph.reinforce(["a", "b"]);
    w.memoryGraph.reinforce(["a", "c"]); // maxDegree 1 closes a-b, closed at OLD
    const m = w.maint();
    const step = m.plan().steps.find((s) => s.id === "prune-graph-history");
    assert.equal(step.kind, "needs-approval");

    const auto = await m.run({ mode: "auto" });
    assert.ok(auto.proposed.some((s) => s.id === "prune-graph-history"));
    assert.equal(w.memoryGraph.getHistorySize().closed, 1, "auto mode leaves it alone");

    const done = await m.run({ mode: "approved", approve: ["prune-graph-history"] });
    assert.deepEqual(done.done, ["prune-graph-history"]);
    assert.deepEqual(w.memoryGraph.getHistorySize(), { live: 1, closed: 0, archived: 0 });
    assert.ok(fs.existsSync(path.join(w.dir, "maintenance", "backup", done.planId, "memory-graph.db")));
  } finally {
    w.cleanup();
  }
});

test("run does nothing while gaming", async () => {
  const w = setup();
  try {
    assert.deepEqual(await w.maint({ isGaming: () => true }).run({ mode: "auto" }), { skippedFor: "gaming" });
  } finally {
    w.cleanup();
  }
});
