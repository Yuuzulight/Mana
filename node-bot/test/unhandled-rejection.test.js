const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("an unhandled rejection is logged and the process keeps running", () => {
  const modulePath = path.join(__dirname, "..", "utils", "unhandled-rejection.js");
  const script = `
    require(${JSON.stringify(modulePath)}).keepRunningOnUnhandledRejection();
    Promise.reject(new Error("boom from a route"));
    setTimeout(() => console.log("still alive"), 100);
  `;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000 });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /still alive/);
  assert.match(run.stderr, /Unhandled promise rejection \(kept running\):.*boom from a route/s);
});
