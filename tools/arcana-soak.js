#!/usr/bin/env node
// Drives Mana's browser plugin on Arcana across common sites and keeps score, so
// a week of use does not depend on anyone browsing by hand (Arcana's M2 exit: a
// week with no unexplained fallback to Edge).
//
//   node tools/arcana-soak.js                run every site once (what the schedule runs)
//   node tools/arcana-soak.js --report       print and write the last seven days' summary
//
// Data is kept under node-bot/data/arcana-soak: runs.jsonl (one line per site and
// run), events.jsonl (the engine log the plugin writes), report.md, and the
// browser's own profile. A site that fails the way a known Arcana issue says it
// does is "known"; a bot wall is "blocked"; anything else is "unexplained".
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA = process.env.ARCANA_SOAK_DIR || path.join(ROOT, "node-bot", "data", "arcana-soak");
const RUNS = path.join(DATA, "runs.jsonl");
const EVENTS = path.join(DATA, "events.jsonl");
const LOCK = path.join(DATA, "running.lock");
const MAX_RAM_PERCENT = Number(process.env.ARCANA_SOAK_MAX_RAM || 85);
// Programs that mean the machine is busy with something the user cares about more.
const BUSY = (process.env.ARCANA_SOAK_SKIP_PROCESSES || "ffxiv_dx11.exe,League of Legends.exe,VALORANT-Win64-Shipping.exe,eldenring.exe,Cyberpunk2077.exe,GTA5.exe")
  .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);

const refOf = (line) => (line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : null);
const find = (re) => (state) => state.elements.find((line) => re.test(line));
// A story whose thread is a normal size: the one on top can have two thousand comments, which any engine reads slowly.
const smallThread = (state) => state.elements.find((line) => {
  const count = /link "(\d+)\s*comments?"/.exec(line);
  return count && Number(count[1]) >= 3 && Number(count[1]) <= 150;
}) || find(/link "\d+\s*comments?"/)(state);
const links = (state) => state.elements.filter((line) => /^link/.test(line)).length;

