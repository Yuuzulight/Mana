// Issue #699: heartbeat.md -- parser, per-check tool gate, and the
// dry run -> approval -> quiet/report cycle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseHeartbeat, listItems, replaceItems, createCheckToolGate, createHeartbeat } = require("../heartbeat");
const { createApprovalGate } = require("../../../node-bot/approval-gate");

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function fakePolicy() {
  const calls = [];
  return {
    calls,
    tools: [],
    isKnownTool: () => true,
    executeTool: async (name) => {
      calls.push(name);
      return "done";
    },
  };
}

test("parses permissions, interval, urgency and scope; skips non-check lines", () => {
  const { checks, errors } = parseHeartbeat(
    [
      "# My checks",
      "",
      "Some notes about them.",
      "- [read, network] every 30m: check github.com notifications for review requests",
      "- [read, write] daily 09:00: append yesterday's summary to D:\\Notes\\journal.md.",
      "- warn me if D: drops below 50 GB",
      '* [write, urgent] every 2h: tidy "D:\\My Notes\\inbox" and https://example.org/feed',
    ].join("\r\n"),
  );
  assert.deepEqual(errors, []);
  assert.equal(checks.length, 4);
  const [github, journal, disk, tidy] = checks;
  assert.deepEqual(github.permissions, ["network", "read"]);
  assert.deepEqual(github.schedule, { type: "interval", everyMs: 30 * 60 * 1000 });
  assert.deepEqual(github.scope, { paths: [], hosts: ["github.com"] });
  assert.equal(github.text, "check github.com notifications for review requests");
  assert.deepEqual(journal.schedule, { type: "daily", hour: 9, minute: 0 });
  assert.deepEqual(journal.scope, { paths: ["D:\\Notes\\journal.md"], hosts: [] });
  assert.deepEqual(disk.permissions, ["read"]);
  assert.deepEqual(disk.schedule, { type: "interval", everyMs: 30 * 60 * 1000 });
  assert.deepEqual(disk.scope, { paths: [], hosts: [] });
  assert.equal(disk.urgent, false);
  assert.equal(tidy.urgent, true);
  assert.deepEqual(tidy.permissions, ["read", "write"]);
  assert.deepEqual(tidy.schedule, { type: "interval", everyMs: 2 * 60 * 60 * 1000 });
  assert.deepEqual(tidy.scope, { paths: ["D:\\My Notes\\inbox"], hosts: ["example.org"] });
});

test("malformed lines are reported by line number and never run", () => {
  const { checks, errors } = parseHeartbeat(
    [
      "- [read, install] every 1h: update my tools",
      "- [read, destructive]: clean up old logs",
      "- [reed] check x",
      "- every 1m: check x",
      "- daily 25:00: check x",
      "- every morning: check x",
      "- [read] every 30m:",
      "- [read] every time D: fills up, tell me",
    ].join("\n"),
  );
  assert.deepEqual(
    errors.map((e) => [e.line, e.error]),
    [
      [1, '"install" can never be granted to a check'],
      [2, '"destructive" can never be granted to a check'],
      [3, 'unknown permission "reed" (use read, write, network, urgent)'],
      [4, "the shortest interval is every 5m"],
      [5, '"daily 25:00" isn\'t a time of day'],
      [6, 'schedule should look like "every 30m:", "every 2h:" or "daily 09:00:"'],
      [7, "the check has no text"],
    ],
  );
  assert.deepEqual(checks.map((c) => c.text), ["every time D: fills up, tell me"]);
});

test("a check's identity is its permissions and text, not its interval or urgency", () => {
  const id = (line) => parseHeartbeat(line).checks[0].id;
  const base = id("- [read, write] every 30m: append to D:\\Notes\\a.md");
  assert.equal(id("- [write, urgent] daily 08:00: append to D:\\Notes\\a.md"), base);
  assert.notEqual(id("- [read, write] every 30m: append to D:\\Notes\\b.md"), base);
  assert.notEqual(id("- [read, write, network] every 30m: append to D:\\Notes\\a.md"), base);
});

