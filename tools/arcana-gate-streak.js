#!/usr/bin/env node
// Runs the gate (tools/arcana-gate.js) over and over until it has passed N full runs in a row
// (default 5). One failure resets the count and stops, so what failed gets fixed before the next try.
// When the count reaches N it runs the `--then` command once (the 7-day soak is started that way).
//
//   node tools/arcana-gate-streak.js [--runs 5] [--then "powershell -File tools/arcana-soak-schedule.ps1 ..."]
//
// Progress: node-bot/data/arcana-gate/streak.json (read it, or tail streak.log).
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA = process.env.ARCANA_GATE_DIR || path.join(ROOT, "node-bot", "data", "arcana-gate");
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const target = Number(arg("--runs") || 5);
const then = arg("--then");
const STATE = path.join(DATA, "streak.json");
const LOG = path.join(DATA, "streak.log");

fs.mkdirSync(DATA, { recursive: true });
// Five long runs must not be cut short by the PC going to sleep: a helper holds it awake until this process ends.
spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", path.join(__dirname, "keep-awake.ps1"), "-ParentPid", String(process.pid)], { stdio: "ignore", windowsHide: true }).unref();
const note = (message) => {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
};
const save = (state) => fs.writeFileSync(STATE, JSON.stringify({ target, ...state, updated: new Date().toISOString() }, null, 2));

let passes = 0;
save({ passes, status: "running" });
note(`streak started: ${target} full passes in a row needed`);
for (let run = 1; passes < target; run += 1) {
  note(`run ${run} (passes so far ${passes}/${target})`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(__dirname, "arcana-gate.js")], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  fs.writeFileSync(path.join(DATA, `streak-run-${run}.txt`), output);
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  if (result.status === 0) {
    passes += 1;
    note(`run ${run} passed in ${minutes} min (${passes}/${target})`);
    save({ passes, status: "running", lastRun: run });
    continue;
  }
  const failures = output.split("\n").filter((l) => /^FAIL|^\s+at "/.test(l)).slice(0, 20);
  note(`run ${run} FAILED after ${minutes} min (exit ${result.status}); the streak is back to 0. Stopping.\n${failures.join("\n")}`);
  save({ passes: 0, status: "failed", lastRun: run, failures });
  process.exit(1);
}
note(`streak reached: ${target} full passes in a row`);
save({ passes, status: "passed" });
if (then) {
  note(`running: ${then}`);
  const done = spawnSync(then, { shell: true, cwd: ROOT, encoding: "utf8" });
  note(`then-command exited ${done.status}: ${`${done.stdout || ""}${done.stderr || ""}`.trim().slice(0, 600)}`);
  save({ passes, status: done.status === 0 ? "passed-and-started" : "passed-start-failed", thenExit: done.status });
  process.exit(done.status === 0 ? 0 : 2);
}
