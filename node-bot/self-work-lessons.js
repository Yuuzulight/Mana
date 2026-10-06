"use strict";

// #1385: what Mana's self-work runs leave behind when they don't end in a
// PR (or the PR is refuted or reverted): one record per issue with the
// observed facts apart from her own unverified guess. A guess never becomes
// a standing rule except through my approval (the gate's "self-work-lesson",
// always reviewed, never granted).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { sanitizeBridgeOutput } = require("./bridge-output-sanitizer");

const ACTION = "self-work-lesson";
// Ends worth a lesson; paused and stopped are mine or the machine's, not hers.
const RECORDED = new Set(["not-done", "tests-failing", "needs-you", "failed", "stuck"]);
const MAX_TEXT = 500;
const MAX_OBSERVED = 20;
const MAX_OCCURRENCES = 20;
const MAX_LESSONS = 5;
const MAX_PROMPT_CHARS = 1200;
const MAX_RULES_CHARS = 600;

function createLessons({ file, now = () => new Date().toISOString(), approvalGate = null, env = process.env, max = 200 } = {}) {
  const clean = (s) => sanitizeBridgeOutput(String(s ?? ""), { env }).trim().slice(0, MAX_TEXT);

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.lessons) ? data.lessons : [];
    } catch {
      return [];
    }
  }
  function save(lessons) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, lessons }, null, 1));
    fs.renameSync(tmp, file);
  }

  // The facts of a run, from the run itself: none of it is the model's explanation.
  function observe(run, label, text, kind, extra) {
    const out = [`The run ended "${label}": ${clean(text)}`];
    for (const a of run.attempts || []) {
      const names = a.failing?.length ? ` (${a.failing.join("; ")})` : "";
      out.push(`Attempt ${a.attempt}: ${a.finished ? "finished" : "not finished"}, ${a.passed ? "tests passing" : `${a.failures} failing${names}`}`);
    }
    if (run.refuted) out.push(`My reviewer refuted my change to ${run.refuted.path}: ${run.refuted.failingCase}`);
    if (kind === "revert") out.push(`PR #${extra.pr} was reverted.`);
    else if (!run.prUrl && !run.pr) out.push("No PR was opened.");
    return out.map(clean).filter(Boolean);
  }

  // run: { issue, title, attempts?, refuted?, prUrl?, pr?, finalWords?, kind? }.
  // A repeat on an issue with an open lesson adds to that lesson.
  function record(run, state, text, extra = {}) {
    const kind = extra.kind || (run.kind === "refresh" ? "refresh" : "run");
    let label = state;
    if (kind !== "revert") {
      if (state === "pr-open" && run.refuted) label = "pr-open-refuted";
      else if (!RECORDED.has(state)) return null;
    }
    if (!Number.isInteger(run.issue)) return null;
    const at = now();
    const occurrence = { at, state: label, kind, ...(extra.pr ? { pr: extra.pr } : {}), ...(extra.baseCommit ? { baseCommit: clean(extra.baseCommit) } : {}) };
    const observed = observe(run, label, text, kind, extra);
    // Her own last words about it: kept, but only ever as a guess.
    const hypothesis = clean(run.finalWords) || null;
    const lessons = load();
    let lesson = lessons.find((l) => l.issue === run.issue && l.status === "open");
    if (lesson) {
      lesson.lastAt = at;
      lesson.occurrences = [...lesson.occurrences, occurrence].slice(-MAX_OCCURRENCES);
      lesson.observed = [...new Set([...lesson.observed, ...observed])].slice(-MAX_OBSERVED);
      if (hypothesis) lesson.hypothesis = hypothesis;
    } else {
      lesson = {
        id: crypto.randomBytes(4).toString("hex"),
        issue: run.issue,
        title: clean(run.title),
        firstAt: at,
        lastAt: at,
        occurrences: [occurrence],
        observed: observed.slice(-MAX_OBSERVED),
        hypothesis,
        prevention: null,
        confidence: "low",
        status: "open",
      };
      lessons.push(lesson);
    }
    // Oldest first out; promoted ones stay.
    for (let i = 0; lessons.length > max && i < lessons.length; ) {
      if (lessons[i].status === "promoted" || lessons[i] === lesson) i++;
      else lessons.splice(i, 1);
    }
    save(lessons);
    return lesson;
  }

  const list = () => load();

  // Open lessons on this issue or on files it names, as a bounded prompt block.
  function forIssue(issue, paths = []) {
    const needles = paths.filter((p) => typeof p === "string" && p.length >= 3);
    const hits = load()
      .filter((l) => l.status === "open" && (l.issue === issue || needles.some((p) => l.observed.some((o) => o.includes(p)))))
      .sort((a, b) => (b.issue === issue) - (a.issue === issue) || b.lastAt.localeCompare(a.lastAt))
      .slice(0, MAX_LESSONS);
    const lines = [];
    let used = 0;
    for (const l of hits) {
      if (MAX_PROMPT_CHARS - used < 40) break;
      const line =`- #${l.issue}: earlier runs on this: observed - ${l.observed.join("; ")}${l.hypothesis ? `; my guess then (unverified) - ${l.hypothesis}` : ""}`.slice(0, MAX_PROMPT_CHARS - used - 1);
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  // Only the gate's executor below ever makes a lesson a rule.
  function applyPromotion({ id, rule }) {
    const lessons = load();
    const lesson = lessons.find((l) => l.id === id);
    if (!lesson || lesson.status !== "open") throw new Error(`lesson ${id} isn't open`);
    lesson.status = "promoted";
    lesson.rule = clean(rule);
    lesson.promotedAt = now();
    save(lessons);
    return { id, status: "promoted" };
  }
  approvalGate?.registerExecutor?.(ACTION, applyPromotion);

  // Asks me; returns the gate's answer (pending until I decide). Her
  // hypothesis is not the rule: the rule text is the one I read and approve.
  async function promote(id, rule) {
    const lesson = load().find((l) => l.id === id);
    if (!lesson || lesson.status !== "open") return { ok: false, error: `No open lesson ${id}.` };
    const text = clean(rule);
    if (!text) return { ok: false, error: "Give me the rule's text." };
    if (!approvalGate) return { ok: false, error: "No approval gate." };
    return approvalGate.requestApproval(ACTION, {
      summary: `Make this a standing rule for my self-work: ${text}`,
      payload: { id, rule: text },
      forceReview: true,
    });
  }

  // Never deleted: a contradicted lesson stays as evidence.
  function supersede(id, byId) {
    const lessons = load();
    const lesson = lessons.find((l) => l.id === id);
    if (!lesson || id === byId || !lessons.some((l) => l.id === byId)) return { ok: false, error: "Both lessons must exist and differ." };
    lesson.status = "superseded";
    lesson.supersededBy = byId;
    save(lessons);
    return { ok: true };
  }

  function standingRules() {
    const rules = [];
    let used = 0;
    for (const l of load().filter((x) => x.status === "promoted" && x.rule)) {
      if (used + l.rule.length > MAX_RULES_CHARS) break;
      rules.push(l.rule);
      used += l.rule.length;
    }
    return rules;
  }

  return { record, forIssue, list, promote, supersede, standingRules };
}

module.exports = { createLessons, ACTION };
