// #1318: a short plain-language line for every step Mana takes ("Run the
// self-work tests"), shown in the launcher's chat, activity panel and
// Background tasks. Command and sub-task tools ask the model for a
// `description`; when it's missing, one is made from the tool name and
// arguments -- only from the tool name, enum-like actions, numbers and file
// names, never free text from the args (a web page or issue body can't
// become a description verbatim). Everything passes the bridge-output
// sanitizer (secrets, local paths) before it's shown.
const { sanitizeBridgeOutput } = require("../bridge-output-sanitizer");
const { extractCommand, isShellTool } = require("./tool-risk");

const MAX_DESCRIPTION_CHARS = 80;
const MAX_COMMAND_CHARS = 300;
const MAX_RESULT_CHARS = 600;

// Tools that run commands or start sub-tasks: their schemas get `description`.
const STEP_TOOLS = new Set([
  "coding__run_tests",
  "git__change",
  "git__push",
  "github__write",
  "skill__run",
  "self_work__start",
  "self_work__refresh",
  "mana_update__try_pr",
  "mana_update__pull_main",
]);
const SUBTASK_RE = /research|agent|subtask|sub_task|delegate|spawn/i;

const DESCRIPTION_PARAM = {
  type: "string",
  description:
    "A few words, present tense, saying what this step does for the person watching (e.g. \"Run the self-work tests\", \"Search the repo for the plan gate\"). No secrets or full paths.",
};

// #1337: her chat reads like a work log. Only on the tool-aware path; kept
// short (it's in every such prompt).
const TOOL_NARRATION_PROMPT =
  "When you use tools: right before a round of tool calls, write one short first-person sentence saying what you're about to do and why (e.g. \"Next I'm checking the test log to see why it failed.\"). After the tools, lead with the outcome. Plain words, no tool names, don't list the steps. If you need no tools, just answer as usual.";

