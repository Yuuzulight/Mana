const path = require("node:path");
const { execFile: defaultExecFile } = require("node:child_process");

// Stopping a spawned helper (llama-server, the reranker, Kokoro) for real --
// shared by ai/llama-server-runtime.js (#750) and utils/on-demand-process.js.

// Live run (2026-09-29): taskkill /T also takes anything the child started
// itself; child.kill() is TerminateProcess on the direct child only.
// execFile with an args array and an integer pid -- no shell -- and a full
// path, since a bare name is looked up in the cwd first. A child that has
// already exited is left alone: its pid may belong to something else now.
function killProcessTree(child, { platform = process.platform, execFile = defaultExecFile, env = process.env } = {}) {
  if (child.exitCode != null || child.signalCode != null) return;
  const fallback = () => {
    try {
      child.kill();
    } catch (e) {}
  };
  if (platform !== "win32" || !Number.isInteger(child.pid)) return fallback();
  execFile(
    path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"],
    { windowsHide: true },
    (error) => error && fallback(),
  );
}

// Resolves true once the child has exited, or false (with a warning) if it
// is still running after STOP_WAIT_MS. CUDA / Python teardown takes several
// seconds after the kill, and the port stays bound until the process is gone.
const STOP_WAIT_MS = 15000;
function waitForExit(child, name) {
  // No pid: spawn itself failed, so there is no process and no 'exit'.
  if (child.exitCode != null || child.signalCode != null || child.pid === undefined) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`${name} (pid ${child.pid}) is still running ${STOP_WAIT_MS}ms after being stopped`);
      resolve(false);
    }, STOP_WAIT_MS);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

module.exports = { killProcessTree, waitForExit };
