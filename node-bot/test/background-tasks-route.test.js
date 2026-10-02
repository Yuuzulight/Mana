// #1124: server.js registers GET /background-tasks behind the admin key,
// with self-work and its stop wired through.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { useTestAdminToken, withServer } = require("./helpers");

const fetch = useTestAdminToken();

test("GET /background-tasks needs the admin key and lists self-work; cancel stops it", async () => {
  let stopped = 0;
  const app = createApp({
    selfWork: {
      status: () => ({ state: "running", issue: 5, title: "Tidy", startedAt: new Date().toISOString(), step: "Reading", round: 2, maxRounds: 20 }),
      stop: () => {
        stopped += 1;
        return true;
      },
      startIdle: async () => ({ ok: false }),
      chatToolSource: () => null,
    },
  });
  await withServer(app, async (base) => {
    assert.equal((await globalThis.fetch(`${base}/background-tasks`)).status, 401);
    const { tasks } = await (await fetch(`${base}/background-tasks`)).json();
    const selfWork = tasks.find((t) => t.id === "self-work");
    assert.equal(selfWork.title, "#5: Tidy");
    assert.deepEqual(selfWork.progress, { done: 2, total: 20, unit: "rounds" });
    assert.equal((await fetch(`${base}/background-tasks/self-work/cancel`, { method: "POST" })).status, 200);
    assert.equal(stopped, 1);
  });
});

// #1318
test("GET /background-tasks/:id/transcript returns a task's steps behind the admin key", async () => {
  const app = createApp({
    selfWork: {
      status: () => ({
        state: "running", issue: 5, title: "Tidy", startedAt: new Date().toISOString(), step: "Reading", round: 1, maxRounds: 20,
        log: [{ at: "2026-10-03T00:00:00.000Z", text: "Reading" }],
      }),
      stop: () => true,
      startIdle: async () => ({ ok: false }),
      chatToolSource: () => null,
    },
  });
  await withServer(app, async (base) => {
    const { tasks } = await (await fetch(`${base}/background-tasks`)).json();
    const selfWork = tasks.find((t) => t.id === "self-work");
    assert.equal(selfWork.currentAction, "Reading");
    assert.equal((await globalThis.fetch(`${base}${selfWork.transcriptUrl}`)).status, 401);
    const transcript = await (await fetch(`${base}${selfWork.transcriptUrl}`)).json();
    assert.deepEqual(transcript.steps.map((s) => [s.description, s.status]), [["Reading", "running"]]);
    assert.equal((await fetch(`${base}/background-tasks/nope/transcript`)).status, 404);
  });
});
