const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ToolPolicyError,
  createToolPolicy,
  resolveWithinRoot,
} = require("../ai/tool-policy");

function makeFakeFileSystem(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    statSync: (p) => ({ isFile: () => Object.prototype.hasOwnProperty.call(files, p) }),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return files[p];
    },
  };
}

test("resolveWithinRoot allows a plain relative path inside the root", () => {
  const resolved = resolveWithinRoot("C:\\project", "docs\\readme.md");
  assert.equal(resolved, "C:\\project\\docs\\readme.md");
});

test("resolveWithinRoot rejects ../ traversal out of the root", () => {
  assert.throws(
    () => resolveWithinRoot("C:\\project", "..\\secrets.txt"),
    ToolPolicyError,
  );
});

test("resolveWithinRoot rejects an absolute path outside the root", () => {
  assert.throws(
    () => resolveWithinRoot("C:\\project", "C:\\Windows\\System32\\drivers\\etc\\hosts"),
    ToolPolicyError,
  );
});

test("resolveWithinRoot rejects a sibling directory that merely shares a name prefix", () => {
  // "C:\project2\file.txt" textually starts with "C:\project" but is not
  // actually inside it -- must not be treated as in-bounds.
  assert.throws(
    () => resolveWithinRoot("C:\\project", "..\\project2\\file.txt"),
    ToolPolicyError,
  );
});

test("createToolPolicy exposes exactly one tool: read_file", () => {
  const policy = createToolPolicy({ allowedRoot: "C:\\project" });
  assert.equal(policy.tools.length, 1);
  assert.equal(policy.tools[0].function.name, "read_file");
  assert.equal(policy.isKnownTool("read_file"), true);
  assert.equal(policy.isKnownTool("write_file"), false);
  assert.equal(policy.isKnownTool("exec_shell_command"), false);
});

test("executeTool reads a real file inside the allowed root", () => {
  const fakeFs = makeFakeFileSystem({
    "C:\\project\\notes.txt": "hello from notes",
  });
  const policy = createToolPolicy({ allowedRoot: "C:\\project", ...fakeFs });
  const result = policy.executeTool("read_file", { path: "notes.txt" });
  assert.equal(result, "hello from notes");
});

test("executeTool refuses to read outside the allowed root", () => {
  const fakeFs = makeFakeFileSystem({
    "C:\\elsewhere\\secret.txt": "top secret",
  });
  const policy = createToolPolicy({ allowedRoot: "C:\\project", ...fakeFs });
  assert.throws(
    () => policy.executeTool("read_file", { path: "..\\elsewhere\\secret.txt" }),
    ToolPolicyError,
  );
});

test("executeTool reports a clear error for a missing file instead of throwing raw fs errors", () => {
  const fakeFs = makeFakeFileSystem({});
  const policy = createToolPolicy({ allowedRoot: "C:\\project", ...fakeFs });
  assert.throws(
    () => policy.executeTool("read_file", { path: "missing.txt" }),
    /file not found/,
  );
});

test("executeTool rejects an unknown tool name rather than silently no-op'ing", () => {
  const policy = createToolPolicy({ allowedRoot: "C:\\project" });
  assert.throws(
    () => policy.executeTool("exec_shell_command", { command: "dir" }),
    /unknown tool/,
  );
});

test("executeTool truncates file content past the configured max length", () => {
  const bigContent = "x".repeat(100);
  const fakeFs = makeFakeFileSystem({ "C:\\project\\big.txt": bigContent });
  const policy = createToolPolicy({
    allowedRoot: "C:\\project",
    maxReadFileChars: 10,
    ...fakeFs,
  });
  const result = policy.executeTool("read_file", { path: "big.txt" });
  assert.equal(result, "xxxxxxxxxx\n...[truncated]");
});

test("read_file requires a path argument", () => {
  const policy = createToolPolicy({ allowedRoot: "C:\\project" });
  assert.throws(() => policy.executeTool("read_file", {}), /path is required/);
});
