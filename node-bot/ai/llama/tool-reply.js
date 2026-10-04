function createToolReply(context) {
async function runToolAwareReply(
    prompt,
    toolPolicy,
    {
      maxTokens = 512,
      profile = "default",
      overrideSystemPrompt = null,
      maxRounds,
      maxToolCallsPerRound,
      maxMs,
      extraMessages = null,
      // #675: true on a "think harder" turn -- every round thinks. May be a
      // function, read each round: Mana's deep_thinking__set can switch it
      // mid-reply.
      thinking,
      goal = null,
      // #1124: (round, roundLimit) at the start of each round.
      onRound = null,
      // #1318: (text) when a round shows reply text alongside its tool calls.
      onRoundText = null,
    } = {},
  ) {
    if (typeof context.fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    if (!toolPolicy || typeof toolPolicy.executeTool !== "function") {
      throw new Error(
        "runToolAwareReply requires a toolPolicy with executeTool()",
      );
    }
    const startedAt = context.nowMs();
    await context.ensureServer(profile, extraMessages?.images);

    // #1343: Tool execution routes to assistant LoRA
    if (context.state.hasLoraAdapters) {
      await context.applyLoraAdapter("assistant");
    }

    const goalText = String(goal || "").trim();
    const goalMode = Boolean(goalText);
    const roundLimit = Math.max(
      1,
      Number(
        maxRounds ??
          (goalMode ? context.env.MANA_GOAL_MODE_MAX_ROUNDS ?? 30 : context.env.MANA_TOOL_CALLING_MAX_ROUNDS ?? 4),
      ),
    );
    const callsPerRoundLimit = Math.max(
      1,
      Number(maxToolCallsPerRound ?? context.env.MANA_TOOL_CALLING_MAX_CALLS_PER_ROUND ?? 5),
    );
    const timeLimitMs = Math.max(
      1,
      Number(
        maxMs ??
          (goalMode ? context.env.MANA_GOAL_MODE_MAX_MS ?? 600000 : context.env.MANA_TOOL_CALLING_MAX_MS ?? 60000),
      ),
    );
    // Issue #676: a 30-round loop can outgrow the context; stopping first
    // keeps the work instead of a llama-server error discarding it.
    const promptTokenLimit = goalMode ? Math.floor((await context.getContextSize()) * 0.8) : Infinity;
    const deadline = startedAt + timeLimitMs;
    const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

    const messages = context.buildMessages(
      overrideSystemPrompt || context.systemPromptOf(),
      prompt,
      extraMessages,
    );

    async function complete(toolsEnabled) {
      // Issue #417: a tool executed mid-loop (vision__look) can swap the
      // local server to a different model out from under this loop --
      // ensureServer() at the top of runToolAwareReply only confirms the
      // model once, before round 1. Re-ensuring here, on every round, is
      // the root-cause fix: whatever the last tool call left loaded, the
      // configured profile's model is back in place before the next
      // request goes out. On the common no-swap path this is just a cheap
      // isHealthy() check (ensureServerConfig's early-return), not a real
      // restart.
      await context.ensureServer(profile);
      // #675: never DRY/XTC here, and no thinking unless this is a "think
      // harder" turn -- both can break tool-call JSON. When it thinks,
      // llama-server returns the reasoning apart from content and
      // tool_calls (reasoning_content); the loop below never sends it back
      // or parses it, and strips any <think> block left inside content.
      const toolFields = toolsEnabled
        ? { tools: toolPolicy.tools, tool_choice: "auto" }
        : { tool_choice: "none" };
      const think = typeof thinking === "function" ? thinking() : thinking;
      const { params } = context.buildSamplingParams({ profile, task: "tools", maxTokens, thinking: think, env: context.env });
      if (think === true) await context.fitThinkingToContext(params, { messages, ...toolFields });
      const resp = await context.fetchImpl(
        `http://127.0.0.1:${context.state.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, ...toolFields, ...params }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `llama-server reply failed (${resp.status}): ${text.slice(0, 500)}`,
        );
      }
      const json = await resp.json();
      context.logPromptCache("llama-server-tool-reply", json && json.timings);
      return json;
    }

    // #1214: all but the last few tool results, cut to their first lines.
    const trimmed = new context.WeakSet();
    function trimOldToolResults() {
      const results = messages.filter((m) => m.role === "tool");
      for (const m of results.slice(0, -context.KEEP_RECENT_TOOL_RESULTS)) {
        if (trimmed.has(m) || String(m.content).length <= 400) continue;
        m.content = `${String(m.content).slice(0, 200)}\n...[older result trimmed to save room; call the tool again if you need it]`;
        trimmed.add(m);
      }
    }

    const executedToolCalls = [];
    // #787: what each call returned, for the goal review only -- kept out of
    // executedToolCalls, which the caller persists with the turn.
    const reviewLog = [];
    let message = {};
    let rounds = 0;
    let consecutiveToolErrors = 0;
    // Issue #401: set when the model calls session_goal__finish, believing
    // the session's user-stated goal is done. Folded into the existing
    // budgetExhausted check below so a genuine finish reuses the same
    // "force a real final answer now" path the round/time/error caps
    // already use, instead of a second code path.
    let goalFinished = false;
    // Issue #676: goal-mode state, see the header comment.
    let unansweredRechecks = 0;
    let reviewCycles = 0;
    let stalled = false;
    let awaitingApproval = false;
    let promptTokens = 0;
    let notDone = "";
    const outOfBudget = () =>
      rounds >= roundLimit || context.nowMs() > deadline || promptTokens > promptTokenLimit;

    // #898: once per reply, a claim of a memory write that didn't happen
    // goes back to her with memoryClaimNote. Goal mode's own review
    // already checks claims against the tool calls.
    let memoryRechecked = false;
    function recheckMemoryClaim() {
      if (goalMode || memoryRechecked) return false;
      if (!toolPolicy.tools.some((t) => t.function?.name === context.MEMORY_REMEMBER_TOOL)) return false;
      const reply = context.stripThinking(message.content);
      const note = context.memoryClaimNote(reply, reviewLog);
      if (!note) return false;
      memoryRechecked = true;
      messages.push({ role: "assistant", content: reply }, { role: "user", content: note });
      return true;
    }

    // Issue #676: the end of a goal-mode run. True means the review found
    // something missing and there's budget for another cycle.
    async function reviewAndResume() {
      if (!goalMode) return false;
      const review = await context.reviewGoalCompletion({
        prompt,
        goal: goalText,
        toolCalls: reviewLog,
        toolNames: toolPolicy.tools.map((t) => t.function.name),
        draft: context.stripThinking(message.content),
        maxTokens,
        profile,
      });
      notDone = "";
      if (!review || review.complete) return false;
      if (
        // #787: a stall still gets its cycles when the gap is one the run
        // shows outright (no edit made) -- the generic re-checks never said so.
        (stalled && !review.evidence) ||
        awaitingApproval ||
        reviewCycles >= 2 ||
        consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS ||
        outOfBudget()
      ) {
        notDone = review.missing.join("; ") || "the goal isn't finished";
        return false;
      }
      reviewCycles += 1;
      goalFinished = false;
      stalled = false;
      unansweredRechecks = 0;
      messages.push(
        { role: "assistant", content: message.content || "" },
        context.goalRecheckMessage(goalText, review.missing),
      );
      return true;
    }

    for (let round = 1; round <= roundLimit; round += 1) {
      rounds = round;
      onRound?.(round, roundLimit);
      // #1214: past 60% of the context, older tool results shrink to a
      // stub she can fetch again, before the 80% guard ends the run.
      if (goalMode && promptTokens > promptTokenLimit * 0.75) trimOldToolResults();
      let json;
      try {
        json = await complete(true);
      } catch (e) {
        // #1209: a call llama-server couldn't parse (arguments cut off at the
        // token limit, or badly escaped) goes back as a tool error to make
        // again, shorter -- up to the consecutive-error cap.
        const unparsed = /Failed to parse tool call arguments/i.test(e.message);
        if (unparsed && ++consecutiveToolErrors < MAX_CONSECUTIVE_TOOL_ERRORS) {
          messages.push({ role: "user", content: context.TOOL_CALL_UNPARSED_NOTE });
          continue;
        }
        // #787: one round's tool results (file contents, test output) can
        // jump past the 80% guard below and the whole context. Keep the run's
        // work and say why it stopped, rather than failing the reply.
        if (!goalMode || !(unparsed || /exceeds the available context/i.test(e.message))) throw e;
        notDone = unparsed ? "the tool calls kept failing to parse" : "the conversation outgrew the model's context";
        break;
      }
      promptTokens = (Number(json?.timings?.cache_n) || 0) + (Number(json?.timings?.prompt_n) || 0);
      message = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
      const visibleContent = context.stripThinking(message.content);
      let requestedToolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];

      if (!requestedToolCalls.length) {
        requestedToolCalls = context.parseTextToolCalls(visibleContent, toolPolicy.tools);
      }
      if (!requestedToolCalls.length && context.looksLikeFailedToolCallJson(visibleContent)) {
        // #621: deterministic recovery tried before the re-ask -- fixes code fences,
        // doubled braces, trailing commas, and unescaped Windows path backslashes in-process
        const repaired = context.repairToolCallText(visibleContent, toolPolicy.tools);
        if (repaired.length) {
          requestedToolCalls = repaired.map((call, index) => ({
            id: `repair_text_${Date.now()}_${index}`,
            type: "function",
            function: {
              name: call.name,
              arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {}),
            },
          }));
        }
      }
      if (!requestedToolCalls.length && context.looksLikeFailedToolCallJson(visibleContent)) {
        // Issue: this method's own header comment documents that some
        // model/template combos (qwen2.5-coder-7b confirmed) never
        // populate `tool_calls` at all -- they leak the call they meant to
        // make into `content` instead, sometimes malformed (verified
        // directly: a raw request against that exact model returned
        // `content: '{{"name": "get_weather", ...'` -- a literal double
        // brace, not valid JSON). Confirmed the fix empirically before
        // writing this: re-asking with response_format's json_schema
        // constraint reliably produces clean, schema-conforming JSON even
        // from this same broken model/template pair. Only fires when the
        // native path already failed -- the common/working case (e.g. the
        // default profile) never pays for the extra request.
        requestedToolCalls = await context.repairToolCalls(messages, toolPolicy.tools, maxTokens, profile);
      }

      if (!requestedToolCalls.length) {
        // Issue #676: in goal mode a plain reply isn't the end -- re-ask
        // against the goal, until two re-checks in a row go unanswered.
        if (goalMode && !outOfBudget()) {
          if (unansweredRechecks < 2) {
            unansweredRechecks += 1;
            messages.push({ role: "assistant", content: visibleContent }, context.goalRecheckMessage(goalText));
            continue;
          }
          stalled = true;
        }
        if (recheckMemoryClaim()) {
          // She can still call memory__remember; with no rounds left she
          // only gets to correct the reply.
          if (!outOfBudget()) continue;
          message = (await complete(false))?.choices?.[0]?.message || {};
        }
        if (await reviewAndResume()) continue;
        break; // model produced a real answer -- no more tools requested
      }
      unansweredRechecks = 0;

      const boundedCalls = requestedToolCalls.slice(0, callsPerRoundLimit);
      // #1337: awaited, so its sentences go out before this round's tool events.
      if (visibleContent) await onRoundText?.(visibleContent);
      messages.push({
        role: "assistant",
        content: visibleContent || null,
        tool_calls: boundedCalls,
      });

      for (const call of boundedCalls) {
        const name = call.function && call.function.name;
        // #621: arguments that didn't parse, or a required one that didn't
        // arrive, go back as a tool error below; the tool doesn't run.
        const parameters = (toolPolicy.tools || []).find((t) => t?.function?.name === name)?.function?.parameters;
        const checked = context.checkToolCallArgs(call.function && call.function.arguments, parameters);
        const args = checked.args || {};

        let resultText;
        try {
          // Issue #169: await, not a bare call -- an MCP-sourced tool's
          // executeTool() is inherently async (network/child-process I/O),
          // unlike the local read_file tool this loop originally only ever
          // saw. Awaiting a plain (non-Promise) return value is a no-op, so
          // this stays exactly backward-compatible with tool-policy.js's
          // synchronous executeTool().
          // #1258: a call without a required argument (lost in parsing, or
          // cut off at the token limit) goes back saying which, and why.
          const cut = json?.choices?.[0]?.finish_reason === "length" ? ": your reply hit its token limit and the call was cut off" : "";
          if (checked.problem) {
            throw new Error(
              `${name}'s arguments ${checked.problem}${cut}. Make the call again with complete JSON arguments (for a code change, replace only the lines that change).`,
            );
          }
          if (checked.missing.length) {
            throw new Error(
              `${name} needs ${checked.missing.join(", ")}, which didn't arrive${cut}. Make the call again with every required argument (for a code change, give old_text and replace only the lines that change).`,
            );
          }
          const result = await toolPolicy.executeTool(name, args);
          resultText = String(result);
          executedToolCalls.push({ name, args, ok: true });
          let parsed = {};
          try {
            parsed = JSON.parse(resultText) || {};
          } catch (e) {}
          reviewLog.push({ name, args, ok: true, status: parsed.status, passed: parsed.passed, result: resultText });
          consecutiveToolErrors = 0;
          if (name === context.SESSION_GOAL_FINISH_TOOL_NAME) {
            goalFinished = true;
          }
          // Issue #676: a call waiting on a human (#669 approval queue) ends
          // goal mode -- retrying would only queue up more approvals.
          awaitingApproval ||= goalMode && ["pending", "blocked"].includes(parsed.status);
        } catch (e) {
          resultText = `Error: ${e.message}`;
          executedToolCalls.push({ name, args, ok: false, error: e.message });
          reviewLog.push({ name, args, ok: false, error: e.message });
          consecutiveToolErrors += 1;
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultText,
        });
      }

      const budgetExhausted =
        goalFinished ||
        awaitingApproval ||
        outOfBudget() ||
        consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS;
      if (budgetExhausted) {
        // Force a real answer from whatever's been learned so far instead
        // of looping again (or returning nothing) -- tool_choice: "none"
        // means the model cannot request yet another tool call here.
        let finalJson;
        try {
          finalJson = await complete(false);
        } catch (e) {
          // #1214: the forced answer can pass the context too; keep the work.
          if (!goalMode || !/exceeds the available context/i.test(e.message)) throw e;
          notDone = "the conversation outgrew the model's context";
          message = {};
          break;
        }
        message = (finalJson && finalJson.choices && finalJson.choices[0] && finalJson.choices[0].message) || {};
        if (recheckMemoryClaim()) message = (await complete(false))?.choices?.[0]?.message || {};
        if (await reviewAndResume()) continue;
        break;
      }
    }

    const draft = context.stripThinking(message.content);
    const content = notDone ? `Not done yet: ${notDone}${draft ? `\n\n${draft}` : ""}` : draft;

    context.scheduleIdleShutdown();
    context.logPerf("llama-server-tool-reply", startedAt);
    // #1287: and the messages as the model saw them (her self-work traces).
    return { content, toolCalls: executedToolCalls, rounds, messages };
  }

  return { runToolAwareReply };
}

module.exports = { createToolReply };
