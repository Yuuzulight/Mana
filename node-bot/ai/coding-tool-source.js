// Issue #276: a model-callable middle rung between "never touch files"
// (the existing editor hand-off, zed-integration.js's /editors/open) and
// auto-editing live. Reuses zed-integration.js's existing
// createEditProposal/createSimpleLineDiff wholesale for reading the
// original file and computing the diff -- the only new behavior here is
// writing that diff out to a scratch file and handing its path back,
// instead of ever calling approveEditProposal (which writes the real
// file). node-bot's backend never mutates the user's actual source file
// through this tool.
const fs = require("node:fs");
const path = require("node:path");

const CODING_TOOL_PREFIX = "coding__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${CODING_TOOL_PREFIX}propose_edit`,
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
];

function isCodingToolName(name) {
  return typeof name === "string" && name.startsWith(CODING_TOOL_PREFIX);
}

// options.editors: required -- the createEditorIntegrations() instance
// (zed-integration.js) already used by server.js's /editors/* routes.
// options.diffsDir: injectable for tests; same dataDir convention as
// acp-memory-store.js/skills-store.js otherwise.
function createCodingToolSource(options = {}) {
  const editors = options.editors;
  if (!editors) {
    throw new Error("editors is required");
  }
  const diffsDir =
    options.diffsDir ||
    process.env.MANA_CODING_DIFFS_DIR ||
    path.join(__dirname, "..", "data", "coding-diffs");

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  function writeDiffFile(proposal) {
    fs.mkdirSync(diffsDir, { recursive: true });
    const diffPath = path.join(diffsDir, `${proposal.id}.diff`);
    fs.writeFileSync(diffPath, proposal.diff, "utf8");
    return diffPath;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(CODING_TOOL_PREFIX.length);
    if (action !== "propose_edit") {
      throw new Error(`unknown coding tool: ${qualifiedName}`);
    }

    try {
      const proposal = editors.createEditProposal({
        path: args?.path,
        proposedContent: args?.proposedContent,
        summary: args?.summary,
      });
      const diffPath = writeDiffFile(proposal);
      return JSON.stringify({
        status: "ok",
        diffPath,
        relativePath: proposal.relativePath,
        summary: proposal.summary,
        proposalId: proposal.id,
      });
    } catch (e) {
      return JSON.stringify({ status: "error", error: e.message || String(e) });
    }
  }

  return { listToolSchemas, executeTool, isKnownToolName: isCodingToolName };
}

module.exports = {
  CODING_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isCodingToolName,
  createCodingToolSource,
};
