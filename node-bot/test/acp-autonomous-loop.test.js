const assert = require("node:assert/strict");
const test = require("node:test");

const { createAcpAutonomousLoop } = require("../acp-autonomous-loop");

test("autonomous loop refuses to run when disabled", async () => {
  const loop = createAcpAutonomousLoop({ autonomousEnabled: false });

  await assert.rejects(
    () => loop.run({ objective: "fix tests", workspacePath: "C:\\ManaAI\\Mana" }),
    /autonomous mode is disabled/i,
  );
});

test("autonomous loop refuses to run without a workspace", async () => {
  const loop = createAcpAutonomousLoop({ autonomousEnabled: true });

  await assert.rejects(
    () => loop.run({ objective: "fix tests" }),
    /workspace is required/i,
  );
});

test("autonomous loop applies proposals and runs allowed tests", async () => {
  const calls = [];
  const loop = createAcpAutonomousLoop({
    autonomousEnabled: true,
    maxIterations: 2,
    backendBridge: {
      reply: async () => JSON.stringify({
        summary: "Update app.js and run tests.",
        proposals: [
          { path: "app.js", proposedContent: "new code", summary: "update app" },
        ],
        testCommand: "node --test",
        done: true,
      }),
      createEditProposal: async (proposal) => {
        calls.push({ type: "proposal", proposal });
        return { proposal: { id: "proposal-1", relativePath: proposal.path } };
      },
      approveEditProposal: async (id) => {
        calls.push({ type: "approve", id });
        return { proposal: { id, status: "applied" } };
      },
    },
    testRunner: {
      run: async (command, options) => {
        calls.push({ type: "test", command, options });
        return { ok: true, exitCode: 0, stdout: "pass", stderr: "" };
      },
    },
  });

  const result = await loop.run({
    objective: "fix tests",
    workspacePath: "C:\\ManaAI\\Mana",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 1);
  assert.equal(result.proposalsApplied.length, 1);
  assert.equal(result.testRuns[0].ok, true);
  assert.deepEqual(calls.map((call) => call.type), ["proposal", "approve", "test"]);
});

test("autonomous loop stops when model response is not parseable", async () => {
  const loop = createAcpAutonomousLoop({
    autonomousEnabled: true,
    backendBridge: {
      reply: async () => "I need more context.",
    },
    testRunner: {
      run: async () => {
        throw new Error("not called");
      },
    },
  });

  const result = await loop.run({
    objective: "fix tests",
    workspacePath: "C:\\ManaAI\\Mana",
  });

  assert.equal(result.status, "stopped");
  assert.match(result.summary, /I need more context/);
});
