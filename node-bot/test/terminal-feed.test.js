const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const express = require("express");
const test = require("node:test");

const { createTerminalFeed, terminalFeed } = require("../terminal-feed");
const { terminalCapability } = require("../capabilities/terminal-capability");
const { runTestCommand } = require("../ai/coding-tool-source");
const { runPostCommandHook } = require("../hooks-store");
const { withServer } = require("./helpers");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("a run records its command, output, exit code and duration", () => {
  let t = 1000;
  const feed = createTerminalFeed({ now: () => t });
  const child = fakeChild();
  const events = [];
  feed.subscribe((e) => events.push(e.type));
  const { id } = feed.track(child, { source: "hook", command: "npm test", cwd: "D:\\repo" });
  assert.equal(feed.get(id).running, true);
  child.stdout.emit("data", "ok 1\n");
  child.stderr.emit("data", "warn\n");
  t = 1250;
  child.emit("close", 1);
  const run = feed.get(id);
  assert.deepEqual(
    [run.source, run.command, run.cwd, run.output, run.exitCode, run.durationMs, run.running],
    ["hook", "npm test", "D:\\repo", "ok 1\nwarn\n", 1, 250, false],
  );
  assert.deepEqual(events, ["start", "output", "output", "end"]);
  assert.equal(feed.list()[0].output, undefined);
});

test("secrets are redacted in the command and in output split across chunks", () => {
  const feed = createTerminalFeed();
  const child = fakeChild();
  const { id } = feed.track(child, { command: "curl -H Authorization: Bearer abcdefghijklmnop1234" });
  child.stdout.emit("data", "token sk-abcdefgh");
  child.stdout.emit("data", "ijklmnop1234 done\n");
  child.emit("close", 0);
  const run = feed.get(id);
  assert.doesNotMatch(run.command + run.output, /abcdefgh/);
  assert.match(run.output, /\[redacted\] done/);
});

test("output keeps its tail and old finished runs drop off", () => {
  const feed = createTerminalFeed({ maxRuns: 2, maxOutputChars: 10 });
  const running = fakeChild();
  const first = feed.track(running, {});
  const second = fakeChild();
  const { id } = feed.track(second, {});
  second.stdout.emit("data", "0123456789abcdef\n");
  second.emit("close", 0);
  assert.equal(feed.get(id).output, "789abcdef\n");
  assert.equal(feed.get(id).droppedChars, 7);
  feed.track(fakeChild(), {});
  // The finished one went, the still-running first one stayed.
  assert.equal(feed.get(id), null);
  assert.ok(feed.get(first.id));
});

test("Stop calls only the run's own stop path", () => {
  const feed = createTerminalFeed();
  const stops = [];
  const loop = feed.runWith({ stop: () => (stops.push("chat"), true) }, () => feed.track(fakeChild(), {}));
  const hook = feed.runWith({ stop: () => (stops.push("chat"), true) }, () => feed.track(fakeChild(), { stop: null }));
  const selfWork = fakeChild();
  const sw = feed.track(selfWork, { source: "self-work", stop: () => (stops.push("self-work"), true) });
  assert.deepEqual(feed.stop(loop.id), { stopped: true });
  assert.deepEqual(feed.stop(hook.id), { stopped: false });
  assert.equal(feed.get(hook.id).stoppable, false);
  selfWork.emit("close", 0);
  assert.deepEqual(feed.stop(sw.id), { stopped: false });
  assert.deepEqual(feed.stop("nope"), { stopped: false });
  assert.deepEqual(stops, ["chat"]);
});

test("Stop kills the command itself, stops the loop that ran it, and marks the run stopped", async () => {
  const child = fakeChild();
  const killed = [];
  const stops = [];
  let done;
  terminalFeed.runWith({ stop: () => (stops.push("chat"), true) }, () => {
    done = runTestCommand("npm run slow", "D:\\stop", { spawnImpl: () => child, killTree: (c) => killed.push(c) });
  });
  const run = terminalFeed.list().find((r) => r.cwd === "D:\\stop");
  assert.equal(run.stoppable, true);
  assert.deepEqual(terminalFeed.stop(run.id), { stopped: true });
  // Its own child only, and the tool loop's Stop as before.
  assert.deepEqual(killed, [child]);
  assert.deepEqual(stops, ["chat"]);
  child.emit("close", null);
  await done;
  const ended = terminalFeed.get(run.id);
  assert.deepEqual([ended.stopped, ended.running, ended.exitCode], [true, false, null]);
  assert.deepEqual(terminalFeed.stop(run.id), { stopped: false });
});

