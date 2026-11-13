// #1467: the benchmark's "Pro orchestrates, Flash works" setup. The orchestrator model runs her loop with every tool except
// editing, plus self_work__delegate({brief}); a delegation runs a worker model's loop in the same worktree with the full
// tools. Both go through the one real tool policy, so her plan gates, the hidden-test guard and the test sandbox apply to the
// worker's edits exactly as to any run's. The worker's "finish" is its own (it ends the worker's loop) and never reaches the
// real run: only the orchestrator finishes the case.
const { CODING_EDIT_TOOL_NAME, CODING_TEST_TOOL_NAME } = require("../ai/coding-tool-source");
const { SESSION_GOAL_FINISH_TOOL_NAME } = require("../ai/session-goal-tool-source");
const { DELETE_TOOL_NAME } = require("../self-work");
const WRITE_TOOLS = new Set([CODING_EDIT_TOOL_NAME, DELETE_TOOL_NAME]);

const DELEGATE_TOOL = "self_work__delegate";
const DELEGATE_SCHEMA = {
  type: "function",
  function: {
    name: DELEGATE_TOOL,
    description: "Hand one piece of the work to a worker that makes the edits and runs the tests. Write a brief it can follow without asking: the files to change, exactly what to change in each, and the tests that must pass. You cannot edit yourself. Returns {status: done|stuck|no-changes, summary, files, lastTest}; check it, then delegate the next piece or a fix.",
    parameters: { type: "object", properties: { brief: { type: "string", description: "What the worker should do, with the files and tests named." } }, required: ["brief"] },
  },
};

const parse = (text) => {
  try {
    return JSON.parse(String(text)) || {};
  } catch {
    return {};
  }
};

// orchestratorLoop / workerLoop: (prompt, policy, opts) => reply, her runToolAwareReply on each model. Returns the same
// shape of function for the orchestrator. onDelegate({ brief, status, files }) sees each delegation.
function orchestrate({ orchestratorLoop, workerLoop, onDelegate = null }) {
  return async function runLoop(prompt, policy, opts = {}) {
    async function delegate({ brief } = {}) {
      const text = String(brief || "").trim();
      const result = (status, summary, files = [], lastTest = null) => {
        onDelegate?.({ brief: text, status, files });
        return JSON.stringify({ status, summary, files, lastTest });
      };
      if (!text) return result("no-changes", "The brief was empty, so no worker was started.");
      const seen = { edits: new Set(), lastTest: null, blocked: false, finished: false };
      const workerPolicy = {
        ...policy,
        async executeTool(name, args) {
          if (name === SESSION_GOAL_FINISH_TOOL_NAME) {
            seen.finished = true;
            return JSON.stringify({ status: "ok", finished: true });
          }
          const out = await policy.executeTool(name, args);
          const parsed = parse(out);
          if (parsed.status === "blocked") seen.blocked = true;
          if (WRITE_TOOLS.has(name) && parsed.status === "ok" && args?.path) seen.edits.add(args.path);
          if (name === CODING_TEST_TOOL_NAME && typeof parsed.passed === "boolean") seen.lastTest = { passed: parsed.passed, output: String(parsed.output || "").slice(-1500) };
          return out;
        },
      };
      const workerPrompt = `${prompt}\n\nYour part of the work, from the engineer who designed it:\n${text}\n\nMake exactly these changes and run the tests that cover them. When they pass, call ${SESSION_GOAL_FINISH_TOOL_NAME} with what you changed.`;
      let reply = null;
      let failure = "";
      try {
        reply = await workerLoop(workerPrompt, workerPolicy, { ...opts, goal: `Do this piece of the work: ${text.slice(0, 300)}` });
      } catch (e) {
        failure = `The worker failed: ${e.message}`;
      }
      const files = [...seen.edits];
      const summary = failure || String(reply?.content || "").trim().slice(0, 1500);
      const status = failure || seen.blocked ? "stuck" : !files.length ? "no-changes" : seen.finished ? "done" : "stuck";
      return result(status, summary, files, seen.lastTest);
    }

    const orchestratorPolicy = {
      ...policy,
      tools: [...policy.tools.filter((t) => !WRITE_TOOLS.has(t.function?.name)), DELEGATE_SCHEMA],
      isKnownTool: (name) => name === DELEGATE_TOOL || Boolean(policy.isKnownTool?.(name)),
      async executeTool(name, args) {
        if (name === DELEGATE_TOOL) return delegate(args);
        if (WRITE_TOOLS.has(name)) throw new Error("you can't edit files in this setup: write a brief and delegate the change with self_work__delegate");
        return policy.executeTool(name, args);
      },
    };
    return orchestratorLoop(prompt, orchestratorPolicy, opts);
  };
}

module.exports = { orchestrate, DELEGATE_TOOL, DELEGATE_SCHEMA };
