const assert = require("node:assert/strict");
const test = require("node:test");

const { toShareGPTConversation, exportSessionAsShareGPTJSONL } = require("../session-export");

test("converts a plain user/assistant turn into human/gpt pairs", () => {
  const session = {
    sessionId: "abc",
    turns: [{ user: "hi", assistant: "hello there" }],
  };
  assert.deepEqual(toShareGPTConversation(session), {
    id: "abc",
    conversations: [
      { from: "human", value: "hi" },
      { from: "gpt", value: "hello there" },
    ],
  });
});

test("preserves tool calls as function_call/observation entries between human and gpt", () => {
  const session = {
    sessionId: "abc",
    turns: [
      {
        user: "what's NVDA trading at",
        assistant: "NVDA is at $123.45",
        toolCalls: [{ name: "stock_quote", ok: true, args: { symbol: "NVDA" }, result: "123.45" }],
      },
    ],
  };
  const result = toShareGPTConversation(session);
  assert.deepEqual(result.conversations, [
    { from: "human", value: "what's NVDA trading at" },
    { from: "function_call", value: JSON.stringify({ name: "stock_quote", args: { symbol: "NVDA" } }) },
    { from: "observation", value: "123.45" },
    { from: "gpt", value: "NVDA is at $123.45" },
  ]);
});

test("JSON-stringifies a non-string tool result for the observation entry", () => {
  const session = {
    sessionId: "abc",
    turns: [
      {
        user: "check the weather",
        assistant: "it's sunny",
        toolCalls: [{ name: "weather", ok: true, args: {}, result: { tempF: 72 } }],
      },
    ],
  };
  const observation = toShareGPTConversation(session).conversations.find((c) => c.from === "observation");
  assert.equal(observation.value, JSON.stringify({ tempF: 72 }));
});

test("skips a tool call with no result rather than emitting an empty observation", () => {
  const session = {
    sessionId: "abc",
    turns: [
      {
        user: "run it",
        assistant: "done",
        toolCalls: [{ name: "no_result_tool", ok: true, args: {} }],
      },
    ],
  };
  const froms = toShareGPTConversation(session).conversations.map((c) => c.from);
  assert.deepEqual(froms, ["human", "function_call", "gpt"]);
});

test("handles multiple turns across a session in order", () => {
  const session = {
    sessionId: "abc",
    turns: [
      { user: "first", assistant: "first reply" },
      { user: "second", assistant: "second reply" },
    ],
  };
  const values = toShareGPTConversation(session).conversations.map((c) => c.value);
  assert.deepEqual(values, ["first", "first reply", "second", "second reply"]);
});

test("exportSessionAsShareGPTJSONL produces exactly one newline-terminated JSON line", () => {
  const session = { sessionId: "abc", turns: [{ user: "hi", assistant: "hello" }] };
  const jsonl = exportSessionAsShareGPTJSONL(session);
  assert.equal(jsonl.endsWith("\n"), true);
  assert.equal(jsonl.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(jsonl.trim()), toShareGPTConversation(session));
});

test("a session with no turns exports an empty conversations array", () => {
  const session = { sessionId: "empty-session", turns: [] };
  assert.deepEqual(toShareGPTConversation(session), { id: "empty-session", conversations: [] });
});
