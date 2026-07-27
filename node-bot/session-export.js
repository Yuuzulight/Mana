// Issue #153: export a session's full turn history as ShareGPT-style
// JSONL, so it can be pulled out of Mana for the user's own analysis or
// future fine-tuning. ShareGPT's convention is {"conversations": [...]}
// with each entry's `from` one of human/gpt (extended here with
// function_call/observation for tool calls, matching how fine-tuning
// tools like axolotl already extend the format) -- a single session is
// a single conversation, so the export is exactly one JSON object per
// line (still valid JSONL, and consistent if this ever grows into a
// batch export across sessions).
function toShareGPTConversation(session) {
  const conversations = [];
  for (const turn of session.turns || []) {
    if (turn.user) conversations.push({ from: "human", value: turn.user });
    for (const call of turn.toolCalls || []) {
      conversations.push({
        from: "function_call",
        value: JSON.stringify({ name: call.name, args: call.args }),
      });
      if (call.result !== undefined) {
        conversations.push({
          from: "observation",
          value: typeof call.result === "string" ? call.result : JSON.stringify(call.result),
        });
      }
    }
    if (turn.assistant) conversations.push({ from: "gpt", value: turn.assistant });
  }
  return { id: session.sessionId, conversations };
}

function exportSessionAsShareGPTJSONL(session) {
  return `${JSON.stringify(toShareGPTConversation(session))}\n`;
}

module.exports = { toShareGPTConversation, exportSessionAsShareGPTJSONL };
