// #646: what the chat tool loop is doing right now, for the launcher's
// activity panel (GET /agent/activity), plus a way to stop a run
// (POST /agent/stop). In memory only: a run lives for one tool-aware reply.
// #1318: each run keeps its steps (description, kind, status, duration,
// command, trimmed result) for the chat's step lines and Background tasks'
// transcript; the last few finished runs stay listed as done.
// #1337: steps are also saved with the reply's chat turn.
// ponytail: a run keeps its last 200 steps; a longer goal-mode run loses its
// earliest lines (chat and saved turn alike). Page them if that ever bites.
const MAX_STEPS = 200;
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
      // #1318: bumped when reply text shows between tool rounds, so the chat
      // starts a new step group after that text.
      segment: 0,
      // #1337: length of the reply text shown before the current round.
      textOffset: 0,
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
      segment: run.segment,
      textOffset: run.textOffset,
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

  // Reply text between tool rounds: later steps go in a new segment, placed
  // at textOffset (the reply's length so far, #1337).
  function textShown(run, textOffset) {
    const last = run.steps[run.steps.length - 1];
    if (last && last.segment === run.segment) run.segment += 1;
    if (Number.isFinite(textOffset)) run.textOffset = textOffset;
  }

  // waiting: the step is held in the approval queue.
  function toolWaiting(run, waiting) {
    const step = current(run);
    if (step) step.status = waiting ? "awaiting_approval" : "running";
    return step;
  }

  // task: { taskId, title } when the tool started a background task (#1337).
  function toolEnded(run, name, { ok = true, result, tokens, task } = {}) {
    const step = current(run);
    if (step) {
      step.status = ok ? "done" : "failed";
      step.endedAt = iso(now());
      if (result) step.detail = { ...step.detail, resultPreview: result };
      if (task) Object.assign(step, task);
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

  return { start, finish, toolStarted, toolWaiting, toolEnded, textShown, stop, list, listRecent, latestSteps, steps };
}

module.exports = { createAgentActivity };
