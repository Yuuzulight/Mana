// #1467: the two helper calls her tool loop makes besides the model's own turn -- "is it really done?" and repairing a
// tool call that came back unreadable -- on a DeepSeek model instead of her local llama-server, for a run that is all
// API (the bench's). Same signatures and results as goal-review.js and tool-calls.js; any failure gives null / [], so a
// broken helper never blocks or rewrites the run. DeepSeek takes json_object (not a schema), so the shape is in the prompt.
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

function createRemoteHelpers({
  baseUrl, apiKey, model, fetchImpl, goalEvidence, buildToolCallRepairSchema,
  onResponse = null, retries = 2, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;

  // One JSON reply parsed, or null; 2 s doubling between retries of an overloaded API or a network error.
  async function ask(messages, maxTokens) {
    for (let attempt = 0; ; attempt += 1) {
      let resp = null;
      try {
        resp = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, messages, max_tokens: Math.max(500, Number(maxTokens) || 0), thinking: { type: "disabled" }, response_format: { type: "json_object" } }),
        });
      } catch {}
      if (resp?.ok) {
        try {
          const json = await resp.json();
          onResponse?.(json);
          return JSON.parse(json?.choices?.[0]?.message?.content || "");
        } catch {
          return null;
        }
      }
      if (attempt >= retries || (resp && !RETRYABLE.has(resp.status))) return null;
      await sleep(Math.min(60000, 2000 * 2 ** attempt));
    }
  }

  async function reviewGoalCompletion({ prompt, goal, toolCalls, toolNames, draft, maxTokens }) {
    const { gaps, tests } = goalEvidence(goal, toolCalls, toolNames);
    if (gaps.length) return { complete: false, missing: gaps, evidence: true };
    const calls = toolCalls
      .map((c) => `- ${c.name}(${JSON.stringify(c.args || {}).slice(0, 200)}) ${c.ok ? "ok" : `error: ${c.error}`}` + (c.result ? `\n  result: ${c.result.slice(0, 800)}` : ""))
      .join("\n") || "(none)";
    const parsed = await ask([
      {
        role: "system",
        content: "You check whether a task was actually done as asked. Judge only from the tool calls, their results and the draft answer; a claim in the draft that no tool result backs is unverified. If the latest test run failed on something the goal covers, that part is not done. List each requested thing that is missing or unverified. Reply with JSON only: {\"complete\": true or false, \"missing\": [\"each missing or unverified thing\"]}.",
      },
      { role: "user", content: `Request:\n${prompt}\n\nGoal:\n${goal}\n\nTool calls made:\n${calls}${tests ? `\n\n${tests}` : ""}\n\nDraft answer:\n${draft}` },
    ], maxTokens);
    if (!parsed || typeof parsed.complete !== "boolean") return null;
    const missing = (Array.isArray(parsed.missing) ? parsed.missing : []).map((m) => String(m).trim()).filter(Boolean);
    return { complete: parsed.complete, missing };
  }

  async function repairToolCalls(messages, tools, maxTokens) {
    if (!Array.isArray(tools) || !tools.length) return [];
    const schema = buildToolCallRepairSchema(tools);
    const parsed = await ask([
      ...messages,
      { role: "user", content: `Your last reply tried to call a tool but it could not be read. Reply with JSON only: {"tool_calls": [{"name": "<tool name>", "arguments": {...}}]} making the call you meant, with arguments that fit that tool's parameters. The tools and their schemas: ${JSON.stringify(schema)}` },
    ], maxTokens);
    const calls = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls.filter((c) => c && typeof c.name === "string") : [];
    return calls.map((call, index) => ({
      id: `repair_${Date.now()}_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
    }));
  }

  return { reviewGoalCompletion, repairToolCalls };
}

module.exports = { createRemoteHelpers };