test("tool gate: read-only checks can't write; writes stay in scope and are snapshotted", async () => {
  const gate = createApprovalGate({ dataDir: tempDir("mana-hb-gate-") });
  const [readOnly] = parseHeartbeat("- tell me what's in Q:\\Notes\\journal.md").checks;
  const [writer] = parseHeartbeat("- [write] append to Q:\\Notes\\journal.md").checks;
  const recorded = [];
  const snapshotStore = { recordSnapshot: (s) => (recorded.push(s), { id: `snap-${recorded.length}` }) };
  const fsDeps = {
    statSync: (p) => {
      if (p !== "Q:\\Notes\\journal.md") throw new Error("ENOENT");
      return { isFile: () => true, size: 5 };
    },
    readFileSync: () => "before",
  };
  const run = (check) => {
    const policy = fakePolicy();
    const writes = [];
    const opts = { dryRun: false, snapshotStore, writes, wouldRun: [], fsDeps };
    return { policy, writes, tools: createCheckToolGate(check, opts)(policy, gate) };
  };

  const ro = run(readOnly);
  assert.equal(await ro.tools.executeTool("read_file", { path: "Q:\\Notes\\journal.md" }), "done");
  assert.match(
    await ro.tools.executeTool("fs__write_file", { path: "Q:\\Notes\\journal.md", content: "x" }),
    /no write permission/,
  );
  assert.deepEqual(ro.policy.calls, ["read_file"]);

  const w = run(writer);
  assert.equal(await w.tools.executeTool("fs__write_file", { path: "Q:\\Notes\\journal.md", content: "x" }), "done");
  for (const target of ["Q:\\Notes\\other.md", "Q:\\Notes\\journal.md\\..\\..\\evil.md", "journal.md"]) {
    assert.match(await w.tools.executeTool("fs__write_file", { path: target, content: "x" }), /Not allowed/);
  }
  // shell writes need an in-scope working folder
  assert.match(await w.tools.executeTool("run_command", { command: "echo hi > out.txt" }), /Not allowed/);
  assert.deepEqual(w.policy.calls, ["fs__write_file"]);
  assert.deepEqual(recorded.map((s) => [s.kind, s.scope, s.key, s.payload]), [["file", "Q:\\Notes", "journal.md", "before"]]);
  assert.deepEqual(w.writes, [
    { check: writer.text, call: "fs__write_file", targets: ["Q:\\Notes\\journal.md"], snapshots: ["snap-1"] },
  ]);

  // A check can't approve itself by writing the heartbeat's own files.
  const [wide] = parseHeartbeat("- [write] tidy Q:\\").checks;
  const policy = fakePolicy();
  const opts = { dryRun: false, writes: [], wouldRun: [], protectedDir: "Q:\\mana\\data", fsDeps };
  const tools = createCheckToolGate(wide, opts)(policy, gate);
  assert.match(await tools.executeTool("fs__write_file", { path: "Q:\\mana\\data\\heartbeat-state.json" }), /off limits/);
  assert.equal(await tools.executeTool("fs__write_file", { path: "Q:\\other.txt" }), "done");
});

