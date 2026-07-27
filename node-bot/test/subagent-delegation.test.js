const assert = require("node:assert/strict");
const test = require("node:test");

const { runWithBoundedConcurrency, DEFAULT_MAX_CONCURRENCY } = require("../tools/subagent-delegation");

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("runWithBoundedConcurrency returns each task's result in original order regardless of completion order", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const tasks = [
    async () => {
      await gates[0].promise;
      return "first";
    },
    async () => {
      await gates[1].promise;
      return "second";
    },
    async () => {
      await gates[2].promise;
      return "third";
    },
  ];

  const runPromise = runWithBoundedConcurrency(tasks, { maxConcurrency: 3 });
  // Resolve out of order: task 2 first, then 0, then 1.
  gates[2].resolve();
  gates[0].resolve();
  gates[1].resolve();

  const results = await runPromise;
  assert.deepEqual(
    results.map((r) => r.value),
    ["first", "second", "third"],
  );
});

test("runWithBoundedConcurrency never runs more than maxConcurrency tasks at once", async () => {
  let inFlight = 0;
  let maxObservedInFlight = 0;
  const tasks = Array.from({ length: 6 }, () => async () => {
    inFlight += 1;
    maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return "done";
  });

  await runWithBoundedConcurrency(tasks, { maxConcurrency: 2 });
  assert.equal(maxObservedInFlight, 2);
});

test("runWithBoundedConcurrency isolates a failing task without affecting the others", async () => {
  const tasks = [
    async () => "ok-1",
    async () => {
      throw new Error("task blew up");
    },
    async () => "ok-2",
  ];

  const results = await runWithBoundedConcurrency(tasks, { maxConcurrency: 3 });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].value, "ok-1");
  assert.equal(results[1].ok, false);
  assert.match(results[1].error.message, /task blew up/);
  assert.equal(results[2].ok, true);
  assert.equal(results[2].value, "ok-2");
});

test("runWithBoundedConcurrency defaults maxConcurrency when not provided or invalid", async () => {
  assert.equal(DEFAULT_MAX_CONCURRENCY, 3);
  const results = await runWithBoundedConcurrency([async () => "x"], { maxConcurrency: 0 });
  assert.equal(results[0].value, "x");
});

test("runWithBoundedConcurrency handles an empty task list", async () => {
  const results = await runWithBoundedConcurrency([]);
  assert.deepEqual(results, []);
});

test("runWithBoundedConcurrency calls onTaskSettled once per task with its index and result", async () => {
  const settled = [];
  await runWithBoundedConcurrency(
    [async () => "a", async () => "b"],
    { maxConcurrency: 2, onTaskSettled: (i, result) => settled.push({ i, result }) },
  );
  assert.equal(settled.length, 2);
  const byIndex = Object.fromEntries(settled.map((s) => [s.i, s.result]));
  assert.equal(byIndex[0].value, "a");
  assert.equal(byIndex[1].value, "b");
});
