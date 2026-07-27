// A minimal, flat delegation primitive: run a batch of independent async
// tasks with a hard cap on how many run at once. Each task is fully
// isolated -- it gets no reference to the others, can't spawn further
// tasks of its own (nothing here gives it the means to), and only its own
// settled result re-enters the caller. Deliberately not a general-purpose
// subagent framework: no shared context, no memory/skills access, one
// level deep only. First (and, for now, only) caller is
// tools/deep-research.js's source-reading step.
const DEFAULT_MAX_CONCURRENCY = 3;

// tasks: array of () => Promise<T>. Returns an array of
// { ok: true, value } | { ok: false, error }, one per task, in the same
// order as `tasks` -- stable regardless of which task actually finishes
// first, so a caller assigning position-based metadata (e.g. citation
// numbers) doesn't need to worry about completion order.
async function runWithBoundedConcurrency(tasks, options = {}) {
  const maxConcurrency = Math.max(
    1,
    Number(options.maxConcurrency) || DEFAULT_MAX_CONCURRENCY,
  );
  const onTaskSettled = typeof options.onTaskSettled === "function" ? options.onTaskSettled : null;

  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= tasks.length) return;
      let settled;
      try {
        settled = { ok: true, value: await tasks[i]() };
      } catch (e) {
        settled = { ok: false, error: e };
      }
      results[i] = settled;
      if (onTaskSettled) onTaskSettled(i, settled);
    }
  }

  const workerCount = Math.min(maxConcurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

module.exports = { runWithBoundedConcurrency, DEFAULT_MAX_CONCURRENCY };
