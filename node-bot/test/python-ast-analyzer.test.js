const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "..", "tools", "python_ast_analyzer.py");
const PY = process.env.PYTHON || "python";

test("python_ast_analyzer detects subprocess, os.system and file writes", () => {
  const dangerousCode = `import subprocess\nimport os\nopen('out.txt','w').write('x')\nos.system('rm -rf /tmp/evil')\nsubprocess.run(['echo','hi'])\n`;
  const res = spawnSync(PY, [script], {
    input: dangerousCode,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(
    res.status === 0 || res.status === null,
    true,
    `python script failed: ${res.stderr || ""}`,
  );
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || "[]");
  } catch (e) {
    throw new Error("Failed to parse analyzer JSON: " + String(e));
  }
  assert.ok(Array.isArray(parsed), "expected JSON array");
  const types = parsed.map((p) => p.type);
  // Expect at least one of these risk markers
  const hasSubprocess = types.some(
    (t) => t === "subprocess" || t === "subprocess_import",
  );
  const hasOs = types.some((t) => t === "os_system" || t === "os_import");
  const hasFileWrite = types.some((t) => t === "file_write" || t === "open");
  assert.ok(hasSubprocess, "should detect subprocess usage");
  assert.ok(hasOs, "should detect os.system usage");
  assert.ok(hasFileWrite, "should detect file write via open");
});

test("python_ast_analyzer detects shutil.rmtree and os.remove and from-imports", () => {
  const code = `from subprocess import Popen\nimport shutil\nshutil.rmtree('/tmp/test')\nimport os\nos.remove('somefile')\n`;
  const res = spawnSync(PY, [script], {
    input: code,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(
    res.status === 0 || res.status === null,
    true,
    `python script failed: ${res.stderr || ""}`,
  );
  const parsed = JSON.parse(res.stdout || "[]");
  const types = parsed.map((p) => p.type);
  assert.ok(
    types.includes("subprocess_import") || types.includes("subprocess"),
    "should detect subprocess import",
  );
  assert.ok(
    types.includes("shutil_rmtree") || types.includes("shutil_rmtree"),
    "should detect shutil.rmtree",
  );
  assert.ok(
    types.includes("os_remove") || types.includes("os_remove"),
    "should detect os.remove",
  );
});

test("python_ast_analyzer accepts file path argument and reports same risks", () => {
  // create a temp file and pass its path
  const fs = require("fs");
  const os = require("os");
  const p = require("path");
  const tmpdir = fs.mkdtempSync(p.join(os.tmpdir(), "mana-python-analyzer-"));
  const file = p.join(tmpdir, "danger.py");
  const content = "import os\nos.system('shutdown -h now')\n";
  fs.writeFileSync(file, content, "utf8");
  const res = spawnSync(PY, [script, file], {
    encoding: "utf8",
    timeout: 5000,
  });
  fs.rmSync(tmpdir, { recursive: true, force: true });
  assert.equal(
    res.status === 0 || res.status === null,
    true,
    `python script failed: ${res.stderr || ""}`,
  );
  const parsed = JSON.parse(res.stdout || "[]");
  assert.ok(
    parsed.some(
      (p) =>
        p.type &&
        String(p.message || "")
          .toLowerCase()
          .includes("os.system"),
    ),
    "should detect os.system from file path input",
  );
});

test("python_ast_analyzer reports parse error for invalid python", () => {
  const bad = "def foo(:\n  pass\n";
  const res = spawnSync(PY, [script], {
    input: bad,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(
    res.status === 0 || res.status === null,
    true,
    `python script invocation failed: ${res.stderr || ""}`,
  );
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || "[]");
  } catch (e) {
    throw new Error(
      "Failed to parse analyzer JSON for bad input: " + String(e),
    );
  }
  const hasParseError = parsed.some((p) => p.type === "parse_error");
  assert.ok(hasParseError, "expected parse_error for invalid python");
});
