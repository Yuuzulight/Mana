// #1390: one coordinated retention pass over the memory stores. Authoritative
// data (sessions, facts) is never deleted: sessions are moved to
// archive/sessions, old fact-log lines are moved to archive/facts-log-<year>,
// and only derived data (search rows, entity mentions) or approved graph
// history is dropped. Every step is checkpointed (maintenance/checkpoint.json)
// so an interrupted pass resumes, and a step that throws is rolled back from
// its backup (maintenance/backup/<planId>/).
const fs = require("node:fs");
const path = require("node:path");

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RULES = { factsLogArchiveDays: 180, sessionArchiveDays: 365, graphHistoryDays: 365 };
// Order matters: derived indexes are reconciled against the sessions that
// exist before anything is archived (the next pass reconciles the archived
// ones), and the approval-gated steps come last.
const ORDER = ["reconcile-search", "reconcile-entities", "archive-facts-log", "archive-session", "prune-graph-history"];

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text, "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return { bytes: st.size, items: 1, oldestAt: st.mtime.toISOString() };
    const total = { bytes: 0, items: 0, oldestAt: null };
    for (const name of fs.readdirSync(p)) {
      const sub = sizeOf(path.join(p, name));
      total.bytes += sub.bytes;
      total.items += sub.items;
      if (sub.oldestAt && (!total.oldestAt || sub.oldestAt < total.oldestAt)) total.oldestAt = sub.oldestAt;
    }
    return total;
  } catch (e) {
    return { bytes: 0, items: 0, oldestAt: null };
  }
}

