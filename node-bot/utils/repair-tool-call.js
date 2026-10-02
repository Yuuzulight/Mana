// Issue #621: deterministic tool-call repair utility for Pipeline A and Pipeline B.
// Recovers tool calls from model outputs with code fences, doubled braces, trailing commas,
// XML/tag wrappers, and unescaped Windows path backslashes before falling back to re-asks.

function repairJsonString(raw) {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.trim();

  // 1. Fix doubled braces: {{ ... }} -> { ... }
  if (/^\s*\{\{/.test(text)) {
    text = text.replace(/^\s*\{\{\s*/, "{").replace(/\s*\}\}\s*$/, "}");
  }
  text = text.replace(/\{\{\s*"/g, '{"');

  // 2. Strip trailing commas before closing braces or brackets:
  // e.g. {"a": 1,} -> {"a": 1} or [1, 2,] -> [1, 2]
  text = text.replace(/,\s*([}\]])/g, "$1");

  // 3. Drive-letter Windows path backslashes: e.g. "C:\Users\project\file.txt"
  // In file paths, models never mean formfeed (\f), tab (\t), newline (\n), etc.
  text = text.replace(/"([A-Za-z]:[^"]*)"/g, (match) => {
    return match.replace(/\\\\|\\/g, "\\\\");
  });

  // 4. Escape stray backslashes without corrupting existing valid escapes or \\ pairs
  text = text.replace(/\\\\|\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (match, validEscape) => {
    if (match === "\\\\") return "\\\\";
    if (validEscape) return match;
    return "\\\\";
  });

  return text;
}

function parseRepairedJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim();

  // First try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (e) {}

  // Apply JSON string repairs
  const repaired = repairJsonString(cleaned);
  try {
    return JSON.parse(repaired);
  } catch (e) {}



  return null;
}

function extractCandidateBlocks(content) {
  if (!content || typeof content !== "string") return [];
  const text = content.trim();
  const blocks = [];

  // 1. Code fences: ```json ... ``` or ``` ... ```
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (m[1]?.trim()) blocks.push(m[1].trim());
  }

  // 2. <tool_call> ... </tool_call> tags
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) {
    if (m[1]?.trim()) blocks.push(m[1].trim());
  }

  // 3. Bracket / brace bounded substrings
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    blocks.push(text.slice(firstBracket, lastBracket + 1));
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    blocks.push(text.slice(firstBrace, lastBrace + 1));
  }

  // 4. Whole text as fallback
  blocks.push(text);

  return blocks;
}

function parseQwenXmlToolCalls(text, validNames) {
  const calls = [];
  const callPattern = /<function=([\w.-]+)>([\s\S]*?)<\/function>(?=(?:(?!<\/function>)[\s\S])*?(?:<function=[\w.-]+>|$))/g;
  for (const [, name, body] of text.matchAll(callPattern)) {
    if (validNames && validNames.size > 0 && !validNames.has(name)) continue;
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
      const parsed = parseRepairedJson(value.trim());
      args[key] = parsed !== null && typeof parsed !== "number" && typeof parsed !== "boolean" ? parsed : value;
      if (typeof parsed === "number" || typeof parsed === "boolean") args[key] = parsed;
    }
    calls.push({
      name,
      tool: name,
      arguments: args,
      args,
    });
  }
  return calls;
}

function normalizeToolItem(item, validNames) {
  if (!item || typeof item !== "object") return null;

  // Handle nested tool_call wrappers
  if (item.function && typeof item.function === "object") {
    const fnName = item.function.name;
    let fnArgs = item.function.arguments;
    if (typeof fnArgs === "string") {
      const parsedArgs = parseRepairedJson(fnArgs);
      if (parsedArgs !== null) fnArgs = parsedArgs;
    }
    return normalizeToolItem({ name: fnName, arguments: fnArgs }, validNames);
  }

  const name = item.name || item.tool || item.type;
  if (!name || typeof name !== "string") return null;
  if (validNames && validNames.size > 0 && !validNames.has(name)) return null;

  let args = item.arguments ?? item.args;
  if (args === undefined) {
    // If item itself has properties other than tool/name/type, use them as args
    const rest = { ...item };
    delete rest.name;
    delete rest.tool;
    delete rest.type;
    delete rest.id;
    args = Object.keys(rest).length ? rest : {};
  } else if (typeof args === "string") {
    const parsedArgs = parseRepairedJson(args);
    if (parsedArgs !== null && typeof parsedArgs === "object") {
      args = parsedArgs;
    }
  }

  return {
    name,
    tool: name,
    arguments: args ?? {},
    args: args ?? {},
  };
}

/**
 * Deterministically extracts and repairs tool calls from raw model text.
 * Strips code fences, fixes doubled braces, trailing commas, Windows path backslashes,
 * and extracts standard tool call objects.
 *
 * @param {string} content - Raw model completion content
 * @param {Array} [tools] - Optional array of tools or tool names to validate against
 * @returns {Array<{name: string, tool: string, arguments: any, args: any}>}
 */
function repairToolCallText(content, tools = []) {
  if (!content || typeof content !== "string") return [];

  const validNames = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((t) => t?.function?.name || t?.name || (typeof t === "string" ? t : null))
      .filter(Boolean),
  );

  // Check Qwen XML tags first if present
  if (content.includes("<function=")) {
    const xmlCalls = parseQwenXmlToolCalls(content, validNames);
    if (xmlCalls.length > 0) return xmlCalls;
  }

  const blocks = extractCandidateBlocks(content);
  for (const block of blocks) {
    const parsed = parseRepairedJson(block);
    if (!parsed) continue;

    // If parsed is an array of candidate tools/actions
    if (Array.isArray(parsed)) {
      const normalized = parsed
        .map((item) => normalizeToolItem(item, validNames))
        .filter(Boolean);
      if (normalized.length > 0) return normalized;
    }

    // If parsed is an object containing tool_calls
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.tool_calls)) {
        const normalized = parsed.tool_calls
          .map((item) => normalizeToolItem(item, validNames))
          .filter(Boolean);
        if (normalized.length > 0) return normalized;
      }

      const single = normalizeToolItem(parsed, validNames);
      if (single) return [single];
    }
  }

  return [];
}

module.exports = {
  repairJsonString,
  parseRepairedJson,
  repairToolCallText,
};
