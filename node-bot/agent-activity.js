// #646: what the chat tool loop is doing right now, for the launcher's
// activity panel (GET /agent/activity), plus a way to stop a run
// (POST /agent/stop). In memory only: a run lives for one tool-aware reply.
// #1318: each run keeps its steps (description, kind, status, duration,
// command, trimmed result) for the chat's step lines and Background tasks'
// transcript; the last few finished runs stay listed as done.
const MAX_STEPS = 50;
const MAX_RECENT = 5;

function createAgentActivity({ now = Date.now } = {}) {
  const runs = new Map();
  const recent = [];
  let latest = null;
  let nextId = 1;
  const iso = (ms) => new Date(ms).toISOString();

  function start({ model = null } = {}) {
    const run = {
      id: String(nextId++),
      startedAt: now(),
      endedAt: null,
      model,
      tokens: null,
      tool: null,
      toolStartedAt: null,
      toolCount: 0,
      lastTool: null,
      stopRequested: false,
      steps: [],
    };
    runs.set(run.id, run);
    latest = run;
    return run;
  }

  function finish(run) {
    runs.delete(run.id);
    run.endedAt = now();
    if (run.toolCount === 0) return;
    recent.unshift(run);
    recent.length = Math.min(recent.length, MAX_RECENT);
  }

  // info: stepInfo() from ai/step-description.js (already sanitized).
  function toolStarted(run, name, info = {}) {
    run.tool = name;
    run.toolStartedAt = now();
    run.toolCount += 1;
    const step = {
      id: `s${run.toolCount}`,
      kind: "tool",
      tool: name,
      ...info,
      status: "running",
      startedAt: iso(run.toolStartedAt),
      endedAt: null,
    };
    run.steps.push(step);
    if (run.steps.length > MAX_STEPS) run.steps.shift();
    return step;
  }

  function current(run) {
    const step = run.steps[run.steps.length - 1];
    return step && !step.endedAt ? step : null;
  }

  // waiting: the step is held in the approval queue.
  function toolWaiting(run, waiting) {
    const step = current(run);
    if (step) step.status = waiting ? "awaiting_approval" : "running";
    return step;
  }

  function toolEnded(run, name, { ok = true, result, tokens } = {}) {
    const step = current(run);
    if (step) {
      step.status = ok ? "done" : "failed";
      step.endedAt = iso(now());
      if (result) step.detail = { ...step.detail, resultPreview: result };
    }
    if (Number.isFinite(tokens)) run.tokens = tokens;
    run.tool = null;
    run.toolStartedAt = null;
    run.lastTool = name;
    return step;
  }

  // False when the run already ended (or never existed).
  function stop(id) {
    const run = runs.get(id);
    if (!run) return false;
    run.stopRequested = true;
    return true;
  }

  function summary(run, at) {
    const step = current(run);
    return {
      id: run.id,
      elapsedMs: (run.endedAt ?? at) - run.startedAt,
      startedAt: iso(run.startedAt),
      endedAt: run.endedAt === null ? null : iso(run.endedAt),
      tool: run.tool,
      toolElapsedMs: run.toolStartedAt === null ? null : at - run.toolStartedAt,
      toolCount: run.toolCount,
      lastTool: run.lastTool,
      // The current step's description, else the last one's.
      description: (step || run.steps[run.steps.length - 1])?.description || null,
      waiting: step?.status === "awaiting_approval",
      model: run.model,
      tokens: run.tokens,
      stopping: run.stopRequested,
    };
  }

  // Only runs that have called a tool: a plain chat reply isn't "work".
  function list() {
    const at = now();
    return [...runs.values()].filter((run) => run.toolCount > 0).map((run) => summary(run, at));
  }

  // Finished runs, newest first, for Background tasks.
  function listRecent() {
    const at = now();
    return recent.map((run) => summary(run, at));
  }

  // The current (else last) chat reply's steps, for the chat's step lines.
  function latestSteps() {
    if (!latest) return { runId: null, running: false, steps: [] };
    return { runId: latest.id, running: runs.has(latest.id), steps: steps(latest.id) || [] };
  }

  // A run's step log (live or recently finished), or null.
  function steps(id) {
    const run = runs.get(id) || recent.find((r) => r.id === id);
    return run ? run.steps.map((step) => ({ ...step, detail: step.detail && { ...step.detail } })) : null;
  }

  return { start, finish, toolStarted, toolWaiting, toolEnded, stop, list, listRecent, latestSteps, steps };
}

module.exports = { createAgentActivity };
