const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testDir = path.join(__dirname, "..", "test");
const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.js"));

const results = [];
for (const f of files) {
  const full = path.join(testDir, f);
  console.log("Running", f);
  const r = spawnSync("node", ["--test", full], {
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300000,
  });
  const ok = r.status === 0;
  results.push({
    file: f,
    ok,
    status: r.status,
    stdout: r.stdout ? String(r.stdout).slice(0, 8000) : "",
    stderr: r.stderr ? String(r.stderr).slice(0, 8000) : "",
  });
  console.log(`  -> ${ok ? "PASS" : "FAIL"} (code=${r.status})`);
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log("\nSummary:");
console.log(`  total: ${results.length}`);
console.log(`  passed: ${passed}`);
console.log(`  failed: ${failed}`);
for (const r of results) {
  if (!r.ok) {
    console.log("--- FAIL:", r.file, "status=", r.status);
    console.log(r.stdout || r.stderr);
  }
}

if (failed > 0) process.exit(1);
