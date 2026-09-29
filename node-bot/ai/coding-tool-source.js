// Issue #276: a model-callable middle rung between "never touch files"
// (the existing editor hand-off, zed-integration.js's /editors/open) and
// auto-editing live. Reuses zed-integration.js's existing
// createEditProposal wholesale for reading the
// original file and computing the diff -- the only new behavior here is
// writing that diff out to a scratch file and handing its path back,
// instead of ever calling approveEditProposal (which writes the real
// file). node-bot's backend never mutates the user's actual source file
// through this tool.
//
// #787: coding__run_tests runs the workspace's own test command. That
// executes the user's code, so it always asks first (approval gate,
// "coding-run-tests"), unless the user allowed that exact command in that
// folder for the session.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { isCredentialPath } = require("./tool-policy");
const { formatReviewHeader } = require("./adversarial-verifier");
const { killProcessTree } = require("../utils/kill-process-tree");

const CODING_TOOL_PREFIX = "coding__";
const CODING_EDIT_TOOL_NAME = `${CODING_TOOL_PREFIX}propose_edit`;
const CODING_TEST_TOOL_NAME = `${CODING_TOOL_PREFIX}run_tests`;
const TEST_TIMEOUT_MS = 120000;
const MAX_TEST_OUTPUT_CHARS = 4000;

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: CODING_EDIT_TOOL_NAME,
      description:
        "Draft a proposed code change as a review-able diff instead of editing the file -- this never touches the user's real file. Requires an active editor workspace (set via the existing 'open in editor' flow) and a full replacement for the target file's contents. Returns a path to a .diff file the user reviews and applies themselves through their own editor/tooling.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to change, relative to (or inside) the active workspace.",
          },
          proposedContent: {
            type: "string",
            description: "The full proposed replacement content for the file, not just the changed lines.",
          },
          summary: {
            type: "string",
            description: "A short, one-line summary of what the change does.",
          },
        },
        required: ["path", "proposedContent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CODING_TEST_TOOL_NAME,
      description:
        "Run the active workspace's tests (npm test, dotnet test, pytest or unittest -- picked from the project files) and get the exit code and output. Asks the user first unless they've allowed it for this session.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional test file or folder inside the workspace. A test file runs just that file where the runner allows it (npm test, pytest); a folder runs its project's tests. Defaults to the whole workspace.",
          },
        },
      },
    },
  },
];

function isCodingToolName(name) {
  return typeof name === "string" && name.startsWith(CODING_TOOL_PREFIX);
}

// #787: the test command for a folder, from what's in it.
// MANA_CODING_TEST_COMMAND overrides detection.
function detectTestCommand(dir, { env = process.env, fsImpl = fs } = {}) {
  if (env.MANA_CODING_TEST_COMMAND) return env.MANA_CODING_TEST_COMMAND;
  const files = fsImpl.readdirSync(dir);
  const read = (name) => {
    try {
      return String(fsImpl.readFileSync(path.join(dir, name), "utf8"));
    } catch (e) {
      return "";
    }
  };
  if (files.includes("package.json")) {
    let test = "";
    try {
      test = JSON.parse(read("package.json")).scripts?.test || "";
    } catch (e) {}
    if (test && !/no test specified/.test(test)) return "npm test";
  }
  if (files.some((f) => /\.(sln|csproj|fsproj)$/i.test(f))) return "dotnet test";
  if (files.some((f) => /^(pytest\.ini|conftest\.py)$/i.test(f)) || /\[tool\.pytest/.test(read("pyproject.toml"))) {
    return "python -m pytest -q";
  }
  if (files.some((f) => /^test.*\.py$/i.test(f))) return "python -m unittest discover -v";
  return null;
}

// Runs a test command in cwd. The output keeps its tail, where test
// runners put the failures and the summary.
function runTestCommand(
  command,
  cwd,
  { spawnImpl = spawn, killTree = killProcessTree, timeoutMs = TEST_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    let output = "";
    let dropped = 0;
    let timedOut = false;
    let settled = false;
    const append = (chunk) => {
      output += String(chunk);
      if (output.length > MAX_TEST_OUTPUT_CHARS) {
        dropped += output.length - MAX_TEST_OUTPUT_CHARS;
        output = output.slice(-MAX_TEST_OUTPUT_CHARS);
      }
    };
    const done = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, output: dropped ? `...[${dropped} earlier chars cut]\n${output}` : output });
    };
    const child = spawnImpl(command, { cwd, shell: true, windowsHide: true });
    // Settles right after the kill: a tree that never reports 'close' must
    // not hang the reply.
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      done(null);
    }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      append(e.message || String(e));
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

