// Issue #358: the market tools answer "what is this worth now". This adds
// "where is it heading", which is a different and harder question they did
// not attempt.
//
// Shells out to forecast-service/forecast.py, the same shape as the other
// Python helpers (utils/reply-verifier.js, the retriever). One-shot rather
// than a resident service: forecasting happens when somebody asks a market
// question, not continuously, and a long-lived process would hold RAM the
// model stack wants.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT_PATH = path.join(__dirname, "..", "..", "forecast-service", "forecast.py");
const DEFAULT_TIMEOUT_MS = 120000;

// The service ships its own venv, because torch and the LLM stack have no
// reason to share a dependency set.
function defaultPython() {
  if (process.env.MANA_FORECAST_PYTHON) return process.env.MANA_FORECAST_PYTHON;
  const venv = path.join(__dirname, "..", "..", "forecast-service", "venv", "Scripts", "python.exe");
  return venv;
}

// options.runScript: injectable so tests never spawn a real process or load
// a real model -- the interesting logic here is what happens around the
// call, not inside it.
function createMarketForecaster(options = {}) {
  const pythonBin = options.pythonBin || defaultPython();
  const timeout = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const runScript =
    options.runScript ||
    ((payload) =>
      spawnSync(pythonBin, [SCRIPT_PATH], {
        input: payload,
        encoding: "utf8",
        timeout,
        // Issue #388: no console flash.
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      }));

  // Never throws. A forecast is an addition to a market answer, so failing
  // to produce one must degrade that answer rather than break it -- the
  // price the user actually asked for is still correct.
  function forecast({ values = [], horizon = 7 } = {}) {
    // Number(null) is 0, and 0 is finite -- so a naive Number()+isFinite
    // filter lets a null through as a zero price, which is not missing data
    // but wrong data, and a forecaster would take it seriously. Empty and
    // nullish entries are rejected before conversion.
    const series = (Array.isArray(values) ? values : [])
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
    if (!series.length) {
      return { ok: false, reason: "no series to forecast" };
    }

    let result;
    try {
      result = runScript(JSON.stringify({ values: series, horizon }));
    } catch (e) {
      return { ok: false, reason: `forecast process failed: ${e.message || e}` };
    }
    if (!result || result.error) {
      return { ok: false, reason: `forecast process failed: ${result?.error?.message || "unknown"}` };
    }
    if (result.status !== 0) {
      return { ok: false, reason: `forecast exited ${result.status}` };
    }

    // The script reports its own failures as ok:false JSON rather than a
    // non-zero exit, so a missing model or an offline machine arrives here
    // as a readable reason instead of a stack trace.
    try {
      const parsed = JSON.parse(String(result.stdout || "").trim().split("\n").pop());
      return parsed && typeof parsed === "object" ? parsed : { ok: false, reason: "unparseable forecast" };
    } catch (e) {
      return { ok: false, reason: "unparseable forecast output" };
    }
  }

  return { forecast, scriptPath: SCRIPT_PATH };
}

module.exports = { createMarketForecaster };