function createMemoryMaintenance({ store, searchIndex, memoryGraph, dataDir, now, rules, isGaming } = {}) {
  const dir = dataDir || store.dataDir;
  const clock = now || (() => new Date().toISOString());
  const rule = { ...DEFAULT_RULES, ...(rules || {}) };
  const sessionsDir = path.join(dir, "sessions");
  const factsPath = path.join(dir, "facts.json");
  const logPath = path.join(dir, "facts-log.jsonl");
  const entityPath = path.join(dir, "entity-index.json");
  const archiveDir = path.join(dir, "archive");
  const maintDir = path.join(dir, "maintenance");
  const checkpointPath = path.join(maintDir, "checkpoint.json");
  const backupRoot = path.join(maintDir, "backup");
  const cutoff = (days) => new Date(Date.parse(clock()) - days * DAY).toISOString();
  let running = false;

  // ---- reading the stores (never throws; unreadable = reported, not acted on)
  function scanSessions() {
    let files;
    try {
      files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      return null;
    }
    // ponytail: parses every session file once per plan; fine for hundreds of
    // sessions, index updatedAt somewhere cheap if it ever gets to thousands.
    return files.map((file) => {
      const id = Buffer.from(file.slice(0, -5), "base64url").toString();
      try {
        const s = readJson(path.join(sessionsDir, file));
        if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("not an object");
        return { file, id, updatedAt: s.updatedAt || null, forkedFrom: s.forkedFrom || null, corrupt: false };
      } catch (e) {
        // A corrupt file still counts as existing: its indexes are kept.
        return { file, id, updatedAt: null, forkedFrom: null, corrupt: true };
      }
    });
  }

  // sessionId -> why a fact needs it; null when facts.json can't be read.
  function factRefs() {
    let facts = [];
    try {
      if (fs.existsSync(factsPath)) {
        const parsed = readJson(factsPath);
        facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
      }
    } catch (e) {
      return null;
    }
    const refs = new Map();
    for (const f of facts) {
      const why = f.status === "pending" ? "a pending fact" : f.pinned ? "a pinned fact" : f.trigger ? "a standing intent"
        : f.status === "active" ? "an active fact" : null;
      if (!why) continue;
      for (const sid of [f.sessionId, f.origin?.sessionId]) {
        if (sid && !refs.has(sid)) refs.set(sid, `referenced by ${why} (${f.key})`);
      }
    }
    return refs;
  }

  function readLog() {
    const lines = [];
    let unparseable = 0;
    if (!fs.existsSync(logPath)) return { lines, unparseable };
    for (const raw of fs.readFileSync(logPath, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push({ raw, at: JSON.parse(raw).at });
      } catch (e) {
        unparseable += 1;
        lines.push({ raw, at: null });
      }
    }
    return { lines, unparseable };
  }

  // Lines old enough to archive; anything without a valid `at` stays live.
  function oldLogLines(lines) {
    const limit = cutoff(rule.factsLogArchiveDays);
    return lines.filter((l) => typeof l.at === "string" && !Number.isNaN(Date.parse(l.at)) && l.at < limit);
  }

  function entityIndex() {
    try {
      return fs.existsSync(entityPath) ? readJson(entityPath) : null;
    } catch (e) {
      return undefined;
    }
  }

  // ---- steps: plan (describe), backup/restore (optional), exec (do it)
  const defs = {
    "reconcile-search": {
      kind: "auto", store: "session-search",
      plan(ctx) {
        if (!searchIndex?.listSessionIds || !ctx.sessions) return null;
        const orphans = searchIndex.listSessionIds().filter((id) => !ctx.exists.has(id));
        if (!orphans.length) return null;
        // An empty sessions dir is more likely a wrong path than every session gone.
        if (!ctx.exists.size) {
          ctx.kept.push({ store: "session-search", what: `${orphans.length} indexed sessions`, why: "no session files found, refusing to treat all as deleted" });
          return null;
        }
        return { action: "remove search rows of deleted sessions", target: `${orphans.length} sessions`, reason: "their session files no longer exist" };
      },
      exec() {
        const exists = new Set(scanSessions().map((s) => s.id));
        const orphans = searchIndex.listSessionIds().filter((id) => !exists.has(id));
        return { rows: exists.size ? searchIndex.removeSessions(orphans) : 0 };
      },
    },
    "reconcile-entities": {
      kind: "auto", store: "entity-index",
      plan(ctx) {
        const index = entityIndex();
        if (index === undefined) ctx.kept.push({ store: "entity-index", what: "entity-index.json", why: "unreadable, left alone" });
        if (!index || !ctx.sessions || !ctx.exists.size) return null;
        let mentions = 0;
        for (const list of Object.values(index)) {
          if (Array.isArray(list)) mentions += list.filter((m) => m?.sessionId && !ctx.exists.has(m.sessionId)).length;
        }
        return mentions ? { action: "drop mentions of deleted sessions", target: `${mentions} mentions`, reason: "their session files no longer exist" } : null;
      },
      backup: (to) => copy(entityPath, path.join(to, "entity-index.json")),
      restore: (from) => copy(path.join(from, "entity-index.json"), entityPath),
      exec() {
        const exists = new Set(scanSessions().map((s) => s.id));
        const index = entityIndex();
        if (!index || !exists.size) return { mentions: 0 };
        let mentions = 0;
        const next = {};
        for (const [entity, list] of Object.entries(index)) {
          if (!Array.isArray(list)) { next[entity] = list; continue; }
          const keep = list.filter((m) => !(m?.sessionId && !exists.has(m.sessionId)));
          mentions += list.length - keep.length;
          if (keep.length) next[entity] = keep;
        }
        if (mentions) writeAtomic(entityPath, `${JSON.stringify(next, null, 2)}\n`);
        return { mentions };
      },
    },
    "archive-facts-log": {
      kind: "auto", store: "facts-log",
      plan(ctx) {
        const { lines, unparseable } = readLog();
        if (unparseable) ctx.kept.push({ store: "facts-log", what: `${unparseable} unparseable lines`, why: "left in the live log" });
        const old = oldLogLines(lines);
        if (!old.length) return null;
        const bytes = old.reduce((n, l) => n + Buffer.byteLength(l.raw) + 1, 0);
        return { action: "move old fact-log lines to archive/", target: `${old.length} lines`, reason: `older than ${rule.factsLogArchiveDays} days; getFactHistory still reads them`, bytes };
      },
      backup(to) {
        copy(logPath, path.join(to, "facts-log.jsonl"));
        for (const f of archiveLogFiles()) copy(path.join(archiveDir, f), path.join(to, "archive", f));
      },
      restore(from) {
        // Lines written after the backup (say, after a crash and before this
        // resume) are in neither the backup nor the archive: keep them.
        const rawLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()) : []);
        const backedUp = path.join(from, "facts-log.jsonl");
        const known = new Set([...rawLines(backedUp), ...archiveLogFiles().flatMap((f) => rawLines(path.join(archiveDir, f)))]);
        const later = rawLines(logPath).filter((l) => !known.has(l));
        copy(backedUp, logPath);
        if (later.length) fs.appendFileSync(logPath, `${later.join("\n")}\n`, "utf8");
        for (const f of archiveLogFiles()) fs.rmSync(path.join(archiveDir, f), { force: true });
        const saved = path.join(from, "archive");
        if (fs.existsSync(saved)) for (const f of fs.readdirSync(saved)) copy(path.join(saved, f), path.join(archiveDir, f));
      },
      // Synchronous on purpose: no appendFileSync from saveFacts can interleave.
      exec() {
        const { lines } = readLog();
        const old = new Set(oldLogLines(lines));
        if (!old.size) return { lines: 0 };
        const byYear = {};
        for (const l of old) (byYear[l.at.slice(0, 4)] ||= []).push(l.raw);
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const [year, raws] of Object.entries(byYear)) {
          fs.appendFileSync(path.join(archiveDir, `facts-log-${year}.jsonl`), `${raws.join("\n")}\n`, "utf8");
        }
        const rest = lines.filter((l) => !old.has(l)).map((l) => l.raw);
        writeAtomic(logPath, rest.length ? `${rest.join("\n")}\n` : "");
        return { lines: old.size };
      },
    },
    "archive-session": {
      kind: "needs-approval", store: "sessions",
      plan(ctx) {
        if (!ctx.sessions) return null;
        if (!ctx.refs) {
          ctx.kept.push({ store: "sessions", what: "all sessions", why: "facts.json unreadable, can't tell which sessions facts need" });
          return null;
        }
        const { archive, kept } = pickSessions(ctx.sessions, ctx.refs);
        ctx.kept.push(...kept);
        if (!archive.length) return null;
        const bytes = archive.reduce((n, s) => n + sizeOf(path.join(sessionsDir, s.file)).bytes, 0);
        return { action: "move to archive/sessions (never deleted)", target: `${archive.length} sessions`, reason: `not updated in ${rule.sessionArchiveDays} days and no live fact needs them`, bytes };
      },
      exec() {
        const refs = factRefs();
        const sessions = scanSessions();
        if (!refs || !sessions) return { sessions: 0 };
        const moved = [];
        try {
          fs.mkdirSync(path.join(archiveDir, "sessions"), { recursive: true });
          for (const s of pickSessions(sessions, refs).archive) {
            let to = path.join(archiveDir, "sessions", s.file);
            if (fs.existsSync(to)) to = `${to.slice(0, -5)}-${Date.now()}.json`;
            fs.renameSync(path.join(sessionsDir, s.file), to);
            moved.push([to, path.join(sessionsDir, s.file)]);
          }
        } catch (e) {
          for (const [from, back] of moved.reverse()) fs.renameSync(from, back); // undo, then fail the step
          throw e;
        }
        return { sessions: moved.length };
      },
    },
    "prune-graph-history": {
      kind: "needs-approval", store: "memory-graph",
      plan() {
        if (!memoryGraph?.countHistoryBefore) return null;
        const { history, closed } = memoryGraph.countHistoryBefore(cutoff(rule.graphHistoryDays));
        return history + closed
          ? { action: "delete old closed edge windows", target: `${closed} closed edges, ${history} archived windows`, reason: `closed more than ${rule.graphHistoryDays} days ago (live edges untouched)` }
          : null;
      },
      // The prune is one SQL transaction, so a throw leaves the db unchanged;
      // the backup is for the person who later wants the old windows back.
      backup: (to) => memoryGraph.backup(path.join(to, "memory-graph.db")),
      exec: () => memoryGraph.pruneHistoryBefore(cutoff(rule.graphHistoryDays)),
    },
  };

  function copy(from, to) {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  function archiveLogFiles() {
    try {
      return fs.readdirSync(archiveDir).filter((f) => /^facts-log-.*\.jsonl$/.test(f));
    } catch (e) {
      return [];
    }
  }

  // Old and unreferenced sessions to archive, and the old ones kept (with why).
  function pickSessions(sessions, refs) {
    const limit = cutoff(rule.sessionArchiveDays);
    const kept = [];
    const candidates = new Map();
    for (const s of sessions) {
      if (s.corrupt) { kept.push({ store: "sessions", what: s.id, why: "corrupt session file, not touched" }); continue; }
      if (!s.updatedAt || Number.isNaN(Date.parse(s.updatedAt))) { kept.push({ store: "sessions", what: s.id, why: "no valid updatedAt" }); continue; }
      if (s.updatedAt >= limit) continue;
      if (refs.has(s.id)) { kept.push({ store: "sessions", what: s.id, why: refs.get(s.id) }); continue; }
      candidates.set(s.id, s);
    }
    // A fork keeps its parent: whatever a retained session points at stays.
    for (let changed = true; changed;) {
      changed = false;
      for (const s of sessions) {
        if (!candidates.has(s.id) && s.forkedFrom && candidates.has(s.forkedFrom)) {
          const parent = candidates.get(s.forkedFrom);
          candidates.delete(s.forkedFrom);
          kept.push({ store: "sessions", what: parent.id, why: `parent of retained fork ${s.id}` });
          changed = true;
        }
      }
    }
    return { archive: [...candidates.values()], kept };
  }

  // ---- measuring
  function measure() {
    const logScan = readLog();
    const logAts = logScan.lines.map((l) => l.at).filter((a) => typeof a === "string").sort();
    const db = (name) => [path.join(dir, name), path.join(dir, `${name}-wal`)];
    // ponytail: the measure-only dirs are the default locations (snapshots and
    // tool-call-log sit beside acp-memory); an env override isn't followed.
    const defs2 = [
      ["sessions", [sessionsDir], "archive after a year, with approval"],
      ["facts", [factsPath], "capped at 500 facts"],
      ["facts-log", [logPath], `lines older than ${rule.factsLogArchiveDays} days archived`, { items: logScan.lines.length, oldestAt: logAts[0] || null }],
      ["entity-index", [entityPath], "per-entity mention cap; reconciled against sessions"],
      ["session-search", db("session-search.db"), "reconciled against sessions"],
      ["memory-graph", db("memory-graph.db"), `edge caps; history older than ${rule.graphHistoryDays} days needs approval`],
      ["archive", [archiveDir], "never deleted automatically"],
      ["snapshots", [path.join(dir, "..", "snapshots")], "capped at 100 per kind (measure only)"],
      ["self-work-traces", [path.join(dir, "self-work-traces")], "rotated by the trace store (measure only)"],
      ["tool-call-log", [path.join(dir, "..", "tool-call-log")], "bounded elsewhere (measure only)"],
    ];
    return defs2.map(([id, paths, bound, over]) => {
      const sizes = paths.map(sizeOf);
      return {
        id,
        bytes: sizes.reduce((n, s) => n + s.bytes, 0),
        items: sizes[0].items,
        oldestAt: sizes[0].oldestAt,
        bound,
        ...over,
      };
    });
  }

  function buildPlan() {
    const sessions = scanSessions();
    const ctx = { sessions, exists: new Set((sessions || []).map((s) => s.id)), refs: factRefs(), kept: [] };
    const steps = [];
    for (const id of ORDER) {
      const d = defs[id].plan(ctx);
      if (d) steps.push({ id, store: defs[id].store, kind: defs[id].kind, bytes: 0, ...d });
    }
    return { planId: clock().replace(/\D/g, ""), at: clock(), stores: measure(), steps, kept: ctx.kept };
  }

  // ---- checkpoint
  function readCheckpoint() {
    try {
      return readJson(checkpointPath);
    } catch (e) {
      return null;
    }
  }
  const saveCheckpoint = (cp) => writeAtomic(checkpointPath, `${JSON.stringify(cp, null, 2)}\n`);
  const totalBytes = () => measure().reduce((n, s) => n + s.bytes, 0);

  async function run({ mode = "auto", approve = [], signal } = {}) {
    if (running) return { busy: true };
    if (isGaming?.()) return { skippedFor: "gaming" };
    running = true;
    try {
      return await runPass({ mode, approve, signal });
    } finally {
      running = false;
    }
  }

  async function runPass({ mode, approve, signal }) {
    const approved = new Set(mode === "approved" && Array.isArray(approve) ? approve : []);
    const runnable = (id) => defs[id].kind === "auto" || approved.has(id);
    const bytesBefore = totalBytes();
    const plan = buildPlan();
    let cp = readCheckpoint();
    if (cp?.steps?.some((s) => s.state === "pending" || s.state === "started") && cp.steps.every((s) => defs[s.id])) {
      // Resume: a step caught mid-way is put back as it was, then redone.
      for (const s of cp.steps) {
        if (s.state !== "started") continue;
        try {
          defs[s.id].restore?.(path.join(backupRoot, cp.planId));
          s.state = "pending";
        } catch (e) {
          s.state = "failed";
          s.error = `restore failed: ${e.message}`;
          for (const rest of cp.steps) if (rest.state === "pending") rest.state = "skipped";
        }
      }
    } else {
      cp = {
        planId: plan.planId,
        steps: plan.steps.filter((s) => runnable(s.id)).map((s) => ({ id: s.id, state: "pending" })),
        startedAt: clock(),
        lastRunAt: cp?.lastRunAt || null,
        lastResult: cp?.lastResult || null,
      };
    }
    saveCheckpoint(cp);

    const backupDir = path.join(backupRoot, cp.planId);
    const results = {};
    let aborted = false;
    for (const s of cp.steps) {
      if (s.state !== "pending") continue;
      if (signal?.aborted) { aborted = true; break; }
      if (!runnable(s.id)) { s.state = "skipped"; saveCheckpoint(cp); continue; }
      try {
        if (defs[s.id].backup) { await defs[s.id].backup(backupDir); s.backup = true; }
        s.state = "started";
        saveCheckpoint(cp);
        results[s.id] = await defs[s.id].exec();
        s.state = "done";
        saveCheckpoint(cp);
      } catch (e) {
        try {
          defs[s.id].restore?.(backupDir);
        } catch (restoreError) {
          s.error = `restore failed: ${restoreError.message}; `;
        }
        s.state = "failed";
        s.error = `${s.error || ""}${e.message}`;
        for (const rest of cp.steps) if (rest.state === "pending") rest.state = "skipped";
        saveCheckpoint(cp);
        break;
      }
    }

    const ids = (state) => cp.steps.filter((s) => s.state === state).map((s) => s.id);
    const count = (id, field) => results[id]?.[field] || 0;
    const report = {
      planId: cp.planId,
      done: ids("done"),
      failed: cp.steps.filter((s) => s.state === "failed").map((s) => ({ id: s.id, error: s.error })),
      skipped: ids("skipped"),
      aborted,
      archived: count("archive-session", "sessions") + count("archive-facts-log", "lines"),
      reconciled: count("reconcile-search", "rows") + count("reconcile-entities", "mentions"),
      proposed: plan.steps.filter((s) => defs[s.id].kind === "needs-approval" && !(cp.steps.some((c) => c.id === s.id && c.state === "done"))),
      bytesBefore,
      bytesAfter: totalBytes(),
    };
    if (!aborted) {
      // A cancelled pass keeps its checkpoint and backups for the resume.
      cp.lastRunAt = clock();
      cp.lastResult = { done: report.done, failed: report.failed, proposed: report.proposed.length };
      saveCheckpoint(cp);
      if (!report.failed.length) {
        for (const name of fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []) {
          if (name !== cp.planId) fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
        }
      }
    }
    return report;
  }

  function status() {
    const cp = readCheckpoint();
    return {
      running,
      lastRunAt: cp?.lastRunAt || null,
      incomplete: Boolean(cp?.steps?.some((s) => s.state === "pending" || s.state === "started")),
      failed: cp?.lastResult?.failed || [],
      proposed: cp?.lastResult?.proposed || 0,
    };
  }

  return { plan: buildPlan, run, status };
}

module.exports = { createMemoryMaintenance, DEFAULT_RULES };