function needsDescription(name) {
  const n = String(name || "");
  return STEP_TOOLS.has(n) || isShellTool(n) || SUBTASK_RE.test(n.split("__").pop());
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function sanitizeDescription(text) {
  if (typeof text !== "string") return "";
  // Control characters, newlines and markdown/HTML markup out; one line.
  // #1337: "#12" (an issue or PR) stays; a heading marker goes.
  const flat = text.replace(/[\u0000-\u001f\u007f<>`*_[\]]+|#(?!\d)/g, " ").replace(/\s+/g, " ").trim();
  return clip(sanitizeBridgeOutput(flat).trim(), MAX_DESCRIPTION_CHARS);
}

// A plain word from the args (an enum action, a program name), or "".
function word(value) {
  return typeof value === "string" && /^[A-Za-z][\w.-]{0,30}$/.test(value) ? value.replace(/[_-]+/g, " ") : "";
}

function rawPath(args) {
  return ["path", "file_path", "filePath", "file", "filename"].map((k) => args?.[k]).find((v) => typeof v === "string") || "";
}

function fileName(args) {
  const base = rawPath(args).split(/[\\/]/).pop();
  return /^[\w .-]{1,60}$/.test(base) ? base : "";
}

// A repo-relative path as given ("node-bot/x.js"); anything absolute or
// climbing out (C:\..., /home/..., ../) shows just its file name.
function displayPath(args) {
  const raw = rawPath(args).replace(/\\/g, "/");
  const relative = /^[\w .-]+(\/[\w .-]+){0,8}$/.test(raw) && !raw.split("/").includes("..") && raw.length <= 120;
  return relative ? raw : fileName(args);
}

function number(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

// What kind of step, so the launcher can group and word a run of them:
// command, file_create, file_edit, web, search, read, agent or tool.
function stepKind(name) {
  const n = String(name || "");
  const last = n.split("__").pop().toLowerCase();
  // Sub-tasks first: self_work__start/skill__run look like shell tools.
  if (/^(self_work__(start|refresh)|skill__run)$/.test(n) || SUBTASK_RE.test(last)) return "agent";
  if (isShellTool(n) || n === "coding__run_tests") return "command";
  if (/^(write|create)_?file|^create_?(file|directory)/.test(last)) return "file_create";
  if (/edit|replace|patch|move_?files?|rename/.test(last)) return "file_edit";
  if (/^(browser|web|wiki)/i.test(n) || /^(fetch|browse|navigate)/.test(last)) return "web";
  if (/search|grep|find|query/.test(last)) return "search";
  if (/^(read|list|get|view|show|look)/.test(last)) return "read";
  return needsDescription(n) ? "agent" : "tool";
}

const FALLBACKS = {
  coding__run_tests: (a) => (fileName(a) ? `Run the tests in ${fileName(a)}` : "Run the tests"),
  coding__propose_edit: (a) => `Draft an edit to ${fileName(a) || "a file"}`,
  git__read: (a) => `Read git ${word(a.action) || "state"}`,
  git__change: (a) => `Git ${word(a.action) || "change"}`,
  git__push: () => "Push a branch",
  github__read: (a) => `Read GitHub ${word(a.action) || "data"}`,
  github__write: (a) => `GitHub ${word(a.action) || "update"}`,
  skill__run: () => "Run a skill",
  self_work__start: (a) => (number(a.issue) ? `Start work on issue #${number(a.issue)}` : "Start work on an issue"),
  self_work__refresh: (a) => (number(a.pr) ? `Bring PR #${number(a.pr)} up to date` : "Bring a PR up to date"),
  mana_update__try_pr: (a) => (number(a.pr) ? `Try PR #${number(a.pr)}` : "Try a PR"),
};

function fallbackDescription(name, args = {}) {
  const n = String(name || "");
  const a = args && typeof args === "object" ? args : {};
  if (FALLBACKS[n]) return FALLBACKS[n](a);
  const kind = stepKind(n);
  if (kind === "command") {
    const head = String(extractCommand(n, a) || "").trim().split(/\s+/)[0];
    const program = word(head.split(/[\\/]/).pop());
    return program ? `Run ${program}` : "Run a command";
  }
  if (kind === "file_create") return `Create ${fileName(a) || "a file"}`;
  if (kind === "file_edit") return `Edit ${fileName(a) || "a file"}`;
  if (kind === "web") return "Browse the web";
  // "memory__search_facts" -> "Search facts (memory)"
  const [source, ...rest] = n.split("__");
  const action = (rest.join(" ") || source).replace(/[_-]+/g, " ").trim();
  const phrase = action.charAt(0).toUpperCase() + action.slice(1);
  if (!phrase) return "Use a tool";
  return rest.length ? `${phrase} (${source.replace(/[_-]+/g, " ")})` : phrase;
}

function describeStep(name, args) {
  const given = sanitizeDescription(args?.description);
  return given || sanitizeDescription(fallbackDescription(name, args));
}

function lineCount(value) {
  return typeof value === "string" && value ? value.split("\n").length : 0;
}

// Everything the launcher shows for one step (the contract's Step fields
// minus id/status/times), sanitized.
// ponytail: added/removed come from the edit's own args (new/old text),
// not a real diff of the file; good enough for a "+19 −0" hint.
function stepInfo(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const kind = stepKind(name);
  const info = { kind, tool: String(name || ""), description: describeStep(name, a) };
  const command = kind === "command" ? extractCommand(name, a) : null;
  if (command) info.detail = { command: clip(sanitizeBridgeOutput(String(command)), MAX_COMMAND_CHARS) };
  if (kind === "file_create" || kind === "file_edit") {
    const file = displayPath(a);
    if (file) info.file = sanitizeBridgeOutput(file);
    info.added = lineCount(a.new_string ?? a.newText ?? a.content ?? a.proposedContent);
    info.removed = lineCount(a.old_string ?? a.oldText);
  }
  return info;
}

function trimResult(result) {
  const text = typeof result === "string" ? result : result == null ? "" : JSON.stringify(result);
  return clip(sanitizeBridgeOutput(text.trim()), MAX_RESULT_CHARS);
}

// #1337: a tool that starts a background task names it in its JSON result
// ({ taskId, title }); the step then links to that task's transcript.
function launchedTask(result) {
  let parsed;
  try {
    parsed = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    return null;
  }
  const taskId = typeof parsed?.taskId === "string" ? parsed.taskId.slice(0, 200) : "";
  return taskId ? { taskId, title: sanitizeDescription(parsed.title) } : null;
}

// The tool list with `description` added to command/sub-task tools that
// don't already take one; executeTool drops it again before the tool sees
// it (an MCP server may refuse unknown arguments).
function withStepDescriptions(policy) {
  const added = new Set();
  const tools = policy.tools.map((tool) => {
    const fn = tool?.function;
    const props = fn?.parameters?.properties || {};
    if (!fn || !needsDescription(fn.name) || props.description) return tool;
    added.add(fn.name);
    return {
      ...tool,
      function: {
        ...fn,
        parameters: { type: "object", ...fn.parameters, properties: { description: DESCRIPTION_PARAM, ...props } },
      },
    };
  });
  return {
    ...policy,
    tools,
    executeTool: (name, args) => {
      if (added.has(name) && args && typeof args === "object" && "description" in args) {
        const { description, ...rest } = args;
        return policy.executeTool(name, rest);
      }
      return policy.executeTool(name, args);
    },
  };
}

module.exports = {
  DESCRIPTION_PARAM,
  TOOL_NARRATION_PROMPT,
  describeStep,
  fallbackDescription,
  launchedTask,
  needsDescription,
  sanitizeDescription,
  stepInfo,
  stepKind,
  trimResult,
  withStepDescriptions,
};