test("tool gate: network only to named sites; install/destructive always held; dry runs only read", async () => {
  const gate = createApprovalGate({ dataDir: tempDir("mana-hb-gate-") });
  const [check] = parseHeartbeat("- [read, write, network] check github.com and log to Q:\\Notes").checks;
  const policy = fakePolicy();
  const tools = createCheckToolGate(check, { dryRun: false, writes: [], wouldRun: [] })(policy, gate);

  assert.equal(await tools.executeTool("browser_automation__navigate", { url: "https://api.github.com/notifications" }), "done");
  assert.match(await tools.executeTool("browser_automation__navigate", { url: "https://evil.example/" }), /evil\.example isn't a site/);
  for (const command of ["npm install left-pad", "Remove-Item -Recurse Q:\\Notes\\old"]) {
    const outcome = JSON.parse(await tools.executeTool("run_command", { command, cwd: "Q:\\Notes" }));
    assert.equal(outcome.status, "pending");
  }
  assert.deepEqual(policy.calls, ["browser_automation__navigate"]);
  assert.ok(gate.listPending().every((p) => p.forceReview), "held calls can never be granted");

  const dryPolicy = fakePolicy();
  const wouldRun = [];
  const dry = createCheckToolGate(check, { dryRun: true, writes: [], wouldRun })(dryPolicy, gate);
  await dry.executeTool("read_file", { path: "Q:\\Notes\\a.md" });
  assert.match(await dry.executeTool("fs__write_file", { path: "Q:\\Notes\\a.md" }), /Dry run/);
  assert.deepEqual(dryPolicy.calls, ["read_file"]);
  assert.deepEqual(wouldRun, ["fs__write_file [write]"]);

  // Q31: a dry run may fetch from the sites the check's own line names,
  // with Mana's built-in fetch only -- never an MCP/add-on tool, whatever
  // its name says.
  await dry.executeTool("browser_automation__navigate", { url: "https://github.com/notifications" });
  for (const [name, args] of [
    ["mcp__github__get_x", { url: "https://github.com/notifications" }], // MCP, even named get_
    ["mcp__fetch__fetch", { url: "https://api.github.com/notifications" }], // MCP fetch too
    ["browser_automation__navigate", { url: "https://evil.example/" }], // not a named site
    ["browser_automation__click", { url: "https://github.com/", selector: "#merge" }], // acts on the page
    ["mcp__github__create_issue", { repo: "https://github.com/a/b", title: "x" }], // not a read
    ["run_command", { command: "curl -X POST https://github.com/x" }], // shell
  ]) {
    assert.match(await dry.executeTool(name, args), /Dry run/, name);
  }
  assert.deepEqual(dryPolicy.calls, ["read_file", "browser_automation__navigate"]);
  // ...and only when the check has the network permission.
  const [readOnly] = parseHeartbeat("- check github.com").checks;
  const noNet = fakePolicy();
  const dryNoNet = createCheckToolGate(readOnly, { dryRun: true, writes: [], wouldRun: [] })(noNet, gate);
  assert.match(await dryNoNet.executeTool("browser_automation__navigate", { url: "https://github.com/" }), /Dry run/);
  assert.deepEqual(noNet.calls, []);
});

// Q27: a heartbeat check is a scheduled reply, so it only sees confirmed
// facts (buildAssistantReply's replyMeta.scheduled, #780).
test("heartbeat checks run as scheduled replies", async () => {
  const cronPlugin = require("../index");
  cronPlugin._resetForTests();
  const metas = [];
  const hb = cronPlugin._getHeartbeatForTests({
    dataDir: tempDir("mana-hb-plugin-"),
    buildAssistantReply: async (...args) => {
      metas.push(args[7]);
      return "NOTHING_TO_REPORT";
    },
  });
  fs.writeFileSync(hb.filePath, "- check D: free space\n");
  await hb.runDue();
  cronPlugin._resetForTests();
  assert.equal(metas.length, 1);
  assert.equal(metas[0].scheduled, true);
  assert.equal(typeof metas[0].wrapToolPolicy, "function");
});

test("dry run -> approval -> quiet runs stay silent; writes are listed in the next report; edits reset", async () => {
  const dataDir = tempDir("mana-hb-");
  const gate = createApprovalGate({ dataDir: tempDir("mana-hb-approvals-") });
  let clock = Date.UTC(2026, 8, 29, 12, 0, 0);
  let gaming = false;
  const replies = [];
  const notified = [];
  const policy = fakePolicy();
  const hb = createHeartbeat({
    dataDir,
    now: () => clock,
    isGaming: () => gaming,
    approvalGate: gate,
    notify: (p) => notified.push(p),
    runCheck: async (prompt, wrap, sessionId) => {
      assert.match(prompt, /NOTHING_TO_REPORT/);
      assert.match(sessionId, /^heartbeat-[0-9a-f]{16}$/);
      await wrap(policy, gate).executeTool("fs__write_file", { path: "Q:\\Notes\\journal.md", content: "x" });
      return replies.shift();
    },
  });
  gate.registerExecutor("heartbeat-check", ({ id }) => hb.approve(id));
  fs.writeFileSync(hb.filePath, "- [write] every 30m: append a line to Q:\\Notes\\journal.md\n");

  // New check: dry run, nothing written, waits for approval.
  replies.push("I'd append today's line.");
  await hb.runDue();
  assert.deepEqual(policy.calls, []);
  assert.deepEqual(notified, []);
  const [pending] = gate.listPending();
  assert.match(pending.summary, /Dry run would say: I'd append today's line\./);
  assert.match(pending.summary, /Would also run: fs__write_file \[write\]/);
  // #1124: the Background tasks panel sees it waiting.
  assert.deepEqual(
    hb.listChecks().map(({ text, approved, awaitingApproval }) => ({ text, approved, awaitingApproval })),
    [{ text: "append a line to Q:\\Notes\\journal.md", approved: false, awaitingApproval: true }],
  );
  clock += 60 * 60 * 1000;
  await hb.runDue(); // still waiting: no second dry run
  assert.equal(gate.listPending().length, 1);

  await gate.decide(pending.id, "allow-once");
  assert.equal(hb.listChecks()[0].awaitingApproval, false);
  assert.equal(hb.listChecks()[0].nextRunAt, clock + 30 * 60 * 1000);
  clock += 31 * 60 * 1000;
  gaming = true;
  replies.push("NOTHING_TO_REPORT");
  await hb.runDue();
  assert.deepEqual(policy.calls, [], "checks pause while gaming");

  gaming = false;
  await hb.runDue();
  assert.deepEqual(policy.calls, ["fs__write_file"]);
  assert.deepEqual(notified, [], "nothing actionable says nothing");

  clock += 31 * 60 * 1000;
  replies.push("Two review requests are waiting.");
  await hb.runDue();
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "cron");
  assert.match(notified[0].text, /^Two review requests are waiting\.\n\nChanges I made:\n- fs__write_file -> Q:\\Notes\\journal\.md\n- fs__write_file/);
  assert.deepEqual(hb.getState().unreportedWrites, []);

  // Editing the text makes it a new, unapproved check: dry run again.
  const oldId = pending.payload.id;
  fs.writeFileSync(hb.filePath, "- [write] every 30m: append two lines to Q:\\Notes\\journal.md\n");
  clock += 31 * 60 * 1000;
  replies.push("NOTHING_TO_REPORT");
  await hb.runDue();
  assert.equal(policy.calls.length, 2, "the edited check's write was only a dry run");
  assert.equal(gate.listPending().length, 1);
  assert.match(gate.listPending()[0].summary, /it would stay quiet/);
  assert.equal(hb.approve(oldId).ok, false);

  // The approval queue doesn't survive a restart, so a check still waiting
  // for approval dry-runs and asks again when it's next due.
  clock += 31 * 60 * 1000;
  const restarted = createHeartbeat({ dataDir, now: () => clock, runCheck: async () => "NOTHING_TO_REPORT", approvalGate: gate });
  await restarted.runDue();
  assert.equal(gate.listPending().length, 2);
});

