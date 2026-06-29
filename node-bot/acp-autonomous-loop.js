function parseActionResponse(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function createAcpAutonomousLoop(options = {}) {
  const autonomousEnabled = options.autonomousEnabled === true;
  const maxIterations = Math.max(1, Number(options.maxIterations || 3));
  const maxFilesChanged = Math.max(1, Number(options.maxFilesChanged || 5));
  const backendBridge = options.backendBridge;
  const testRunner = options.testRunner;

  async function run({ objective, workspacePath } = {}) {
    if (!autonomousEnabled) {
      throw new Error("autonomous mode is disabled");
    }
    if (!workspacePath) {
      throw new Error("workspace is required for autonomous mode");
    }
    if (!backendBridge?.reply) {
      throw new Error("backend bridge is required");
    }

    const proposalsApplied = [];
    const testRuns = [];
    let summary = "";

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const prompt = [
        "You are Mana's local coding loop.",
        `Objective: ${objective}`,
        `Workspace: ${workspacePath}`,
        "Return JSON with optional proposals, optional testCommand, optional summary, and done boolean.",
      ].join("\n");
      const reply = await backendBridge.reply(prompt, "coding");
      const action = parseActionResponse(reply);
      if (!action) {
        return {
          status: "stopped",
          iterations: iteration,
          proposalsApplied,
          testRuns,
          summary: String(reply || ""),
        };
      }

      summary = String(action.summary || summary || "");
      const proposals = Array.isArray(action.proposals) ? action.proposals : [];
      if (proposalsApplied.length + proposals.length > maxFilesChanged) {
        throw new Error("autonomous file change limit exceeded");
      }

      for (const proposal of proposals) {
        const created = await backendBridge.createEditProposal(proposal);
        const proposalId = created?.proposal?.id;
        const applied = await backendBridge.approveEditProposal(proposalId);
        proposalsApplied.push(applied.proposal || { id: proposalId });
      }

      if (action.testCommand) {
        if (!testRunner?.run) {
          throw new Error("test runner is required");
        }
        testRuns.push(await testRunner.run(action.testCommand, { cwd: workspacePath }));
      }

      if (action.done === true) {
        return {
          status: "completed",
          iterations: iteration,
          proposalsApplied,
          testRuns,
          summary,
        };
      }
    }

    return {
      status: "stopped",
      iterations: maxIterations,
      proposalsApplied,
      testRuns,
      summary: summary || "Autonomous loop stopped after reaching the iteration limit.",
    };
  }

  return {
    maxFilesChanged,
    maxIterations,
    run,
  };
}

module.exports = {
  createAcpAutonomousLoop,
  parseActionResponse,
};
