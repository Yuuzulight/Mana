const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1500000;
const MAX_CODE_CHARS = 40000;
const HELPER_PATH = path.join(__dirname, "..", "..", "tools", "analysis-sandbox", "bundle", "Mana.AnalysisSandbox.exe");
const RUNTIME_DIR = path.join(__dirname, "..", "data", "analysis-python");
const BUNDLED_RUNTIME_DIRS = [
  path.join(__dirname, "..", "..", "desktop-client", "portable-python", "analysis"),
  path.join(__dirname, "..", "..", "portable-python", "analysis"),
];

function prepareBundledRuntime(runtimeDir = RUNTIME_DIR) {
  if (fs.existsSync(path.join(runtimeDir, "python.exe"))) return;
  const bundled = BUNDLED_RUNTIME_DIRS.find((dir) => fs.existsSync(path.join(dir, "python.exe")));
  if (!bundled) throw new Error("The bundled analysis Python runtime is unavailable");
  // The installed bundle stays read-only; per-run access grants use this private copy.
  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });
  fs.cpSync(bundled, runtimeDir, { recursive: true, errorOnExist: true, force: false });
}

function isAnalysisAvailable(env = process.env) {
  if (process.platform !== "win32" || !fs.existsSync(env.MANA_ANALYSIS_HELPER || HELPER_PATH)) return false;
  return [env.MANA_ANALYSIS_PYTHON_DIR || RUNTIME_DIR, ...BUNDLED_RUNTIME_DIRS]
    .some((dir) => fs.existsSync(path.join(dir, "python.exe")));
}

function runProcess(command, args, { input = "", timeoutMs = 75000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    let output = "", errors = "", bytes = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (!child.pid) { reject(error); return; }
        child.once("close", () => reject(error));
        if (!child.kill()) reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("analysis helper timed out")), timeoutMs);
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) { finish(new Error("analysis helper output limit exceeded")); return; }
        if (isError) errors += chunk; else output += chunk;
      });
    }
    child.on("close", (code) => finish(null, { code, output, errors }));
    child.stdin.end(input);
  });
}

let analysisQueue = Promise.resolve();
function runAnalysisSandbox(payload, options = {}) {
  const next = analysisQueue.then(() => runOneAnalysis(payload, options));
  analysisQueue = next.catch(() => {});
  return next;
}

async function runOneAnalysis(payload, options = {}) {
  if ((options.platform || process.platform) !== "win32") throw new Error("Windows AppContainer is required for analysis");
  if (typeof payload?.code !== "string" || !payload.code.trim() || payload.code.length > MAX_CODE_CHARS) throw new Error(`code must contain 1 to ${MAX_CODE_CHARS} characters`);
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("analysis sandbox input limit exceeded");
  const run = options.runProcess || runProcess;
  const timeout = Math.min(60000, Math.max(100, Number(options.timeoutMs) || 60000));
  const helper = options.helperPath || HELPER_PATH;
  const runtime = options.runtimeDir || RUNTIME_DIR;
  if (!options.runProcess) prepareBundledRuntime(runtime);
  const work = path.join(os.tmpdir(), `Mana.Analysis.${randomUUID().replaceAll("-", "")}`);
  let result;
  try {
    result = await run(helper, [runtime, work, String(timeout)], { input, timeoutMs: timeout + 15000 });
  } finally {
    // The helper's finally cannot run if Windows forcibly terminates it.
    // Revoke its per-run ACL and profile before reporting completion.
    const cleanup = await run(helper, ["--cleanup", runtime, work], { timeoutMs: 15000 });
    if (cleanup.code !== 0) throw new Error(`analysis cleanup failed: ${cleanup.errors.slice(-2000)}`);
    if (fs.existsSync(work)) throw new Error("analysis cleanup left its scratch directory behind");
  }
  if (result.code !== 0) throw new Error(`analysis sandbox failed: ${result.errors.slice(-2000)}`);
  const parsed = JSON.parse(result.output);
  if (!parsed || typeof parsed.logs !== "string" || !Array.isArray(parsed.charts)) throw new Error("invalid analysis sandbox response");
  const charts = parsed.charts.slice(0, 4).flatMap((chart) => {
    if (typeof chart?.data !== "string" || chart.data.length > 342000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chart.data)) return [];
    const bytes = Buffer.from(chart.data, "base64");
    if (bytes.length < 24 || bytes.length > 256000 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") return [];
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 4000000) return [];
    return [{ name: "Analysis chart", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` }];
  });
  return { logs: parsed.logs.slice(0, 20000), error: parsed.error ? String(parsed.error).slice(0, 4000) : null, charts };
}

module.exports = { runAnalysisSandbox, runProcess, prepareBundledRuntime, isAnalysisAvailable, MAX_INPUT_BYTES, MAX_CODE_CHARS, HELPER_PATH, RUNTIME_DIR };
