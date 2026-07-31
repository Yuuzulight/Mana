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

// Issue #268: read_file's allowedRoot defaults to the repo root (below),
// which is exactly where .env lives -- a prompt-injected read_file call (a
// page Mana read, a doc she was asked to summarize) could otherwise read
// and exfiltrate real secrets (Discord/Telegram bot tokens, TTS provider
// keys) through a completely legitimate-looking "read this file" tool call.
// The risk isn't the model reading .env through its own reasoning -- it's
// never asked to -- it's an untrusted instruction hiding in content Mana
// reads. Blocked by basename regardless of allowedRoot, not just at the
// default root, since a narrower allowedRoot could still happen to contain
// a project's own .env. .env.sample/.example/.template stay readable --
// placeholder templates with no real values, meant to be read as docs.
const ENV_EXEMPT_RE = /^\.env\.(sample|example|template)$/i;
// `^\.envrc$` is an exact match for direnv's real secrets file, not a `\w`
// wildcard -- an earlier version of this regex used `^\.env\w`, which also
// caught unrelated dotfiles like `.environment` that merely start with
// "env" but hold no secrets.
const CREDENTIAL_BASENAME_RE =
  /\.env(?:\.|$)|^\.envrc$|^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$|\.(pem|pfx|p12)$|^credentials(\.json)?$|^secrets\.(ya?ml|json)$/i;

function isCredentialPath(basenameRaw) {
  // Windows silently drops trailing dots/spaces when it resolves a path, so
  // ".env " / ".env." IS the real .env on disk even though the string
  // itself doesn't match -- test the name the OS will actually open.
  const basename = String(basenameRaw).replace(/[.\s]+$/, "");
  if (ENV_EXEMPT_RE.test(basename)) return false;
  return CREDENTIAL_BASENAME_RE.test(basename);
}

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
    if (isCredentialPath(path.basename(resolved))) {
      throw new ToolPolicyError(`refusing to read a credential-bearing file: ${requestedPath}`);
    }
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
  isCredentialPath,
};
