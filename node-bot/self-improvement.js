// #1386: one lifecycle record per issue she works on, kept across restarts:
// what state it's in, every transition with its evidence, and a retry
// budget. It only records and advises -- it never opens a PR, merges,
// deploys or reverts; those stay with self-work's own steps and my
// approvals -- so a restart can't repeat a side effect.
const fs = require("fs");
const path = require("path");

const MAX_RECORDS = 200;
const MAX_HISTORY = 30;
// Run ends that count against the budget; paused (game, RAM) and stopped
// (me) don't.
const FAILED = new Set(["not-done", "tests-failing", "failed", "stuck"]);
// States the idle picker leaves alone until I act.
const HOLD = new Set(["needs-you", "exhausted", "regressed"]);

// lessons: #1385's store (list()); an issue out of tries quotes its lesson.
function createLifecycle({ file, now = () => new Date().toISOString(), maxAttempts = 2, lessons = null } = {}) {
  let data = { version: 1, records: {} };
  try {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A broken file starts fresh rather than stopping self-work.
  }

  function save() {
    const ids = Object.keys(data.records);
    if (ids.length > MAX_RECORDS) {
      // Oldest finished ones go first; held ones (waiting on me) stay.
      const drop = ids
        .filter((id) => !HOLD.has(data.records[id].state))
        .sort((a, b) => String(data.records[a].updatedAt).localeCompare(String(data.records[b].updatedAt)))
        .slice(0, ids.length - MAX_RECORDS);
      for (const id of drop) delete data.records[id];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  function move(issue, state, why, extra = {}) {
    const key = String(issue);
    const r = (data.records[key] ||= { issue: Number(issue), title: null, state: null, attempts: 0, prs: [], history: [] });
    Object.assign(r, extra, { state, updatedAt: now() });
    r.history.push({ at: r.updatedAt, state, why: String(why || "").slice(0, 300) });
    if (r.history.length > MAX_HISTORY) r.history.splice(0, r.history.length - MAX_HISTORY);
    save();
    return r;
  }

  // From self-work's end notice: run = { issue, title, state, prUrl, kind, step }.
  function onRunEnd(run) {
    if (!run?.issue || !run.state) return null;
    const r = data.records[String(run.issue)];
    const title = run.title || r?.title || null;
    const pr = Number(String(run.prUrl || "").match(/\/pull\/(\d+)/)?.[1]) || null;
    const prs = [...new Set([...(r?.prs || []), ...(pr ? [pr] : [])])];
    const why = run.step || run.state;
    if (["pr-open", "pr-updated", "up-to-date"].includes(run.state)) return move(run.issue, "pr-open", why, { title, prs });
    if (run.state === "needs-you") return move(run.issue, "needs-you", why, { title, prs });
    if (FAILED.has(run.state)) {
      const attempts = (r?.attempts || 0) + 1;
      const state = attempts >= maxAttempts ? "exhausted" : "retry";
      const note = state === "exhausted" ? `tried ${attempts} times; ${lessonOf(run.issue)}last: ${why}` : why;
      return move(run.issue, state, note, { title, prs, attempts });
    }
    // no-change, stopped, paused: recorded, not counted.
    return move(run.issue, run.state === "no-change" ? "no-change" : "waiting", why, { title, prs });
  }

  // Her open lesson on the issue, quoted briefly, or "".
  function lessonOf(issue) {
    try {
      const l = lessons?.list().find((x) => x.issue === Number(issue) && x.status === "open");
      const said = l && (l.hypothesis ? `${l.hypothesis} (unverified)` : l.observed.at(-1));
      return said ? `lesson: ${String(said).slice(0, 150)}; ` : "";
    } catch {
      return "";
    }
  }

  // From offerUpdate's merged list: { number, headRefName, mergeCommit }.
  function onMerged(pr) {
    const issue = Number(/^mana\/(\d+)-/.exec(pr?.headRefName || "")?.[1]);
    if (!issue || data.records[String(issue)]?.state === "merged") return null;
    const r = data.records[String(issue)];
    if (r && ["verified", "regressed"].includes(r.state)) return null;
    // #1407: the merge commit tells the post-deploy eval when her live copy runs it.
    const mergeCommit = pr.mergeCommit?.oid || null;
    return move(issue, "merged", `PR #${pr.number} merged`, { prs: [...new Set([...(r?.prs || []), pr.number])], mergeCommit });
  }

  // A behaviour-eval or bench report.json after the merge is running:
  // its gate decides verified or regressed (regressed waits for me; the
  // revert route is how I recover).
  function verify(issue, report) {
    const r = data.records[String(issue)];
    if (!r) return null;
    const passed = report?.gate ? report.gate.passed === true : null;
    if (passed === null) return move(issue, r.state, "verification report had no gate, so nothing changed");
    const where = report.label ? ` (${report.label})` : "";
    return passed
      ? move(issue, "verified", `evaluation gate passed${where}`)
      : move(issue, "regressed", `evaluation gate failed${where}: ${(report.gate.failures || []).slice(0, 3).join("; ")}`);
  }

  // Why the idle picker should leave an issue alone, or null.
  function skip(issue) {
    const r = data.records[String(issue)];
    if (!r || !HOLD.has(r.state)) return null;
    return `${r.state}: ${r.history.at(-1)?.why || ""}`;
  }

  // "Try that again": I clear the hold and the budget.
  function retry(issue) {
    const r = data.records[String(issue)];
    if (!r) return null;
    return move(issue, "retry", "I asked for another try", { attempts: 0 });
  }

  const list = () => Object.values(data.records).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const get = (issue) => data.records[String(issue)] || null;

  return { onRunEnd, onMerged, verify, skip, retry, list, get };
}

module.exports = { createLifecycle, FAILED, HOLD };