test("a coding test run shows in the shared feed with its source", async () => {
  const child = fakeChild();
  const done = runTestCommand("npm test", "D:\\ws", {
    spawnImpl: () => child,
    terminal: { source: "self-work", stop: null },
  });
  child.stdout.emit("data", "pass\n");
  child.emit("close", 0);
  await done;
  const run = terminalFeed.list().find((r) => r.command === "npm test" && r.cwd === "D:\\ws");
  assert.equal(run.source, "self-work");
  assert.equal(run.exitCode, 0);
});

test("routes need the admin key; list, get, stop and stream", async () => {
  const feed = createTerminalFeed();
  const app = express();
  app.use(express.json());
  terminalCapability.registerRoutes(app, {
    terminalFeed: feed,
    checkAdminAuth: (req, res) => req.headers["x-admin-token"] === "k" || (res.status(401).json({}), false),
  });
  const child = fakeChild();
  const { id } = feed.track(child, { command: "dotnet test", stop: () => true });
  const auth = { headers: { "x-admin-token": "k" } };
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/terminal/runs`)).status, 401);
    assert.equal((await fetch(`${base}/terminal/runs/${id}/stop`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/terminal/stream`)).status, 401);
    const { runs } = await (await fetch(`${base}/terminal/runs`, auth)).json();
    assert.deepEqual(runs.map((r) => [r.command, r.stoppable]), [["dotnet test", true]]);

    const stream = await fetch(`${base}/terminal/stream`, auth);
    const reader = stream.body.getReader();
    child.stdout.emit("data", "line\n");
    const { value } = await reader.read();
    assert.deepEqual(JSON.parse(new TextDecoder().decode(value)), { type: "output", id, text: "line\n" });
    await reader.cancel();

    const stopped = await (await fetch(`${base}/terminal/runs/${id}/stop`, { method: "POST", ...auth })).json();
    assert.deepEqual(stopped, { stopped: true });
    assert.equal((await fetch(`${base}/terminal/runs/999`, auth)).status, 404);
    assert.equal((await (await fetch(`${base}/terminal/runs/${id}`, auth)).json()).output, "line\n");

    // The editor agent's batch: recorded, never started, not stoppable here.
    const batch = [
      { type: "start", run: { id: "1", source: "editor", command: "npm test", cwd: "D:\\ws" } },
      { type: "end", id: "1", exitCode: 0 },
    ];
    const post = (body, headers) =>
      fetch(`${base}/terminal/events`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ events: batch }, {})).status, 401);
    assert.equal((await post({ events: batch }, auth.headers)).status, 200);
    const [editor] = (await (await fetch(`${base}/terminal/runs`, auth)).json()).runs;
    assert.deepEqual([editor.source, editor.command, editor.exitCode, editor.stoppable], ["editor", "npm test", 0, false]);
  });
});

test("events from the editor's agent process become runs nothing here can stop", () => {
  const agent = createTerminalFeed();
  const feed = createTerminalFeed();
  agent.subscribe((event) => feed.ingest(JSON.parse(JSON.stringify(event))));
  const child = fakeChild();
  agent.track(child, { source: "editor", command: "npm test", cwd: "D:\ws", stop: () => true });
  child.stdout.emit("data", "ok\n");
  child.emit("close", 0);
  feed.ingest({ type: "output", id: "unknown", text: "ignored\n" });
  const [run] = feed.list();
  assert.deepEqual([run.source, run.command, run.cwd, run.exitCode, run.stoppable], ["editor", "npm test", "D:\ws", 0, false]);
  assert.equal(feed.get(run.id).output, "ok\n");
});

test("a hook command shows as a hook run no Stop reaches, even inside a chat tool call", () => {
  const child = fakeChild();
  terminalFeed.runWith({ stop: () => true }, () =>
    runPostCommandHook({ action: "run-command", command: "eslint", args: ["{path}"] }, { path: "a.js" }, () => child, {
      cwd: "D:\\hooks",
    }),
  );
  const run = terminalFeed.list().find((r) => r.cwd === "D:\\hooks");
  assert.deepEqual([run.source, run.command, run.stoppable], ["hook", "eslint a.js", false]);
  child.emit("close", 0);
});