// What each site is asked to do: [step, act(browser, state), check(state)].
const SITES = [
  { site: "example.com", steps: [
    ["open", (b) => b.navigate("https://example.com/"), (s) => /Example Domain/.test(s.title)],
    ["follow the link", (b, s) => b.click(refOf(find(/link/)(s))), (s) => /iana\.org/.test(s.url)],
  ] },
  { site: "Hacker News", steps: [
    ["open the front page", (b) => b.navigate("https://news.ycombinator.com/"), (s) => /Hacker News/.test(s.title) && s.elements.length > 40],
    ["open a comments page", (b, s) => b.click(refOf(smallThread(s))), (s) => /item\?id=/.test(s.url)],
  ] },
  { site: "Wikipedia", steps: [
    ["open the main page", (b) => b.navigate("https://en.wikipedia.org/wiki/Main_Page"), (s) => /Wikipedia/.test(s.title)],
    ["search for an article", (b, s) => b.type(refOf(s.elements.find((l) => /^(searchbox|textbox|combobox)/.test(l) && /search/i.test(l))), "Alan Turing", true), (s) => /Turing/.test(s.title)],
    ["follow an article link", (b, s) => b.click(refOf(find(/link "Turing machine"/i)(s))), (s) => /Turing_machine/.test(s.url)],
  ] },
  { site: "GitHub", steps: [
    ["open a repository", (b) => b.navigate("https://github.com/nodejs/node"), (s) => /nodejs\/node/.test(s.title)],
    ["open its Issues tab", (b, s) => b.click(refOf(find(/link "Issues/)(s))), (s) => /\/issues/.test(s.url)],
  ] },
  { site: "MDN", steps: [
    ["open the JavaScript docs", (b) => b.navigate("https://developer.mozilla.org/en-US/docs/Web/JavaScript"), (s) => /JavaScript/.test(s.title)],
    ["follow a link", (b, s) => b.click(refOf(find(/link "(Array|Promise|Reference)/)(s))), (s) => /developer\.mozilla\.org/.test(s.url) && s.url !== "https://developer.mozilla.org/en-US/docs/Web/JavaScript"],
  ] },
  { site: "BBC News", steps: [
    ["open the news page", (b) => b.navigate("https://www.bbc.com/news"), (s) => /BBC/.test(s.title) && s.elements.length > 30],
    ["open a story", (b, s) => b.click(refOf(s.elements.find((l) => /^link ".{25,}"/.test(l) && !/Skip/.test(l)))), (s) => /\/news\//.test(s.url)],
  ] },
  { site: "Amazon", steps: [
    ["open the home page", (b) => b.navigate("https://www.amazon.com/"), (s) => /Amazon/.test(s.title) && s.elements.length > 30],
  ] },
  { site: "YouTube", steps: [
    ["open the home page", (b) => b.navigate("https://www.youtube.com/"), (s) => /YouTube/.test(s.title) && s.elements.length > 20],
  ] },
];

// Failures that match a known Arcana issue, so a regression stands out from a gap already filed.
// Failures that match a filed gap. Tables (Arcana#5) and clicks (Arcana#6) are fixed, so a stall or a click
// that fails now is unexplained and counts against the week.
const KNOWN_ERRORS = [];
const BLOCKED = /Just a moment|Attention Required|Access Denied|unusual traffic|verify you are not a bot|Performing security verification|Welcome to Reddit/i;

function classify(site, error, state, ms) {
  if (error) {
    const known = KNOWN_ERRORS.find((entry) => entry.re.test(error));
    return known ? { outcome: "known", issue: known.issue, detail: error } : { outcome: "unexplained", detail: error };
  }
  if (BLOCKED.test(`${state.title}\n${state.text || ""}`)) return { outcome: "blocked", detail: state.title };
  if (site === "Amazon" && (/Server Busy/i.test(state.title || "") || state.elements.length < 3)) return { outcome: "known", issue: "Arcana#8", detail: state.title };
  if (site === "YouTube" && state.elements.length === 0 && !(state.text || "").length) return { outcome: "known", issue: "Arcana#7", detail: "empty page" };
  if (site === "GitHub" && ms > 15000) return { outcome: "known", issue: "Arcana#9", detail: `${ms} ms` };
  return { outcome: "unexplained", detail: `${state.url} ${state.title}`.slice(0, 160) };
}

const append = (file, record) => fs.appendFileSync(file, JSON.stringify(record) + "\n");
const readLines = (file) => {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
};
const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s: ${what}`)), ms))]);

function busyReason() {
  const used = 100 - (100 * os.freemem()) / os.totalmem();
  if (used >= MAX_RAM_PERCENT) return `RAM ${used.toFixed(0)}% is at or over ${MAX_RAM_PERCENT}%`;
  try {
    const running = execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).toLowerCase();
    const game = BUSY.find((name) => running.includes(`"${name}"`));
    if (game) return `${game} is running`;
  } catch { /* no process list: carry on */ }
  return null;
}

async function runOnce() {
  fs.mkdirSync(DATA, { recursive: true });
  const at = new Date().toISOString();
  const skip = (reason) => { append(RUNS, { at, skipped: reason }); console.log(`skipped: ${reason}`); };
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (Date.now() - held.at < 45 * 60 * 1000) return skip("another run is still going");
  } catch { /* no lock */ }
  const busy = busyReason();
  if (busy) return skip(busy);
  fs.writeFileSync(LOCK, JSON.stringify({ at: Date.now(), pid: process.pid }));

  const plugin = require(path.join(ROOT, "plugins", "browser-automation", "index.js"));
  const deps = {
    env: { ...process.env, MANA_BROWSER_PROFILE_DIR: path.join(DATA, "profile"), MANA_ARCANA_EVENTS_FILE: EVENTS },
    ramPercent: () => 50,
    isGaming: () => false,
  };
  const only = (process.env.ARCANA_SOAK_ONLY || "").toLowerCase();
  try {
    for (const { site, steps } of SITES) {
      if (only && !site.toLowerCase().includes(only)) continue;
      plugin._resetForTests();
      const record = { at, site, outcome: "ok", steps: 0 };
      const started = Date.now();
      const eventsBefore = readLines(EVENTS).length;
      let browser;
      try {
        browser = await withTimeout(plugin.getSession(deps), 40000, "start the browser");
        // Arcana failing to start falls back to Edge: that is the unexplained fallback the week must not have.
        const fresh = readLines(EVENTS).slice(eventsBefore);
        if (fresh.some((event) => event.type === "arcana_start_failed")) {
          Object.assign(record, { outcome: "fallback", detail: fresh.find((e) => e.type === "arcana_start_failed").reason });
        }
        let state = null;
        for (const [name, act, check] of steps) {
          const t0 = Date.now();
          try {
            await withTimeout(Promise.resolve(act(browser, state)), 45000, name);
            state = await withTimeout(browser.snapshot(), 25000, "snapshot");
          } catch (error) {
            Object.assign(record, { step: name, ...classify(site, String(error.message).split("\n")[0], null, Date.now() - t0) });
            break;
          }
          const ms = Date.now() - t0;
          record.steps += 1;
          if (!check(state)) {
            Object.assign(record, { step: name, ...classify(site, null, state, ms) });
            break;
          }
          if (ms > 15000) record.slow = true;
        }
      } catch (error) {
        Object.assign(record, { step: "start", outcome: "unexplained", detail: String(error.message).split("\n")[0] });
      } finally {
        await plugin.closeSession().catch(() => {});
      }
      record.ms = Date.now() - started;
      append(RUNS, record);
      console.log(`${record.outcome.padEnd(11)} ${site}${record.issue ? ` (${record.issue})` : ""}${record.detail ? ` - ${String(record.detail).slice(0, 100)}` : ""}`);
    }
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

function report(days = 7) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const records = readLines(RUNS);
  const events = readLines(EVENTS);
  const first = Math.min(...[...records, ...events].map((r) => Date.parse(r.at)).filter(Number.isFinite), Date.now());
  const recent = records.filter((r) => Date.parse(r.at) >= since);
  const sites = recent.filter((r) => r.site);
  const skipped = recent.filter((r) => r.skipped);
  const runTimes = new Set(sites.map((r) => r.at));
  const inWindow = (e) => Date.parse(e.at) >= since;
  const started = events.filter((e) => inWindow(e) && e.type === "arcana_started").length;
  const failedStarts = events.filter((e) => inWindow(e) && (e.type === "arcana_start_failed" || e.type === "arcana_disconnected"));
  const count = (outcome) => sites.filter((r) => r.outcome === outcome).length;
  const unexplained = sites.filter((r) => r.outcome === "unexplained" || r.outcome === "fallback");
  const observedDays = (Date.now() - first) / 86400000;

  const bySite = new Map();
  for (const r of sites) {
    const row = bySite.get(r.site) || { ok: 0, known: 0, blocked: 0, unexplained: 0, issues: new Set() };
    row[r.outcome === "fallback" ? "unexplained" : r.outcome] += 1;
    if (r.issue) row.issues.add(r.issue);
    bySite.set(r.site, row);
  }
  const byDay = new Map();
  for (const r of sites) {
    const day = r.at.slice(0, 10);
    const row = byDay.get(day) || { runs: new Set(), unexplained: 0 };
    row.runs.add(r.at);
    if (r.outcome === "unexplained" || r.outcome === "fallback") row.unexplained += 1;
    byDay.set(day, row);
  }

  let verdict;
  if (observedDays < days) verdict = `insufficient: observed ${observedDays.toFixed(1)} of ${days} days`;
  else if (failedStarts.length || unexplained.length) verdict = "investigate";
  else if (runTimes.size < days * 2) verdict = `insufficient: only ${runTimes.size} completed runs`;
  else verdict = "clean";

  const lines = [
    `# Arcana soak, last ${days} days`,
    "",
    `Verdict: **${verdict}**`,
    "",
    `Observed ${observedDays.toFixed(1)} days (first record ${new Date(first).toISOString()}). ${runTimes.size} completed runs, ${skipped.length} skipped (busy machine).`,
    `Arcana started ${started} times; start failures or unasked disconnects: ${failedStarts.length}${failedStarts.length ? ` (${[...new Set(failedStarts.map((e) => e.reason || e.type))].join("; ")})` : ""}.`,
    `Site results: ${count("ok")} ok, ${count("known")} known gaps, ${count("blocked")} blocked by the site, ${unexplained.length} unexplained.`,
    "",
    "| Site | ok | known | blocked | unexplained | known issues |",
    "|---|---|---|---|---|---|",
    ...[...bySite].map(([site, r]) => `| ${site} | ${r.ok} | ${r.known} | ${r.blocked} | ${r.unexplained} | ${[...r.issues].join(", ")} |`),
    "",
    "| Day | runs | unexplained |",
    "|---|---|---|",
    ...[...byDay].sort().map(([day, r]) => `| ${day} | ${r.runs.size} | ${r.unexplained} |`),
  ];
  if (unexplained.length) {
    lines.push("", "Unexplained (newest first):", ...unexplained.slice(-10).reverse().map((r) => `- ${r.at} ${r.site} / ${r.step || "start"}: ${String(r.detail || "").slice(0, 160)}`));
  }
  const text = lines.join("\n") + "\n";
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "report.md"), text);
  return text;
}

(async () => {
  if (process.argv.includes("--report")) {
    console.log(report());
    return;
  }
  await runOnce();
  report();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  fs.rmSync(LOCK, { force: true });
  process.exit(1);
});
