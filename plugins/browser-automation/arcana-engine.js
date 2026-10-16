// Arcana (Yuuzulight/Arcana, Obscura inside) as Mana's own browser: run its
// `serve` CDP endpoint and attach Playwright to it, so the session code in
// browser-automation.js reads and acts on it as on any Chromium. Headless
// only -- Take over still opens Edge (index.js).
const domShim = require("./arcana-dom-shim");
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");

const DEFAULT_ARCANA_DIR = "C:\\ManaAI\\Arcana";
// What tools/install-arcana.ps1 publishes.
const INSTALLED_CLI = path.resolve(__dirname, "../../node-bot/runtime/arcana/Arcana.Cli.dll");
const READY_TIMEOUT_MS = 15000;

// MANA_ARCANA_CLI: the Arcana.Cli.dll to run; else a build under
// MANA_ARCANA_DIR; else the pinned install; else a build at the default dir.
function resolveCli(env, fsLike = fs) {
  if (env.MANA_ARCANA_CLI) return fsLike.existsSync(env.MANA_ARCANA_CLI) ? env.MANA_ARCANA_CLI : null;
  if (!env.MANA_ARCANA_DIR && fsLike.existsSync(INSTALLED_CLI)) return INSTALLED_CLI;
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
  if (!cli) throw new Error("Arcana isn't installed -- run tools/install-arcana.ps1, set MANA_ARCANA_CLI, or build it at " + (env.MANA_ARCANA_DIR || DEFAULT_ARCANA_DIR));
  const port = await freePort();
  // --arcana-parent-pid: Arcana stops itself if this process dies without cleaning up.
  const args = [cli, "serve", `--port=${port}`, "--quiet", `--arcana-parent-pid=${process.pid}`];
  if (storageDir) {
    fs.mkdirSync(storageDir, { recursive: true });
    args.push(`--storage-dir=${storageDir}`);
  }
  // Off unless asked for: a page must not reach Mana's own services.
  if (env.MANA_ARCANA_ALLOW_PRIVATE_NETWORK === "1") args.push("--allow-private-network");
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

// One JSON line per engine event, so a week of use can be counted (Arcana's M2
// exit: no unexplained fallback to Edge). Logging must never break browsing.
function recordEvent(file, type, details = {}) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), type, ...details }) + "\n");
  } catch { /* best effort */ }
}

// A Playwright context on Arcana. close() also stops the engine; the
// context's own "close" fires when Arcana goes away. onEvent hears
// "arcana_disconnected" when Arcana dies without being asked to close.
async function launchArcana(chromium, env, options = {}) {
  const arcana = await startArcana(env, options);
  try {
    const browser = await chromium.connectOverCDP(arcana.endpoint);
    const ctx = browser.contexts()[0] || (await browser.newContext());
    await ctx.addInitScript(domShim.script);
    ctx.arcana = true;
    const close = ctx.close.bind(ctx);
    let closing = false;
    ctx.close = async () => {
      closing = true;
      await close().catch(() => {});
      await browser.close().catch(() => {});
      await arcana.stop();
    };
    browser.once("disconnected", () => {
      if (!closing) options.onEvent?.("arcana_disconnected");
      arcana.stop();
    });
    return ctx;
  } catch (e) {
    await arcana.stop();
    throw e;
  }
}

module.exports = { launchArcana, startArcana, resolveCli, recordEvent };
