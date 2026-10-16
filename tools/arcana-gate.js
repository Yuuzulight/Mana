#!/usr/bin/env node
// The gate before Arcana's 7-day soak. Every job in tools/arcana-gate-jobs.js runs through Mana's real
// browser plugin (the code her tools call), each with a fresh browser, and all of them have to pass in
// the same run. A pass is "did the job and the page shows it". A bot wall or a gap counts as a fail,
// because a gate that excuses failures proves nothing; the only jobs kept out of the count are the
// "tracked" ones (a site that stops Edge too, or a gap already filed), and those are printed anyway.
//
//   node tools/arcana-gate.js                run everything
//   ARCANA_GATE_ONLY=wikipedia node ...      run the jobs whose site or job contains the text
//
// Results: node-bot/data/arcana-gate/gate.jsonl (a line per job), gate-report.md, events.jsonl.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JOBS, downloads, UPLOAD } = require("./arcana-gate-jobs");

const ROOT = path.resolve(__dirname, "..");
const DATA = process.env.ARCANA_GATE_DIR || path.join(ROOT, "node-bot", "data", "arcana-gate");
const EVENTS = path.join(DATA, "events.jsonl");
const RESULTS = path.join(DATA, "gate.jsonl");

// Every action Mana's browser has. A job names the ones it exercises in `covers`.
const ACTIONS = ["navigate", "snapshot", "click", "type", "select", "scroll", "hover", "press", "drag", "upload", "download", "find", "back", "screenshot", "devtools", "testPage", "lookAndClick", "tab", "sensitive"];

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s: ${what}`)), ms))]);
const BLOCKED = /Just a moment|Attention Required|Access Denied|unusual traffic|verify you are not a bot|Performing security verification/i;
const readLines = (file) => {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const used = 100 - (100 * os.freemem()) / os.totalmem();
  if (used >= Number(process.env.ARCANA_GATE_MAX_RAM || 85)) { console.log(`not run: RAM ${used.toFixed(0)}% is too high`); process.exit(2); }
  const plugin = require(path.join(ROOT, "plugins", "browser-automation", "index.js"));
  const deps = {
    env: { ...process.env, MANA_BROWSER_PROFILE_DIR: path.join(DATA, "profile"), MANA_ARCANA_EVENTS_FILE: EVENTS },
    ramPercent: () => 50,
    isGaming: () => false,
    // A download only needs to start; this drops the file the way the HTTP routes do.
    onDownload: async (download) => { downloads.push(download.suggestedFilename()); await download.cancel().catch(() => {}); },
  };
  const only = (process.env.ARCANA_GATE_ONLY || "").toLowerCase();
  const at = new Date().toISOString();
  const results = [];
  for (const [site, job, covers, steps, options = {}] of JOBS) {
    if (only && !`${site} ${job}`.toLowerCase().includes(only)) continue;
    plugin._resetForTests();
    downloads.length = 0;
    if (covers.includes("upload")) plugin.offerFiles([UPLOAD]);
    const record = { at, site, job, covers, pass: false, steps: 0, ...(options.tracked ? { tracked: options.tracked } : {}) };
    const started = Date.now();
    const eventsBefore = readLines(EVENTS).length;
    try {
      const browser = await withTimeout(plugin.getSession(deps), 40000, "start the browser");
      const fresh = readLines(EVENTS).slice(eventsBefore);
      if (fresh.some((e) => e.type === "arcana_start_failed")) throw new Error(`Arcana did not start (fell back to Edge): ${fresh.find((e) => e.type === "arcana_start_failed").reason}`);
      let state = null;
      for (const [name, act, check, step] of steps) {
        record.step = name;
        const res = await withTimeout(Promise.resolve(act(browser, state)), 45000, name);
        state = await withTimeout(browser.snapshot(), 25000, "snapshot");
        if (BLOCKED.test(`${state.title}\n${state.text || ""}`)) throw new Error(`bot wall: ${state.title}`);
        // A page that changes after an action (a spinner, a script) gets up to 12 s to show it.
        let ok = await check(state, res);
        for (let i = 0; !ok && step?.wait && i < 6; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          state = await withTimeout(browser.snapshot(), 25000, "snapshot");
          ok = await check(state, res);
        }
        if (!ok) throw new Error(`the page does not show it worked (${state.url} "${state.title}", ${state.elements.length} elements)`);
        record.steps += 1;
      }
      record.pass = true;
      delete record.step;
    } catch (error) {
      record.error = String(error.message).split("\n")[0].slice(0, 220);
    } finally {
      await plugin.closeSession().catch(() => {});
    }
    record.ms = Date.now() - started;
    fs.appendFileSync(RESULTS, JSON.stringify(record) + "\n");
    results.push(record);
    const label = record.pass ? "PASS" : record.tracked ? "TRACKED" : "FAIL";
    console.log(`${label.padEnd(7)} ${site} - ${job}  (${(record.ms / 1000).toFixed(1)}s)${record.pass ? "" : `\n        at "${record.step}": ${record.error}`}`);
  }

  const counted = results.filter((r) => !r.tracked);
  const passed = counted.filter((r) => r.pass).length;
  const sites = new Set(counted.map((r) => r.site.replace(/ \(.*\)$/, "")));
  const covered = new Set(counted.filter((r) => r.pass).flatMap((r) => r.covers.split(" ")));
  const uncovered = ACTIONS.filter((a) => !covered.has(a));
  const full = !only && passed === counted.length && uncovered.length === 0;
  const verdict = only
    ? `${passed} of ${counted.length} passed (partial run, not a gate result)`
    : full
      ? `GATE PASSED: ${passed} of ${counted.length} jobs on ${sites.size} sites, every browser action covered. The 7-day soak may start.`
      : `GATE CLOSED: ${passed} of ${counted.length} jobs passed${uncovered.length ? `; no passing job yet for: ${uncovered.join(", ")}` : ""}.`;
  console.log(`\n${verdict}`);
  const tracked = results.filter((r) => r.tracked);
  if (tracked.length) console.log(`Tracked, not counted: ${tracked.map((r) => `${r.site} ${r.pass ? "passes" : "fails"} (${r.tracked})`).join("; ")}`);

  const rows = results.map((r) => `| ${r.pass ? "pass" : r.tracked ? "tracked" : "FAIL"} | ${r.site} | ${r.job} | ${(r.ms / 1000).toFixed(1)} | ${r.pass ? "" : `${r.step}: ${r.error}`} |`);
  fs.writeFileSync(path.join(DATA, "gate-report.md"), [`# Arcana gate - ${at}`, "", verdict, "", `Actions with a passing job: ${[...covered].sort().join(", ")}`, "", "| Result | Site | Job | Seconds | Where it stopped |", "|---|---|---|---|---|", ...rows, ""].join("\n"));
  process.exit(full || only ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(3); });
