function createGoalReview(context) {
// Issue #676: goal mode's nudge when the model answers without a tool.
  function goalRecheckMessage(goal, missing = []) {
    const stillMissing = missing.length ? `\nStill missing: ${missing.join("; ")}` : "";
    return {
      role: "user",
      content: `Goal: ${goal}${stillMissing}\nIf it's done, call ${context.SESSION_GOAL_FINISH_TOOL_NAME} with the reason; otherwise do the next step.`,
    };
  }

function goalEvidence(goal, calls, toolNames) {
    const lastIndex = (pred) => calls.reduce((found, c, i) => (pred(c) ? i : found), -1);
    const lastEdit = lastIndex((c) => c.name === context.CODING_EDIT_TOOL_NAME && c.status === "ok");
    const lastTest = lastIndex((c) => c.name === context.CODING_TEST_TOOL_NAME && typeof c.passed === "boolean");
    const gaps =
      lastEdit < 0 && toolNames.includes(context.CODING_EDIT_TOOL_NAME) && context.EDIT_GOAL_RE.test(goal)
        ? [`no edit was made yet (${context.CODING_EDIT_TOOL_NAME} never succeeded)`]
        : [];
    let tests = "";
    if (lastTest >= 0 && lastTest > lastEdit) {
      const output = (() => {
        try {
          return String(JSON.parse(calls[lastTest].result).output || "");
        } catch (e) {
          return "";
        }
      })();
      tests = `Latest test run, after the last edit: ${calls[lastTest].passed ? "passed" : "FAILED"}\n${output.slice(-1500)}`;
    } else if (toolNames.includes(context.CODING_TEST_TOOL_NAME)) {
      tests = "Tests: not run since the last edit.";
    }
    return { gaps, tests };
  }

// Issue #676: one schema-constrained call (same shape as repairToolCalls)
  // asking whether the draft actually does what was asked. Returns
  // {complete, missing[]}, or null when the check itself fails -- a broken
  // review must never block or rewrite the answer. #787: an evidence gap
  // decides first; the model sees each call's actual result and the latest
  // test run, not just that the calls ran.
  async function reviewGoalCompletion({ prompt, goal, toolCalls, toolNames, draft, maxTokens, profile }) {
    const { gaps, tests } = goalEvidence(goal, toolCalls, toolNames);
    if (gaps.length) return { complete: false, missing: gaps, evidence: true };
    const calls = toolCalls
      .map(
        (c) =>
          `- ${c.name}(${JSON.stringify(c.args || {}).slice(0, 200)}) ${c.ok ? "ok" : `error: ${c.error}`}` +
          (c.result ? `\n  result: ${c.result.slice(0, 800)}` : ""),
      )
      .join("\n") || "(none)";
    try {
      await context.ensureServer(profile);
      const resp = await context.fetchImpl(`http://127.0.0.1:${context.state.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: "You check whether a task was actually done as asked. Judge only from the tool calls, their results and the draft answer; a claim in the draft that no tool result backs is unverified. If the latest test run failed on something the goal covers, that part is not done. List each requested thing that is missing or unverified.",
            },
            {
              role: "user",
              content: `Request:\n${prompt}\n\nGoal:\n${goal}\n\nTool calls made:\n${calls}${tests ? `\n\n${tests}` : ""}\n\nDraft answer:\n${draft}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "goal_review",
              schema: {
                type: "object",
                properties: {
                  complete: { type: "boolean" },
                  missing: { type: "array", items: { type: "string" } },
                },
                required: ["complete", "missing"],
              },
            },
          },
          ...context.buildSamplingParams({ profile, task: "tools", maxTokens, env: context.env }).params,
        }),
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      const parsed = JSON.parse(json?.choices?.[0]?.message?.content || "");
      if (typeof parsed.complete !== "boolean") return null;
      const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
        .map((m) => String(m).trim())
        .filter(Boolean);
      return { complete: parsed.complete, missing };
    } catch (e) {
      return null;
    }
  }

  return { goalRecheckMessage, goalEvidence, reviewGoalCompletion };
}

module.exports = { createGoalReview };
