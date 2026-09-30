// Issue #699: heartbeat.md -- a plain checklist, one check per line, that
// Mana runs in the background with her tools and only speaks up about when
// something needs the user. Lines that don't start with "-" or "*" are
// ignored, so headings and notes are fine:
//
//   - [read, network] every 30m: check github.com notifications for review requests
//   - [read, write] daily 09:00: append yesterday's summary to D:\Notes\journal.md
//   - warn me if D: drops below 50 GB          (read only, every 30 minutes)
//
// Permissions are #669's risk tiers. No list = read only. Write and network
// calls run unattended, but only inside the folders/files and sites the
// check's own text names; every write is snapshotted first and listed in
// the next report. Install and destructive can never be granted: those
// calls always wait in the approval queue. "urgent" is passed along with
// the check's reports (for #697's quiet hours).
//
// A check is identified by its permissions + text, so editing either one
// makes it a new check: it does a dry run (read calls, plus Mana's
// own built-in fetch from the sites its own line names; anything else,
// MCP/add-on tools included, is noted, not run), then waits in the approval queue with what it would
// have said, and only runs for real once approved. Changing just the
// interval or "urgent" doesn't need a new approval. Nothing runs while a
// watched game is running.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { computeNextRun, isValidSchedule } = require("./cron-scheduler");
const {
  PATH_KEY_RE,
  classifyToolCall,
  extractHosts,
  stringEntries,
  tokenize,
  wrapWithRiskGate,
} = require("../../node-bot/ai/tool-risk");

const GRANTABLE = new Set(["read", "write", "network"]);
const NEVER_GRANTED = new Set(["install", "destructive"]);
const DEFAULT_EVERY_MS = 30 * 60 * 1000;
// Each run is a full model turn; don't let a typo like "every 1m" keep the
// GPU busy.
const MIN_EVERY_MS = 5 * 60 * 1000;
const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const QUIET = "NOTHING_TO_REPORT";
// A write whose existing target is bigger than this can't be snapshotted,
// so it isn't run.
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

// Windows paths only (quoted ones may hold spaces) -- Mana runs on Windows.
const PATH_RE = /"([a-z]:\\[^"]*)"|\b([a-z]:\\[^\s"'<>|*?]*)/gi;
const trimPunct = (s) => s.replace(/[.,;:!?)\]]+$/, "");

// What a check's text names: the folders/files its writes may touch and the
// sites (and their subdomains) its network calls may contact.
function extractScope(text) {
  const paths = [];
  const rest = text.replace(PATH_RE, (m, quoted, bare) => {
    paths.push(path.win32.resolve(trimPunct(quoted || bare)));
    return " ";
  });
  // extractHosts only takes bare hosts from host-named keys.
  const hosts = extractHosts({ host: rest.split(/\s+/).map(trimPunct) }, null);
  return { paths, hosts };
}

// One heartbeat.md line -> a check, { error } for a malformed one, or null
// for a line that isn't a check at all.
function parseLine(line) {
  const item = /^\s*[-*]\s+(.*)$/.exec(line);
  if (!item) return null;
  let rest = item[1].trim();
  const permissions = new Set(["read"]);
  let urgent = false;
  const list = /^\[([^\]]*)\]\s*/.exec(rest);
  if (list) {
    rest = rest.slice(list[0].length);
    for (const word of list[1].toLowerCase().split(/[\s,]+/).filter(Boolean)) {
      if (word === "urgent") urgent = true;
      else if (NEVER_GRANTED.has(word)) return { error: `"${word}" can never be granted to a check` };
      else if (GRANTABLE.has(word)) permissions.add(word);
      else return { error: `unknown permission "${word}" (use read, write, network, urgent)` };
    }
  }
  let schedule = { type: "interval", everyMs: DEFAULT_EVERY_MS };
  const every = /^every\s+(\d+)\s*([mhd])[a-z]*\s*:\s*/i.exec(rest);
  const daily = /^daily\s+(\d{1,2}):(\d{2})\s*:\s*/i.exec(rest);
  if (every) {
    schedule = { type: "interval", everyMs: Number(every[1]) * UNIT_MS[every[2].toLowerCase()] };
    if (schedule.everyMs < MIN_EVERY_MS) return { error: "the shortest interval is every 5m" };
    rest = rest.slice(every[0].length);
  } else if (daily) {
    schedule = { type: "daily", hour: Number(daily[1]), minute: Number(daily[2]) };
    if (!isValidSchedule(schedule)) return { error: `"daily ${daily[1]}:${daily[2]}" isn't a time of day` };
    rest = rest.slice(daily[0].length);
  } else if (/^(every|daily)\s+[^\s:]+\s*:/i.test(rest)) {
    return { error: 'schedule should look like "every 30m:", "every 2h:" or "daily 09:00:"' };
  }
  const text = rest.trim();
  if (!text) return { error: "the check has no text" };
  const perms = [...permissions].sort();
  const id = crypto.createHash("sha256").update(JSON.stringify([perms, text])).digest("hex").slice(0, 16);
  return { id, permissions: perms, urgent, schedule, text, scope: extractScope(text) };
}

