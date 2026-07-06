const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "python_token_cache.py");
const PY_BIN = process.env.PYTHON || "python";

function writeTemp(text, ext = ".py") {
  const tmp = path.join(
    os.tmpdir(),
    `mana-token-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );
  fs.writeFileSync(tmp, text, "utf8");
  return tmp;
}

function cleanup(pathStr) {
  try {
    fs.unlinkSync(pathStr);
  } catch (e) {}
}

// Synchronous, returns token count (number) or throws
function countTokensForTextSync(text, ext = ".py", rebuild = false) {
  const tmp = writeTemp(text, ext);
  try {
    const args = [PY_SCRIPT, "--path", tmp, "--json"];
    if (rebuild) args.push("--rebuild");
    const res = spawnSync(PY_BIN, args, { encoding: "utf8", timeout: 20000 });
    if (res.error) throw res.error;
    if (res.status !== 0 && !res.stdout) {
      throw new Error(res.stderr || `python exited ${res.status}`);
    }
    const out = res.stdout || res.stderr || "";
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed.tokens === "number") return parsed.tokens;
      // If whole cache printed, attempt to find our file key
      const key = tmp;
      if (parsed && parsed[key] && typeof parsed[key].tokens === "number")
        return parsed[key].tokens;
    } catch (e) {
      // not JSON? try to parse any JSON substring
      const j = out.match(/\{[\s\S]*\}/);
      if (j) {
        try {
          const parsed = JSON.parse(j[0]);
          const key = tmp;
          if (parsed && parsed[key] && typeof parsed[key].tokens === "number")
            return parsed[key].tokens;
        } catch (e2) {}
      }
    }
    // Fallback: attempt to parse any integer in stdout
    const m = (out || "").match(/"tokens"\s*:\s*(\d+)/);
    if (m) return Number(m[1]);
    throw new Error(
      "unable to determine token count from python script output",
    );
  } finally {
    cleanup(tmp);
  }
}

// Synchronous wrapper for counting tokens for a file path
function countTokensForPathSync(filePath, rebuild = false) {
  if (!fs.existsSync(filePath)) throw new Error("file not found: " + filePath);
  const args = [PY_SCRIPT, "--path", filePath, "--json"];
  if (rebuild) args.push("--rebuild");
  const res = spawnSync(PY_BIN, args, { encoding: "utf8", timeout: 20000 });
  if (res.error) throw res.error;
  if (res.status !== 0 && !res.stdout) {
    throw new Error(res.stderr || `python exited ${res.status}`);
  }
  const out = res.stdout || res.stderr || "";
  try {
    const parsed = JSON.parse(out);
    const key = require("path").resolve(filePath);
    if (parsed && parsed[key] && typeof parsed[key].tokens === "number")
      return parsed[key].tokens;
    // If a single entry was returned, it may be directly the entry
    if (parsed && typeof parsed.tokens === "number") return parsed.tokens;
  } catch (e) {
    const m = (out || "").match(/"tokens"\s*:\s*(\d+)/);
    if (m) return Number(m[1]);
  }
  throw new Error("unable to parse token count from python script output");
}

module.exports = {
  countTokensForTextSync,
  countTokensForPathSync,
};
