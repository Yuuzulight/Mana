// #1121: a read-only record of every command Mana runs (coding test runs,
// hook commands, self-work test runs, MCP stdio servers), for the chat
// rail's Terminal tool. In memory only, bounded: the newest MAX_RUNS runs,
// each keeping the tail of its output.
//
// Nothing here starts a process. Stop only calls the stop path the caller
// handed in (the chat tool loop's Stop, self-work's stop).
const { AsyncLocalStorage } = require("node:async_hooks");
const { EventEmitter } = require("node:events");
const { redactText } = require("./tool-call-log");

const MAX_RUNS = 100;
const MAX_OUTPUT_CHARS = 64 * 1024;
// A line longer than this is flushed unfinished, so a program that never
// prints a newline still shows up.
const MAX_PARTIAL_CHARS = 4096;

function createTerminalFeed({ now = Date.now, maxRuns = MAX_RUNS, maxOutputChars = MAX_OUTPUT_CHARS } = {}) {
  const runs = new Map();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const context = new AsyncLocalStorage();
  let nextId = 1;

  const view = (run) => {
    const { stop, partial, ...rest } = run;
    const running = run.exitCode === undefined;
    return { ...rest, running, stoppable: running && typeof stop === "function" };
  };

  // Output is redacted a whole line at a time: a token split across two
  // chunks would slip past redactText otherwise.
  function appendLines(run, text) {
    const clean = redactText(text);
    run.output += clean;
    if (run.output.length > maxOutputChars) {
      run.droppedChars += run.output.length - maxOutputChars;
      run.output = run.output.slice(-maxOutputChars);
    }
    events.emit("event", { type: "output", id: run.id, text: clean });
  }

  function onData(run, chunk) {
    run.partial += String(chunk);
    const cut = run.partial.lastIndexOf("\n") + 1;
    if (cut > 0) {
      appendLines(run, run.partial.slice(0, cut));
      run.partial = run.partial.slice(cut);
    }
    if (run.partial.length > MAX_PARTIAL_CHARS) {
      appendLines(run, run.partial);
      run.partial = "";
    }
  }

  function end(run, exitCode) {
    if (run.exitCode !== undefined) return;
    if (run.partial) appendLines(run, run.partial);
    run.partial = "";
    run.exitCode = exitCode ?? null;
    run.durationMs = now() - run.startedAt;
    events.emit("event", { type: "end", id: run.id, exitCode: run.exitCode, durationMs: run.durationMs });
  }

  // Records a spawned child. source: "chat" | "self-work" | "hook" | "mcp".
  // stop: the existing stop path for whatever started it; when omitted, the
  // one set by runWith() for this async call chain (the chat tool loop's).
  // Pass stop: null for a command no Stop reaches.
  // child needs only its stdout/stderr streams; without an on("close") the
  // caller ends the run itself through the returned handle's end(code).
  // Returns null when there's no child at all (a test's fake spawn).
  function track(child, { source, command, cwd, stop } = {}) {
    if (!child) return null;
    const run = {
      id: String(nextId++),
      source: source || "chat",
      command: redactText(command || ""),
      cwd: cwd || process.cwd(),
      startedAt: now(),
      output: "",
      droppedChars: 0,
      exitCode: undefined,
      durationMs: null,
      partial: "",
      stop: stop !== undefined ? stop : context.getStore()?.stop,
    };
    runs.set(run.id, run);
    // Oldest finished runs go first; a running one stays until it ends.
    for (const old of runs.values()) {
      if (runs.size <= maxRuns) break;
      if (old.exitCode !== undefined) runs.delete(old.id);
    }
    events.emit("event", { type: "start", run: view(run) });
    child.stdout?.on?.("data", (chunk) => onData(run, chunk));
    child.stderr?.on?.("data", (chunk) => onData(run, chunk));
    if (typeof child.on === "function") {
      child.on("error", (e) => {
        onData(run, `${e?.message || e}\n`);
        end(run, null);
      });
      child.on("close", (code) => end(run, code));
    }
    return { id: run.id, end: (code) => end(run, code) };
  }

  function runWith(ctx, fn) {
    return context.run(ctx, fn);
  }

  // Newest first. Output stays out of the list; get(id) has it.
  function list() {
    return [...runs.values()].reverse().map((run) => {
      const { output, ...rest } = view(run);
      return rest;
    });
  }

  function get(id) {
    const run = runs.get(String(id));
    return run ? view(run) : null;
  }

  // { stopped } -- false when the run is over, unknown, or nothing can stop it.
  function stop(id) {
    const run = runs.get(String(id));
    if (!run || run.exitCode !== undefined || typeof run.stop !== "function") return { stopped: false };
    return { stopped: Boolean(run.stop()) };
  }

  function subscribe(listener) {
    events.on("event", listener);
    return () => events.off("event", listener);
  }

  // Events forwarded from the editor's coding agent (mana-acp-agent.js runs
  // in its own process): its test runs and hook commands. Nothing in this
  // process can stop those.
  const remote = new Map();
  function ingest(event = {}) {
    if (event.type === "start") {
      const r = event.run || {};
      const source = r.source === "hook" ? "hook" : "editor";
      const handle = track({}, { source, command: String(r.command || ""), cwd: String(r.cwd || ""), stop: null });
      remote.set(String(r.id), handle);
      // ponytail: a start whose end never comes (the agent died) stays
      // "running" in the list; this only bounds the id map.
      if (remote.size > maxRuns) remote.delete(remote.keys().next().value);
      return;
    }
    const handle = remote.get(String(event.id));
    const run = handle && runs.get(handle.id);
    if (!run) return;
    if (event.type === "output") onData(run, String(event.text || "").slice(-maxOutputChars));
    if (event.type === "end") {
      end(run, Number.isInteger(event.exitCode) ? event.exitCode : null);
      remote.delete(String(event.id));
    }
  }

  return { track, runWith, list, get, stop, subscribe, ingest };
}

// The one feed the backend's command runners report into.
const terminalFeed = createTerminalFeed();

module.exports = { MAX_OUTPUT_CHARS, MAX_RUNS, createTerminalFeed, terminalFeed };
