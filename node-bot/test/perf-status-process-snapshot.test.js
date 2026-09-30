// /perf/status's process listing runs in the background (execFile, at most
// every 15 s) and never as a blocking spawnSync on the request path.
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const util = require("node:util");
const childProcess = require("node:child_process");

// server.js destructures these at require time, so fake them before requiring it.
const blocking = [];
const listed = [];
const realSpawnSync = childProcess.spawnSync;
const realExecFile = childProcess.execFile;
childProcess.spawnSync = (cmd, ...rest) => {
  blocking.push(String(cmd));
  return realSpawnSync(cmd, ...rest);
};
const fakeExecFile = (cmd, ...rest) => realExecFile(cmd, ...rest);
fakeExecFile[util.promisify.custom] = async (cmd, args) => {
  if (!/powershell/i.test(cmd)) return util.promisify(realExecFile)(cmd, args);
  listed.push(cmd);
  const rows = [
    { ProcessId: 42, Name: "node.exe", WorkingSetSize: 300 * 1024 * 1024, CommandLine: `node ${path.resolve(__dirname, "..", "server.js")}` },
    { ProcessId: 7, Name: "explorer.exe", WorkingSetSize: 1, CommandLine: "C:\\Windows\\explorer.exe" },
  ];
  return { stdout: JSON.stringify(rows), stderr: "" };
};
childProcess.execFile = fakeExecFile;
const { createApp, manaProcessesUnder } = require("../server");
const { withServer } = require("./helpers");
childProcess.spawnSync = realSpawnSync;
childProcess.execFile = realExecFile;

test("/perf/status answers at once and lists processes from the background read", async () => {
  await withServer(createApp(), async (baseUrl) => {
    const perf = async () => (await (await fetch(`${baseUrl}/perf/status`)).json()).process;
    const first = await perf();
    assert.ok(first.totalMemoryMb > 0, "the backend's own RSS until the first listing lands");
    await new Promise((resolve) => setImmediate(resolve));
    const second = await perf();
    if (process.platform === "win32") {
      assert.deepEqual(second.processes, [{ pid: 42, name: "node.exe", memoryMb: 300, role: "backend" }]);
      assert.equal(listed.length, 1, "at most one listing per 15 s");
    }
  });
  assert.deepEqual(blocking.filter((cmd) => /powershell/i.test(cmd)), []);
});

test("Mana's processes are found under whatever folder she's checked out in", () => {
  const rows = [
    { ProcessId: 1, Name: "node.exe", WorkingSetSize: 100 * 1024 * 1024, CommandLine: 'node "D:\\Mana\\node-bot\\server.js"' },
    { ProcessId: 2, Name: "python.exe", WorkingSetSize: 50 * 1024 * 1024, CommandLine: "python d:/mana/tts-service/kokoro_service.py" },
    { ProcessId: 3, Name: "node.exe", WorkingSetSize: 1, CommandLine: 'node "D:\\Mana-worktrees\\x\\node-bot\\server.js"' },
    { ProcessId: 4, Name: "node.exe", WorkingSetSize: 1, CommandLine: 'node "C:\\ManaAI\\Mana\\node-bot\\server.js"' },
  ];
  assert.deepEqual(manaProcessesUnder(rows, "D:\\Mana\\"), [
    { pid: 1, name: "node.exe", memoryMb: 100, role: "backend" },
    { pid: 2, name: "python.exe", memoryMb: 50, role: "kokoro tts" },
  ]);
});
