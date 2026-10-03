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

// #1323: Markdown export.
const { exportSessionAsMarkdown } = require("../session-export");

const markdownSession = {
  sessionId: "s1",
  name: "Raid plans",
  turns: [
    {
      user: "what's the plan",
      assistant: "We go Friday. ```js const a = 1; const b = 2;``` Done.",
      artifact: { language: "js", content: "const a = 1;\nconst b = 2;" },
      thought: "They asked about the raid.\nCheck the calendar.",
      toolCalls: [{ name: "calendar_lookup", ok: true, args: { day: "Fri" }, result: "free" }],
    },
  ],
};
const exportedOn = new Date("2026-10-03T00:00:00Z");

test("markdown export titles the chat, labels who spoke, and restores a collapsed code block", () => {
  const md = exportSessionAsMarkdown(markdownSession, { now: exportedOn });
  assert.match(md, /^# Raid plans\n\n_Exported 2026-10-03_/);
  assert.match(md, /### You\n\nwhat's the plan/);
  assert.match(md, /### Mana\n\nWe go Friday\. ```js\nconst a = 1;\nconst b = 2;\n``` Done\./);
});

test("markdown export leaves out tool calls and reasoning unless asked for", () => {
  const plain = exportSessionAsMarkdown(markdownSession, { now: exportedOn });
  assert.doesNotMatch(plain, /calendar_lookup|Thought process|Check the calendar/);

  const full = exportSessionAsMarkdown(markdownSession, { includeTools: true, includeThoughts: true, now: exportedOn });
  assert.match(full, /_Thought process_\n\n> They asked about the raid\.\n> Check the calendar\./);
  assert.match(full, /\*\*Tool:\*\* `calendar_lookup`/);
  assert.match(full, /"day": "Fri"/);
});

test("markdown export uses the speaker's name and a fence longer than backticks inside the code", () => {
  const md = exportSessionAsMarkdown(
    {
      sessionId: "s2",
      turns: [
        {
          user: "show me",
          speaker: "Aoi",
          assistant: "```md x```",
          artifact: { language: "md", content: "use ``` to fence" },
        },
      ],
    },
    { now: exportedOn },
  );
  assert.match(md, /^# s2\n/);
  assert.match(md, /### Aoi/);
  assert.match(md, /````md\nuse ``` to fence\n````/);
});

test("#1322: export handles branched sessions in ShareGPT and Markdown", () => {
  const branchedSession = {
    sessionId: "s1-fork-123",
    name: "Branched raid plans",
    forkedFrom: "s1",
    branchTurnIndex: 0,
    turns: [
      { user: "plan a", assistant: "lets do a" },
      { user: "plan b", assistant: "lets do b" },
    ],
  };

  const shareGpt = toShareGPTConversation(branchedSession);
  assert.equal(shareGpt.id, "s1-fork-123");
  assert.equal(shareGpt.forkedFrom, "s1");
  assert.equal(shareGpt.branchTurnIndex, 0);

  const md = exportSessionAsMarkdown(branchedSession, { now: exportedOn });
  assert.match(md, /# Branched raid plans/);
  assert.match(md, /_Branched from s1 at turn 1_/);
});