// options.editors: required -- the createEditorIntegrations() instance
// (zed-integration.js) already used by server.js's /editors/* routes.
// options.diffsDir: injectable for tests; same dataDir convention as
// acp-memory-store.js/skills-store.js otherwise.
// options.reviewEdit: optional (proposal) => Promise<review|null>, issue
// #622's adversarial verifier (ai/adversarial-verifier.js's refuteEdit).
// options.approvalGate: without one, coding__run_tests isn't offered.
// options.env / options.runTests: injectable for tests.
function createCodingToolSource(options = {}) {
  const editors = options.editors;
  if (!editors) {
    throw new Error("editors is required");
  }
  const diffsDir =
    options.diffsDir ||
    process.env.MANA_CODING_DIFFS_DIR ||
    path.join(__dirname, "..", "data", "coding-diffs");
  const approvalGate = options.approvalGate || null;
  const env = options.env || process.env;
  const runTests = options.runTests || runTestCommand;

  if (approvalGate) {
    approvalGate.registerExecutor("coding-run-tests", async ({ command, cwd }) => {
      const run = await runTests(command, cwd);
      return JSON.stringify({ status: "ok", command, cwd, passed: run.exitCode === 0 && !run.timedOut, ...run });
    });
  }

  // #787: both tools need an active editor workspace -- without one they
  // only return errors, which goal mode would spend its rounds on.
  function listToolSchemas() {
    if (!editors.getWorkspace()) return [];
    return approvalGate ? TOOL_SCHEMAS : TOOL_SCHEMAS.filter((t) => t.function.name !== CODING_TEST_TOOL_NAME);
  }

  function writeDiffFile(proposal) {
    fs.mkdirSync(diffsDir, { recursive: true });
    const diffPath = path.join(diffsDir, `${proposal.id}.diff`);
    fs.writeFileSync(diffPath, formatReviewHeader(proposal.adversarialReview) + proposal.diff, "utf8");
    return diffPath;
  }

  async function runWorkspaceTests(args) {
    const workspace = editors.getWorkspace();
    if (!workspace || !approvalGate) {
      return JSON.stringify({ status: "error", error: "no active workspace to run tests in" });
    }
    const root = path.resolve(workspace.path);
    const target = path.resolve(root, String(args?.path || "."));
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return JSON.stringify({ status: "error", error: "path must be inside the workspace" });
    }
    // The nearest folder, from the target up to the workspace root, with a
    // test command: models ask for "test" or "test/x.test.js", not the root.
    let file = null;
    let cwd = target;
    let command = null;
    try {
      if (fs.statSync(target).isFile()) {
        file = target;
        cwd = path.dirname(target);
      }
      for (;;) {
        command = detectTestCommand(cwd, { env });
        if (command || cwd === root || path.dirname(cwd) === cwd) break;
        cwd = path.dirname(cwd);
      }
    } catch (e) {
      return JSON.stringify({ status: "error", error: `cannot read ${args?.path || "the workspace"}: ${e.message}` });
    }
    if (!command) {
      return JSON.stringify({
        status: "error",
        error: "no test command found (looked for package.json scripts.test, a .sln/.csproj, pytest config, test*.py)",
      });
    }
    // One file, where the runner takes one; the name goes into a shell
    // command line, so only plain path characters.
    if (file && (command === "npm test" || command === "python -m pytest -q")) {
      const name = path.relative(cwd, file).split(path.sep).join("/");
      if (!/^[\w./ -]+$/.test(name)) {
        return JSON.stringify({ status: "error", error: "unsupported characters in the test file name" });
      }
      command = command === "npm test" ? `npm test -- "${name}"` : `${command} "${name}"`;
    }
    const outcome = await approvalGate.requestApproval("coding-run-tests", {
      summary: `Run tests: ${command} (in ${cwd})`,
      payload: { command, cwd },
      scanText: command,
      grantKey: `coding-run-tests:${cwd}|${command}`,
      details: { command, cwd },
    });
    return outcome.status === "approved" ? outcome.result : JSON.stringify(outcome);
  }

  async function executeTool(qualifiedName, args) {
    if (qualifiedName === CODING_TEST_TOOL_NAME) return runWorkspaceTests(args);
    if (qualifiedName !== CODING_EDIT_TOOL_NAME) {
      throw new Error(`unknown coding tool: ${qualifiedName}`);
    }

    // Issue #268's own fix for read_file applies here too: this tool's
    // createEditProposal() call reads whatever file the model names inside
    // the active workspace, a different code path from read_file's
    // allowedRoot/credential check -- without this, a prompt-injected
    // instruction (hiding in a page Mana read, a doc she was asked to
    // summarize) could get a real .env's contents copied into a scratch
    // diff file and reflected back through the tool result.
    if (isCredentialPath(path.basename(String(args?.path || "")))) {
      return JSON.stringify({ status: "error", error: "refusing to read a credential file" });
    }

    try {
      const proposal = editors.createEditProposal({
        path: args?.path,
        proposedContent: args?.proposedContent,
        summary: args?.summary,
      });
      // Issue #622: before the diff reaches the user -- stored on the
      // proposal too, so the /editors proposal routes show it.
      if (options.reviewEdit) proposal.adversarialReview = await options.reviewEdit(proposal);
      const diffPath = writeDiffFile(proposal);
      return JSON.stringify({
        status: "ok",
        diffPath,
        relativePath: proposal.relativePath,
        summary: proposal.summary,
        proposalId: proposal.id,
        adversarialReview: proposal.adversarialReview || undefined,
        // #787: the goal review judges from tool results, so it sees the change.
        diff: String(proposal.diff || "").slice(0, 2000),
      });
    } catch (e) {
      return JSON.stringify({ status: "error", error: e.message || String(e) });
    }
  }

  return { listToolSchemas, executeTool, isKnownToolName: isCodingToolName };
}

module.exports = {
  CODING_TOOL_PREFIX,
  CODING_EDIT_TOOL_NAME,
  CODING_TEST_TOOL_NAME,
  TOOL_SCHEMAS,
  isCodingToolName,
  detectTestCommand,
  runTestCommand,
  createCodingToolSource,
};
