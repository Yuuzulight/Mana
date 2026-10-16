// Arcana (Yuuzulight/Arcana, Obscura inside) as Mana's own browser: run its
// `serve` CDP endpoint and attach Playwright to it, so the session code in
// browser-automation.js reads and acts on it as on any Chromium. Headless
// only -- Take over still opens Edge (index.js).
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");

const DEFAULT_ARCANA_DIR = "C:\\ManaAI\\Arcana";
const READY_TIMEOUT_MS = 15000;

// MANA_ARCANA_CLI: the Arcana.Cli.dll to run; else a build under ARCANA_DIR.
function resolveCli(env, fsLike = fs) {
  if (env.MANA_ARCANA_CLI) return fsLike.existsSync(env.MANA_ARCANA_CLI) ? env.MANA_ARCANA_CLI : null;
  const bin = path.join(env.MANA_ARCANA_DIR || DEFAULT_ARCANA_DIR, "src", "Arcana.Cli", "bin");
  for (const config of ["Release", "Debug"]) {
    const dll = path.join(bin, config, "net10.0", "Arcana.Cli.dll");
    if (fsLike.existsSync(dll)) return dll;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function versionUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => req.destroy());
  });
}

// The process and its worker children: a plain kill() leaves the worker.
function killTree(child) {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null) return resolve();
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => resolve());
  });
}

// Starts `Arcana.Cli serve` on a free loopback port and returns
// { endpoint, stop }. Private-network pages stay off (Arcana's default), so
// a page can't reach Mana's own services. storageDir keeps local storage.
async function startArcana(env, { storageDir, spawnFn = spawn } = {}) {
  const cli = resolveCli(env);
  if (!cli) throw new Error("Arcana isn't built -- set MANA_ARCANA_CLI, or build it at " + (env.MANA_ARCANA_DIR || DEFAULT_ARCANA_DIR));
  const port = await freePort();
  const args = [cli, "serve", `--port=${port}`, "--quiet"];
  if (storageDir) {
    fs.mkdirSync(storageDir, { recursive: true });
    args.push(`--storage-dir=${storageDir}`);
  }
  const child = spawnFn("dotnet", args, { stdio: "ignore", windowsHide: true });
  let exited = false;
  child.once("exit", () => (exited = true));
  child.once("error", () => (exited = true));
  const stop = () => killTree(child);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await versionUp(port))) {
    if (exited || Date.now() > deadline) {
      await stop();
      throw new Error("Arcana didn't start");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { endpoint: `http://127.0.0.1:${port}`, stop, child };
}

// A Playwright context on Arcana. close() also stops the engine; the
// context's own "close" fires when Arcana goes away.
async function launchArcana(chromium, env, options = {}) {
  const arcana = await startArcana(env, options);
  try {
    const browser = await chromium.connectOverCDP(arcana.endpoint);
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const close = ctx.close.bind(ctx);
    ctx.close = async () => {
      await close().catch(() => {});
      await browser.close().catch(() => {});
      await arcana.stop();
    };
    browser.once("disconnected", () => arcana.stop());
    return ctx;
  } catch (e) {
    await arcana.stop();
    throw e;
  }
}

module.exports = { launchArcana, startArcana, resolveCli };
