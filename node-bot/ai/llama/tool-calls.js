function createToolCalls(context) {
// A real reply essentially never starts with a raw `{` -- this is the
  // exact leaked-JSON signature confirmed on qwen2.5-coder-7b (see
  // runToolAwareReply's repair call below). Cheap and precise enough: no
  // false-positive risk worth guarding against, and a false negative here
  // just means an unhandled turn falls through to the pre-existing
  // "no tool calls, that's the final answer" behavior.
  //
  // Second, distinct leak shape confirmed live against the same model
  // (coding-mode `coding__propose_edit` prompts, 9/9 real samples): instead
  // of leaking *only* JSON, it writes ordinary explanatory prose and then
  // embeds the intended call mid-response, e.g. "...let's propose this
  // edit:\n\n```json\n{\"name\": \"coding__propose_edit\", \"arguments\":
  // {...}}\n```". The prefix check above never sees this. The
  // "name"+"arguments" pair appearing together (in that order, as JSON
  // keys) is specific to the tool-call shape -- a plain code block's own
  // dict/object literals essentially never use exactly those two key names
  // back to back, so this is unlikely to false-positive on this model's
  // otherwise code-heavy replies.
  //
  // Checked after stripping emotion tags (#623): a tagged reply always starts
  // with "[" ("[happy] Welcome home"), and flagging it forced a repair round
  // whose schema had to return some tool call -- it invented skill__view
  // every turn in a live run.
  function looksLikeFailedToolCallJson(content) {
    const trimmed = context.stripEmotionTags(content).text;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return true;
    }
    return /"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/.test(trimmed);
  }

// #675: reply text without reasoning: a closed <think> block, or an
  // unclosed one running to the end (thinking cut off by its budget).
  function stripThinking(content) {
    return String(content || "").replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
  }

// #1354: reasoning tokens extracted from inside <think>...</think> blocks.
  function extractThinking(content) {
    const matches = [...String(content || "").matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)];
    return matches.map((m) => m[1]).join("\n\n").trim();
  }

// #787: qwen2.5-coder never uses the <tool_call> tags its template asks
  // for, so llama-server's parser never sees a call -- measured live, 98 of
  // 102 goal-mode turns wrote it as a ```json block (or bare JSON) instead,
  // and fixing the template's doubled `{{"name"...}}` example didn't change
  // that. Read those text-form calls here, but only well-formed ones naming
  // an offered tool with its required arguments; anything else still goes
  // to repairToolCalls.
  function parseTextToolCalls(content, tools) {
    const params = new Map((tools || []).map((t) => [t.function.name, t.function.parameters || {}]));
    const text = String(content || "");
    const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```|<tool_call>([\s\S]*?)<\/tool_call>/g)].map(
      (m) => m[1] ?? m[2],
    );
    const found = [];
    for (const raw of blocks.length ? blocks : [text]) {
      try {
        found.push(...[].concat(JSON.parse(raw.trim())));
      } catch (e) {}
    }
    // #1209: Qwen3.5's own form, <function=NAME><parameter=KEY>VALUE
    // </parameter></function>, left in the text when llama-server's parser
    // didn't take it (measured: 6 of 10 benchmark runs ended on one).
    // Values are text; a non-string schema type gets them parsed as JSON.
    // #1258: a call ends at the first </function> after which the next
    // </function> (if any) comes after another <function=...>: prose may
    // follow a call, and code with </function> in it stays in its value. A
    // value ends at the </parameter> that's followed by the next parameter
    // or the end of the call, so code with </parameter> in it comes through
    // whole. The last value may leave out its </parameter> (it runs to
    // </function>). A call without its </function> (a reply cut off) doesn't
    // run.
    if (!found.length) {
      const call = /<function=([\w.-]+)>([\s\S]*?)<\/function>(?=(?:(?!<\/function>)[\s\S])*?(?:<function=[\w.-]+>|$))/g;
      for (const [, name, body] of text.matchAll(call)) {
        const props = params.get(name)?.properties || {};
        const args = {};
        const values = [];
        let end = 0;
        for (const m of body.matchAll(/<parameter=([\w.-]+)>\r?\n?([\s\S]*?)\r?\n?<\/parameter>\s*(?=<parameter=[\w.-]+>|$)/g)) {
          values.push(m);
          end = m.index + m[0].length;
        }
        const last = /^\s*<parameter=([\w.-]+)>\r?\n?([\s\S]*)$/.exec(body.slice(end));
        if (last) values.push([last[0], last[1], last[2].trimEnd()]);
        for (const [, key, value] of values) {
          args[key] = value;
          if (props[key]?.type && props[key].type !== "string") {
            try {
              args[key] = JSON.parse(value.trim());
            } catch (e) {}
          }
        }
        found.push({ name, arguments: args });
      }
    }
    const calls = [];
    for (const call of found) {
      const schema = call && params.get(call.name);
      if (!schema || call.arguments == null) continue;
      const { args, problem, missing } = context.checkToolCallArgs(call.arguments, schema);
      if (problem || missing.length) continue;
      calls.push({
        id: `text_${Date.now()}_${calls.length}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(args) },
      });
    }
    return calls;
  }

// Builds a JSON Schema that forces a valid `{tool_calls: [{name, arguments}]}`
  // shape, one oneOf branch per available tool so `arguments` is validated
  // against that specific tool's own parameter schema. Confirmed directly
  // against this repo's own llama-server build before use: oneOf+const
  // discriminators across multiple tools compile to a working grammar and
  // the model reliably picks the right branch.
  function buildToolCallRepairSchema(tools) {
    return {
      type: "object",
      properties: {
        tool_calls: {
          type: "array",
          items: {
            oneOf: tools.map((t) => ({
              type: "object",
              properties: {
                name: { const: t.function.name },
                arguments: t.function.parameters || { type: "object" },
              },
              required: ["name", "arguments"],
            })),
          },
        },
      },
      required: ["tool_calls"],
    };
  }

// One extra request, schema-constrained instead of relying on the
  // model's own template to populate `tool_calls` -- see the call site's
  // comment for why this exists and how it was confirmed to work. Returns
  // the same shape runToolAwareReply's main loop already expects
  // (OpenAI-style tool_calls entries with a JSON-*string* `arguments`
  // field, matching the `JSON.parse(call.function.arguments)` call
  // further down this loop).
  async function repairToolCalls(messages, tools, maxTokens, profile = "default") {
    if (!Array.isArray(tools) || !tools.length) {
      return [];
    }
    const schema = buildToolCallRepairSchema(tools);
    let resp;
    try {
      resp = await context.fetchImpl(`http://127.0.0.1:${context.state.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          response_format: { type: "json_schema", json_schema: { name: "tool_calls_repair", schema } },
          ...context.buildSamplingParams({ profile, task: "tools", maxTokens, env: context.env }).params,
        }),
      });
    } catch (e) {
      return []; // network/process hiccup -- fall through to the caller's existing no-tool-calls path
    }
    if (!resp.ok) {
      return [];
    }
    let parsed;
    try {
      const json = await resp.json();
      parsed = JSON.parse(json?.choices?.[0]?.message?.content || "");
    } catch (e) {
      return []; // schema-constrained generation still failed to parse -- give up, don't throw
    }
    const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    return calls.map((call, index) => ({
      id: `repair_${Date.now()}_${index}`,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments || {}),
      },
    }));
  }

  return { looksLikeFailedToolCallJson, stripThinking, extractThinking, parseTextToolCalls, buildToolCallRepairSchema, repairToolCalls };
}

module.exports = { createToolCalls };
