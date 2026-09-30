// getGamingStatus() (/gaming/status, /perf/status, every spoken reply)
// reads the gaming watch's cached answer, never a blocking tasklist.
const assert = require("node:assert/strict");
const test = require("node:test");
const childProcess = require("node:child_process");

// server.js destructures spawnSync at require time, so record before requiring it.
const spawned = [];
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (cmd, ...rest) => {
  spawned.push(String(cmd));
  return realSpawnSync(cmd, ...rest);
};
const { createApp } = require("../server");
const { withServer, useTestAdminToken } = require("./helpers");

// Every route but a few public ones needs an admin key (admin-key.js).
const fetch = useTestAdminToken();
childProcess.spawnSync = realSpawnSync;

test("/gaming/status doesn't run tasklist", async () => {
  await withServer(createApp(), async (baseUrl) => {
    const gaming = await (await fetch(`${baseUrl}/gaming/status`)).json();
    assert.equal(gaming.ok, true);
    assert.equal(gaming.gamingAppRunning, false, "no poll has run in tests");
    assert.deepEqual(gaming.matchedProcesses, []);
    assert.ok(gaming.watchedProcesses.length > 0);
  });
  assert.deepEqual(spawned.filter((cmd) => /tasklist/i.test(cmd)), []);
});