// #699: a report is a proactive candidate, so budgets, gaming mode and
// quiet hours apply; "urgent" rides along.
test("heartbeat reports go through the proactive pipeline", async () => {
  const cronPlugin = require("../index");
  const proactive = require("../../../node-bot/proactive");
  cronPlugin._resetForTests();
  const dataDir = tempDir("mana-hb-proactive-");
  const md = "- warn me if D: is low\n";
  const [check] = parseHeartbeat(md).checks;
  fs.writeFileSync(path.join(dataDir, "heartbeat.md"), md);
  fs.writeFileSync(path.join(dataDir, "heartbeat-state.json"), JSON.stringify({ checks: { [check.id]: { approved: true, nextRunAt: 0 } } }));
  const realOffer = proactive.offer;
  const offered = [];
  proactive.offer = (candidate) => (offered.push(candidate), "held");
  try {
    const hb = cronPlugin._getHeartbeatForTests({ dataDir, buildAssistantReply: async () => "D: has 12 GB left." });
    await hb.runDue();
  } finally {
    proactive.offer = realOffer;
    cronPlugin._resetForTests();
  }
  assert.equal(offered.length, 1);
  assert.equal(offered[0].reason, "heartbeat");
  assert.equal(offered[0].payload.text, "D: has 12 GB left.");
});