function parseHeartbeat(markdown) {
  const checks = [];
  const errors = [];
  String(markdown || "")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const parsed = parseLine(line);
      if (parsed?.error) errors.push({ line: i + 1, text: line.trim(), error: parsed.error });
      else if (parsed && !checks.some((c) => c.id === parsed.id)) checks.push(parsed);
    });
  return { checks, errors };
}

function checkPrompt(check) {
  return [
    `[heartbeat check] ${check.text}`,
    "This is one of the user's background heartbeat checks, not a message from them. Do it with your tools.",
    `If nothing needs the user's attention or action, or you already told them in an earlier run and nothing changed, reply with exactly ${QUIET} and nothing else. Otherwise reply with one or two short sentences for them.`,
  ].join("\n");
}

function inScope(target, scopePaths) {
  const t = target.toLowerCase();
  return scopePaths.some((p) => {
    const s = p.toLowerCase().replace(/\\+$/, "");
    return t === s || t.startsWith(`${s}\\`);
  });
}

// Absolute paths a call could write to; null for one that can't be pinned
// down (relative with no working folder, "..", env vars, ~). A command line
// counts its working folder, its absolute-path tokens and its redirect
// targets; relative arguments then land inside the working folder.
// ponytail: a command can still reach outside its folder in ways a token
// scan can't see (a path built at run time); the risk gate's destructive
// rules still apply on top.
function writeTargets(args, risk) {
  const candidates = stringEntries(args)
    .filter(([key]) => PATH_KEY_RE.test(key))
    .map(([, value]) => value);
  if (risk.command) {
    if (risk.tier === "write") candidates.push(risk.cwd || null);
    const tokens = tokenize(risk.command);
    tokens.forEach((token, i) => {
      if (/^([a-z]:[\\/]|\\\\)/i.test(token)) candidates.push(token);
      else if (/^\d?>>?$/.test(token) && tokens[i + 1]) candidates.push(tokens[i + 1]);
      else if (/^\d?>>?[^>&]/.test(token)) candidates.push(token.replace(/^\d?>>?/, ""));
      else if (token.includes("..")) candidates.push(null);
    });
  }
  const base = risk.cwd && path.win32.isAbsolute(risk.cwd) ? risk.cwd : null;
  return candidates
    .filter((c) => !/^[a-z][\w+.-]*:\/\//i.test(String(c ?? ""))) // URLs are sites, not paths
    .map((c) => {
      const value = c && String(c).trim();
      if (!value || /[$%~]|\.\./.test(value)) return null;
      if (/^([a-z]:[\\/]|\\\\)/i.test(value)) return path.win32.resolve(value);
      return base ? path.win32.resolve(base, value) : null;
    });
}

// Why this write/network call is outside what the check was granted, or ""
// if it may run.
function refusalFor(check, risk, targets, protectedDir) {
  if (risk.tier === "network" || risk.hosts.length) {
    if (!check.permissions.includes("network")) return "this check has no network permission";
    if (!risk.hosts.length) return "the call names no site, so it can't be checked against this check's sites";
    const outside = risk.hosts.find((h) => !check.scope.hosts.some((s) => h === s || h.endsWith(`.${s}`)));
    if (outside) return `${outside} isn't a site this check names`;
  }
  if (risk.tier === "write" || targets.length) {
    if (!check.permissions.includes("write")) return "this check has no write permission";
    if (!targets.length) return "the call names no file or folder, so it can't be checked against this check's folders";
    const outside = targets.find((t) => !t || !inScope(t, check.scope.paths));
    if (outside === null) return "a path in the call can't be pinned down (relative with no working folder, .., or a variable)";
    if (outside) return `${outside} is outside the folders this check names`;
    // A check must never approve itself by editing heartbeat.md or its state.
    if (protectedDir && targets.some((t) => inScope(t, [protectedDir]))) return "Mana's own heartbeat files are off limits";
  }
  return "";
}

// Q31: a dry run may fetch from the sites the check's own line names, but
// only with Mana's own built-in page fetch (browser_automation__navigate)
// -- never an MCP/add-on tool whatever its name says, a shell command, a
// page click/type or anything that writes a file. Those run only once the
// user approves the check.
const DRY_RUN_FETCH_TOOLS = new Set(["browser_automation__navigate"]);

function isDryRunFetch(name, risk) {
  return risk.tier === "network" && DRY_RUN_FETCH_TOOLS.has(name);
}

// The tool gate for one check's run. server.js's reply pipeline uses it in
// place of #669's risk gate (replyMeta.wrapToolPolicy). Read calls run;
// install/destructive ones always wait for the user; write/network ones run
// only inside the check's grants and scope, each write snapshotted first.
// In a dry run only read calls (and Q31's built-in fetches from the check's
// own sites) run -- the rest are noted in wouldRun.
// protectedDir: the heartbeat's own data folder, never writable.
function createCheckToolGate(check, { dryRun, snapshotStore, writes, wouldRun, protectedDir, fsDeps = fs }) {
  return (policy, approvalGate) => {
    const held = wrapWithRiskGate(policy, approvalGate, { mode: "ask", alwaysReview: ["install"] });
    const executeTool = async (name, args) => {
      const risk = classifyToolCall(name, args);
      const label = `${name}${risk.command ? ` (${risk.command.slice(0, 120)})` : ""}`;
      if (risk.tier === "read") return policy.executeTool(name, args);
      if (dryRun) {
        if (isDryRunFetch(name, risk) && !refusalFor(check, risk, [], protectedDir)) {
          return policy.executeTool(name, args);
        }
        wouldRun.push(`${label} [${risk.tier}]`);
        return `Dry run: ${name} was not run. Say what you would have done with it.`;
      }
      if (risk.tier === "install" || risk.tier === "destructive") return held.executeTool(name, args);
      const targets = writeTargets(args, risk);
      const refusal = refusalFor(check, risk, targets, protectedDir);
      if (refusal) return `Not allowed for this heartbeat check: ${refusal}.`;
      const snapshots = [];
      for (const target of targets) {
        let stat = null;
        try {
          stat = fsDeps.statSync(target);
        } catch (e) {
          continue; // doesn't exist yet: nothing to snapshot
        }
        if (!stat.isFile()) continue; // ponytail: a folder isn't snapshotted, only listed
        if (stat.size > MAX_SNAPSHOT_BYTES) {
          return `Not allowed for this heartbeat check: ${target} is too big to snapshot before writing.`;
        }
        if (snapshotStore) {
          snapshots.push(
            snapshotStore.recordSnapshot({
              kind: "file",
              key: path.win32.basename(target),
              scope: path.win32.dirname(target),
              payload: fsDeps.readFileSync(target, "utf8"),
              summary: `heartbeat: ${check.text.slice(0, 80)}`,
              source: "heartbeat",
            }).id,
          );
        }
      }
      writes.push({ check: check.text, call: label, targets, snapshots });
      return policy.executeTool(name, args);
    };
    return { tools: policy.tools, isKnownTool: policy.isKnownTool, executeTool };
  };
}

function describeWrite(w) {
  return `${w.call}${w.targets.length ? ` -> ${w.targets.join(", ")}` : ""}${w.snapshots.length ? " (snapshot saved)" : ""}`;
}

// runCheck(prompt, wrapToolPolicy, sessionId) -> reply text, run in the
// check's own session so it sees what it said before; notify(payload) delivers
// a report; approvalGate holds a new/edited check's go-live approval.
function createHeartbeat({
  dataDir,
  runCheck,
  notify = () => {},
  isGaming = () => false,
  isEnabled = () => true,
  approvalGate = null,
  snapshotStore = null,
  now = () => Date.now(),
}) {
  const filePath = path.join(dataDir, "heartbeat.md");
  const statePath = path.join(dataDir, "heartbeat-state.json");
  let state = { checks: {}, unreportedWrites: [], errorsShown: "" };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
  } catch (e) {}
  let running = false;
  // Checks whose dry run is waiting in the approval queue. In memory, like
  // that queue: after a restart they dry-run and ask again.
  const awaitingApproval = new Set();

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(`${statePath}.tmp`, statePath);
  }

  function read() {
    try {
      return parseHeartbeat(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      return { checks: [], errors: [] };
    }
  }

  // The approval queue's executor: takes a check live, if it's still in
  // heartbeat.md unchanged.
  function approve(id) {
    const check = read().checks.find((c) => c.id === id);
    if (!check) return { ok: false, error: "that check was edited or removed since its dry run" };
    // In place: a running runDue may hold this entry.
    state.checks[id] = Object.assign(state.checks[id] || {}, {
      approved: true,
      nextRunAt: computeNextRun(check.schedule, now()),
    });
    save();
    return { ok: true, check: check.text };
  }

  async function requestGoLive(check, report, wouldRun) {
    if (!approvalGate) return;
    const lines = [
      `Heartbeat check [${check.permissions.join(", ")}]: ${check.text}`,
      report ? `Dry run would say: ${report}` : "Dry run: nothing to report, it would stay quiet.",
      ...(wouldRun.length ? [`Would also run: ${wouldRun.join("; ")}`] : []),
    ];
    await approvalGate.requestApproval("heartbeat-check", {
      summary: lines.join("\n"),
      payload: { id: check.id },
      // Never an always-allow: every new or edited check is looked at.
      forceReview: true,
      details: { permissions: check.permissions, scope: check.scope, schedule: check.schedule, report, wouldRun },
    });
  }

  async function runOne(check, entry) {
    const dryRun = !entry.approved;
    const writes = [];
    const wouldRun = [];
    const gate = createCheckToolGate(check, {
      dryRun,
      snapshotStore,
      writes,
      wouldRun,
      protectedDir: path.win32.resolve(dataDir),
    });
    entry.lastRunAt = now();
    entry.nextRunAt = computeNextRun(check.schedule, entry.lastRunAt);
    let reply;
    try {
      reply = String((await runCheck(checkPrompt(check), gate, `heartbeat-${check.id}`)) ?? "").trim();
      entry.lastError = null;
    } catch (e) {
      entry.lastError = e?.message || String(e);
      console.warn(`heartbeat: "${check.text}" failed:`, entry.lastError);
    }
    state.unreportedWrites.push(...writes);
    if (reply === undefined) return save();
    const report = !reply || reply.includes(QUIET) ? "" : reply;
    if (dryRun) {
      awaitingApproval.add(check.id);
      save();
      return requestGoLive(check, report, wouldRun);
    }
    if (report) {
      const changes = state.unreportedWrites.map(describeWrite);
      await notify({
        type: "cron",
        title: `Heartbeat: ${check.text.length > 60 ? `${check.text.slice(0, 60)}...` : check.text}`,
        text: changes.length ? `${report}\n\nChanges I made:\n- ${changes.join("\n- ")}` : report,
        ...(check.urgent ? { urgent: true } : {}),
        at: new Date(now()).toISOString(),
      });
      state.unreportedWrites = [];
    }
    save();
  }

  // Runs every check that's due, one at a time. A check waiting for its
  // go-live approval doesn't run again.
  async function runDue() {
    if (running || !isEnabled() || isGaming()) return;
    running = true;
    try {
      const { checks, errors } = read();
      const before = JSON.stringify(state);
      const shown = JSON.stringify(errors);
      if (errors.length && shown !== state.errorsShown) {
        await notify({
          type: "cron",
          title: "Heartbeat: some lines in heartbeat.md were skipped",
          text: errors.map((e) => `line ${e.line}: ${e.error}`).join("\n"),
          at: new Date(now()).toISOString(),
        });
      }
      state.errorsShown = shown;
      // Edited or removed checks drop out here, taking their approval.
      state.checks = Object.fromEntries(checks.map((c) => [c.id, state.checks[c.id] || { approved: false, nextRunAt: 0 }]));
      if (JSON.stringify(state) !== before) save();
      for (const check of checks) {
        if (isGaming()) break;
        const entry = state.checks[check.id];
        if (!entry || entry.nextRunAt > now() || (!entry.approved && awaitingApproval.has(check.id))) continue;
        await runOne(check, entry);
      }
    } finally {
      running = false;
    }
  }

  // #1124: each check in heartbeat.md with its run state, for the
  // Background tasks panel.
  function listChecks() {
    return read().checks.map((c) => {
      const entry = state.checks[c.id] || {};
      return {
        id: c.id,
        text: c.text,
        approved: Boolean(entry.approved),
        nextRunAt: entry.nextRunAt || 0,
        lastError: entry.lastError || null,
        // The set keeps approved ids too; runDue ignores those.
        awaitingApproval: !entry.approved && awaitingApproval.has(c.id),
      };
    });
  }

  return { filePath, runDue, approve, listChecks, getState: () => state };
}

module.exports = { parseHeartbeat, createCheckToolGate, createHeartbeat };
