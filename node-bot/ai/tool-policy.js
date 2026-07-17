const fs = require("node:fs");
const path = require("node:path");

// Foundational, deliberately narrow tool set for local-model tool-calling
// (issue #51): exactly one tool, read-only, path-scoped to a single
// allowed root. No write/execute tool is defined here at all -- adding one
// is a separate, explicit decision, not a config flag on this module.
const READ_FILE_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read the text contents of a file. Only files inside the project directory can be read.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file, relative to the project root.",
        },
      },
      required: ["path"],
    },
  },
};

const MAX_READ_FILE_CHARS = 20000;

class ToolPolicyError extends Error {}

// Resolves requestedPath against allowedRoot and throws unless the result
// is actually inside allowedRoot -- blocks both ../ traversal and absolute
// paths that point elsewhere on disk.
function resolveWithinRoot(allowedRoot, requestedPath) {
  const root = path.resolve(allowedRoot);
  const resolved = path.resolve(root, String(requestedPath || ""));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new ToolPolicyError(
      `path escapes the allowed project directory: ${requestedPath}`,
    );
  }
  return resolved;
}

function createToolPolicy(options = {}) {
  const allowedRoot = path.resolve(
    options.allowedRoot || path.join(__dirname, "..", ".."),
  );
  const readFileSync = options.readFileSync || fs.readFileSync;
  const existsSync = options.existsSync || fs.existsSync;
  const statSync = options.statSync || fs.statSync;
  const maxChars = options.maxReadFileChars || MAX_READ_FILE_CHARS;

  function readFile(args) {
    const requestedPath = args && args.path;
    if (!requestedPath || typeof requestedPath !== "string") {
      throw new ToolPolicyError("path is required");
    }
    const resolved = resolveWithinRoot(allowedRoot, requestedPath);
    if (!existsSync(resolved)) {
      throw new ToolPolicyError(`file not found: ${requestedPath}`);
    }
    if (!statSync(resolved).isFile()) {
      throw new ToolPolicyError(`not a file: ${requestedPath}`);
    }
    const content = String(readFileSync(resolved, "utf8"));
    return content.length > maxChars
      ? `${content.slice(0, maxChars)}\n...[truncated]`
      : content;
  }

  const tools = [READ_FILE_TOOL_SCHEMA];
  const executors = { read_file: readFile };

  function isKnownTool(name) {
    return Object.prototype.hasOwnProperty.call(executors, name);
  }

  // Every tool call is executed here, never dispatched dynamically by name
  // from model output alone -- an unrecognized tool name throws instead of
  // being silently ignored or, worse, guessed at.
  function executeTool(name, args) {
    if (!isKnownTool(name)) {
      throw new ToolPolicyError(`unknown tool: ${name}`);
    }
    return executors[name](args || {});
  }

  return {
    allowedRoot,
    tools,
    isKnownTool,
    executeTool,
  };
}

module.exports = {
  ToolPolicyError,
  READ_FILE_TOOL_SCHEMA,
  createToolPolicy,
  resolveWithinRoot,
};
