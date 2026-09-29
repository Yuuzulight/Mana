// #646: what the chat tool loop is doing right now, for the launcher's
// activity panel (GET /agent/activity), plus a way to stop a run
// (POST /agent/stop). In memory only: a run lives for one tool-aware reply.
function createAgentActivity({ now = Date.now } = {}) {
  const runs = new Map();
  let nextId = 1;

  function start() {
    const run = {
      id: String(nextId++),
      startedAt: now(),
      tool: null,
      toolStartedAt: null,
      toolCount: 0,
      lastTool: null,
      stopRequested: false,
    };
    runs.set(run.id, run);
    return run;
  }

  function finish(run) {
    runs.delete(run.id);
  }

  function toolStarted(run, name) {
    run.tool = name;
    run.toolStartedAt = now();
    run.toolCount += 1;
  }

  function toolEnded(run, name) {
    run.tool = null;
    run.toolStartedAt = null;
    run.lastTool = name;
  }

  // False when the run already ended (or never existed).
  function stop(id) {
    const run = runs.get(id);
    if (!run) return false;
    run.stopRequested = true;
    return true;
  }

  // Only runs that have called a tool: a plain chat reply isn't "work".
  function list() {
    const at = now();
    return [...runs.values()]
      .filter((run) => run.toolCount > 0)
      .map((run) => ({
        id: run.id,
        elapsedMs: at - run.startedAt,
        tool: run.tool,
        toolElapsedMs: run.toolStartedAt === null ? null : at - run.toolStartedAt,
        toolCount: run.toolCount,
        lastTool: run.lastTool,
        stopping: run.stopRequested,
      }));
  }

  return { start, finish, toolStarted, toolEnded, stop, list };
}

module.exports = { createAgentActivity };
