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
  const result = { id: session.sessionId, conversations };
  if (session.forkedFrom) {
    result.forkedFrom = session.forkedFrom;
    if (typeof session.branchTurnIndex === "number") {
      result.branchTurnIndex = session.branchTurnIndex;
    }
  }
  return result;
}

function exportSessionAsShareGPTJSONL(session) {
  return `${JSON.stringify(toShareGPTConversation(session))}\n`;
}

// #1323: the chat as Markdown to read or send to someone. Tool calls and the
// hidden reasoning (#1354) are left out unless asked for. A turn's stored text
// has its whitespace collapsed (acp-memory-store's cleanText), which loses
// code blocks; the turn's verbatim artifact (#1142) puts the first one back.
const FENCE = /```\w*[\s\S]*?```/;

function fenced(language, content) {
  // A longer fence than any run of backticks inside, so the block can't end early.
  const longest = Math.max(2, ...(content.match(/`+/g) || []).map((run) => run.length));
  const mark = "`".repeat(longest + 1);
  return `${mark}${language}\n${content}\n${mark}`;
}

function assistantMarkdown(turn) {
  const text = String(turn.assistant || "");
  const artifact = turn.artifact;
  if (artifact && typeof artifact.content === "string" && FENCE.test(text)) {
    const language = artifact.language === "text" ? "" : artifact.language || "";
    return text.replace(FENCE, () => fenced(language, artifact.content));
  }
  return text;
}

function quoted(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function toolCallMarkdown(call) {
  const lines = [`**Tool:** \`${call.name}\`${call.ok === false ? " (failed)" : ""}`];
  if (call.args !== undefined) lines.push(fenced("json", JSON.stringify(call.args, null, 2)));
  if (call.result !== undefined) {
    lines.push(fenced("", typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2)));
  }
  return lines.join("\n\n");
}

function exportSessionAsMarkdown(session, { includeTools = false, includeThoughts = false, now = new Date() } = {}) {
  const parts = [`# ${String(session.name || session.sessionId || "Chat").replace(/\s+/g, " ").trim()}`];
  const meta = [`_Exported ${now.toISOString().slice(0, 10)}_`];
  if (session.forkedFrom) {
    const turnNote = typeof session.branchTurnIndex === "number" ? ` at turn ${session.branchTurnIndex + 1}` : "";
    meta.push(`_Branched from ${session.forkedFrom}${turnNote}_`);
  }
  parts.push(meta.join(" • "));
  for (const turn of session.turns || []) {
    if (turn.user) parts.push(`### You\n\n${turn.user}`);
    if (!turn.assistant) continue;
    const blocks = [`### ${turn.speaker || "Mana"}`];
    if (includeThoughts && turn.thought) blocks.push(`_Thought process_\n\n${quoted(turn.thought)}`);
    if (includeTools) {
      for (const call of turn.toolCalls || []) blocks.push(toolCallMarkdown(call));
    }
    blocks.push(assistantMarkdown(turn));
    parts.push(blocks.join("\n\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

module.exports = { toShareGPTConversation, exportSessionAsShareGPTJSONL, exportSessionAsMarkdown };
