const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CODING_TOOL_PREFIX, TOOL_SCHEMAS, isCodingToolName, createCodingToolSource } = require("../ai/coding-tool-source");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-coding-tool-test-"));
}

function fakeEditors({ createEditProposalImpl, applied = [] } = {}) {
  return {
    createEditProposal:
      createEditProposalImpl ||
      (({ path: p, proposedContent, summary }) => ({
        id: "proposal-1",
        relativePath: p,
        summary: summary || "",
        diff: `--- ${p}\n+++ ${p}\n-old\n+${proposedContent}\n`,
      })),
    approveEditProposal: (id) => {
      applied.push(id);
      throw new Error("approveEditProposal must never be called by coding-tool-source");
    },
  };
}

test("createCodingToolSource requires editors", () => {
  assert.throws(() => createCodingToolSource({}), /editors is required/);
});

test("isCodingToolName distinguishes coding tool names from anything else", () => {
  assert.equal(isCodingToolName(`${CODING_TOOL_PREFIX}propose_edit`), true);
  assert.equal(isCodingToolName("memory__remember"), false);
  assert.equal(isCodingToolName(undefined), false);
});

test("listToolSchemas returns the propose_edit tool schema", () => {
  const source = createCodingToolSource({ editors: fakeEditors() });
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
  assert.deepEqual(TOOL_SCHEMAS.map((t) => t.function.name), [`${CODING_TOOL_PREFIX}propose_edit`]);
});

test("propose_edit writes the diff to a scratch file and returns its path, never touching the real file", async () => {
  const diffsDir = tempDir();
  const applied = [];
  const source = createCodingToolSource({ editors: fakeEditors({ applied }), diffsDir });

  const result = await source.executeTool(`${CODING_TOOL_PREFIX}propose_edit`, {
    path: "src/foo.js",
    proposedContent: "const x = 2;",
    summary: "bump x to 2",
  });
  const parsed = JSON.parse(result);

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.relativePath, "src/foo.js");
  assert.equal(parsed.summary, "bump x to 2");
  assert.equal(parsed.proposalId, "proposal-1");
  assert.ok(fs.existsSync(parsed.diffPath), "diff file should exist on disk");
  assert.match(fs.readFileSync(parsed.diffPath, "utf8"), /const x = 2;/);

  // The whole point of this tool is that it never applies the change.
  assert.deepEqual(applied, []);
});

test("propose_edit returns a JSON error instead of throwing when there's no active workspace", async () => {
  const editors = fakeEditors({
    createEditProposalImpl: () => {
      throw new Error("active workspace is not set");
    },
  });
  const source = createCodingToolSource({ editors, diffsDir: tempDir() });

  const result = await source.executeTool(`${CODING_TOOL_PREFIX}propose_edit`, {
    path: "src/foo.js",
    proposedContent: "const x = 2;",
  });
  assert.deepEqual(JSON.parse(result), { status: "error", error: "active workspace is not set" });
});

test("executeTool rejects an unrecognized coding tool name", async () => {
  const source = createCodingToolSource({ editors: fakeEditors() });
  await assert.rejects(
    () => source.executeTool(`${CODING_TOOL_PREFIX}delete_everything`, {}),
    /unknown coding tool/,
  );
});
