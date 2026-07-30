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

// Issue #268: .env sits inside the default allowedRoot (the repo root), so
// without this guard a prompt-injected read_file call could read and
// exfiltrate real secrets through an otherwise-legitimate "read this file"
// tool call.
test("read_file refuses to read .env even though it's inside the allowed root", () => {
  const fakeFs = makeFakeFileSystem({ "C:\\project\\.env": "DISCORD_BOT_TOKEN=real-secret-value" });
  const policy = createToolPolicy({ allowedRoot: "C:\\project", ...fakeFs });
  assert.throws(
    () => policy.executeTool("read_file", { path: ".env" }),
    /refusing to read a credential-bearing file/,
  );
});

test("read_file refuses .env variants (.env.local, .env.production) but allows .env.sample", () => {
  const fakeFs = makeFakeFileSystem({
    "C:\\project\\.env.local": "SECRET=x",
    "C:\\project\\.env.production": "SECRET=y",
    "C:\\project\\.env.sample": "SECRET=fill-me-in",
  });
  const policy = createToolPolicy({ allowedRoot: "C:\\project", ...fakeFs });
  assert.throws(() => policy.executeTool("read_file", { path: ".env.local" }), ToolPolicyError);
  assert.throws(() => policy.executeTool("read_file", { path: ".env.production" }), ToolPolicyError);
  assert.equal(policy.executeTool("read_file", { path: ".env.sample" }), "SECRET=fill-me-in");
});

test("read_file refuses other common credential-bearing filenames", () => {
  const fakeFs = makeFakeFileSystem({
    "C:\\project\\credentials.json": "{}",
    "C:\\project\\id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----",
    "C:\\project\\server.pem": "-----BEGIN CERTIFICATE-----",
  });
  const policy = createToolPolicy({ allowedRoot: "C:\\project", ...fakeFs });
  for (const p of ["credentials.json", "id_rsa", "server.pem"]) {
    assert.throws(() => policy.executeTool("read_file", { path: p }), ToolPolicyError, p);
  }
});

test("read_file still reads a nested .env-adjacent but non-credential file normally", () => {
  const fakeFs = makeFakeFileSystem({ "C:\\project\\src\\environment.js": "export const x = 1;" });
  const policy = createToolPolicy({ allowedRoot: "C:\\project", ...fakeFs });
  assert.equal(policy.executeTool("read_file", { path: "src\\environment.js" }), "export const x = 1;");
});