test("Settings editor: items round-trip, keep ids and notes, switched-off checks don't run", () => {
  const md = "# Checks\n- [network, read] every 2h: check github.com notifications\nnote: keep me\n- daily 09:00: summarize the day\n- every 1m: too often\n";
  const items = listItems(md);
  assert.deepEqual(
    items.map(({ id, ...rest }) => rest),
    [
      { text: "check github.com notifications", schedule: "every 2h", permissions: ["network"], urgent: false, enabled: true },
      { text: "summarize the day", schedule: "daily 09:00", permissions: [], urgent: false, enabled: true },
    ],
  );
  // Unchanged items keep their ids (and so their approval).
  assert.deepEqual(listItems(replaceItems(md, items)).map((i) => i.id), items.map((i) => i.id));

  const next = replaceItems(md, [{ ...items[1], enabled: false, urgent: true }, { text: "new one", permissions: ["write"], schedule: "every 45m" }]);
  assert.equal(next, "# Checks\n- ~~[urgent] daily 09:00: summarize the day~~\nnote: keep me\n- [write] every 45m: new one\n- every 1m: too often\n");
  assert.deepEqual(parseHeartbeat(next).checks.map((c) => c.text), ["new one"]);
  assert.equal(listItems(next)[0].enabled, false);
  assert.equal(listItems(next)[0].id, items[1].id);

  for (const [item, error] of [
    [{ text: "" }, /no text/],
    [{ text: "a\nb" }, /one line/],
    [{ text: "x", permissions: ["install"] }, /isn't a permission/],
    [{ text: "x", schedule: "every 1m" }, /shortest interval/],
    [{ text: "x", schedule: "hourly" }, /schedule should look like/],
    [{ text: "[write] sneaky" }, /can't start with/],
  ]) {
    assert.throws(() => replaceItems(md, [item]), error);
  }
  assert.throws(() => replaceItems(md, "nope"), /must be a list/);
});

test("GET/PUT /heartbeat/items edits heartbeat.md and refuses bad items", async () => {
  const express = require("../../../node-bot/node_modules/express");
  const { withServer } = require("./helpers");
  const cronPlugin = require("../index");
  cronPlugin._resetForTests();
  const dataDir = tempDir("mana-hb-routes-");
  const app = express();
  app.use(express.json());
  cronPlugin.registerRoutes(app, { dataDir });
  try {
    await withServer(app, async (baseUrl) => {
      const put = (items) =>
        fetch(`${baseUrl}/heartbeat/items`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
      assert.deepEqual(await (await fetch(`${baseUrl}/heartbeat/items`)).json(), { items: [] });
      const ok = await put([{ text: "warn me if D: drops below 50 GB", schedule: "every 30m" }]);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).items[0].text, "warn me if D: drops below 50 GB");
      assert.equal(fs.readFileSync(path.join(dataDir, "heartbeat.md"), "utf8"), "- every 30m: warn me if D: drops below 50 GB\n");
      const bad = await put([{ text: "x", permissions: ["destructive"] }]);
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /check 1/);
      assert.equal(fs.readFileSync(path.join(dataDir, "heartbeat.md"), "utf8"), "- every 30m: warn me if D: drops below 50 GB\n");
    });
  } finally {
    cronPlugin._resetForTests();
  }
});
