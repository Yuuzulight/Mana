const defaultFs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// #693: atomic llama.cpp build updates with rollback (Jan-style). A new
// build is downloaded to tools/llama/.staging, checksum-verified, extracted
// beside the current one and smoke-tested; only then does one small pointer
// file (tools/llama/active.json) switch to it. llama-server-runtime.js reads
// that pointer before its LLAMA_SERVER_BIN/LLAMA_BIN fallbacks, and swaps it
// back when the new build then fails to start. .env is never rewritten.
// tools/llama/ is gitignored as a whole, so the pointer and staging are too.

// ggml-org marks the numbered bNNNNN builds as prereleases, and its
// /releases/latest is a differently-tagged release with no binaries, so
// this lists recent releases and picks the highest bNNNNN itself.
const RELEASES_URL = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20";
const GITHUB_HEADERS = { "User-Agent": "Mana", Accept: "application/vnd.github+json" };
const POINTER_FILE = "active.json";

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

// "llama-b10507-bin-win-cuda-12.4-x64" -> { build: 10507, variant: "bin-win-cuda-12.4-x64" }
function parseBuildFolder(dir) {
  const match = /^llama-b(\d+)-(bin-[\w.-]+)$/.exec(path.win32.basename(String(dir || "")));
  return match ? { build: Number(match[1]), variant: match[2] } : null;
}

// One release's zip for this variant, plus the matching cudart runtime
// zip when the release publishes one (CUDA builds ship it separately and
// Mana's hand-installed build has those DLLs unpacked into the same folder).
function selectReleaseAssets(release, variant) {
  const tag = String(release?.tag_name || "");
  const tagMatch = /^b(\d+)$/.exec(tag);
  if (!tagMatch || release.draft) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const main = assets.find((asset) => asset.name === `llama-${tag}-${variant}.zip`);
  if (!main) return null;
  const cudart = assets.find((asset) => asset.name === `cudart-llama-${variant}.zip`);
  const picked = (cudart ? [main, cudart] : [main]).map((asset) => ({
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url,
    // GitHub's own per-asset digest; anything but a sha256 counts as missing.
    digest: /^sha256:[0-9a-f]{64}$/i.test(asset.digest || "") ? asset.digest.toLowerCase() : null,
  }));
  return {
    tag,
    build: Number(tagMatch[1]),
    folder: `llama-${tag}-${variant}`,
    assets: picked,
    digestAvailable: picked.every((asset) => asset.digest),
  };
}

function pickLatestRelease(releases, variant) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    const picked = selectReleaseAssets(release, variant);
    if (picked && (!best || picked.build > best.build)) best = picked;
  }
  return best;
}

// { active, previous, pendingVerification, installed, lastRollback } or
// null when the file is missing or unreadable -- callers then behave
// exactly as before this feature existed.
function readActivePointer(toolsDir, fs = defaultFs) {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(toolsDir, POINTER_FILE), "utf8"));
    if (!pointer || typeof pointer.active !== "string" || !pointer.active) return null;
    return {
      active: pointer.active,
      previous: typeof pointer.previous === "string" && pointer.previous ? pointer.previous : null,
      pendingVerification: pointer.pendingVerification === true,
      installed: Array.isArray(pointer.installed) ? pointer.installed.filter((d) => typeof d === "string") : [],
      lastRollback: pointer.lastRollback || null,
    };
  } catch (e) {
    return null;
  }
}

// Temp file + rename: a reader sees the old pointer or the new one, never
// a half-written file (fs.renameSync replaces an existing file on Windows).
function writeActivePointer(toolsDir, pointer, fs = defaultFs) {
  const file = path.join(toolsDir, POINTER_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2));
  fs.renameSync(tmp, file);
}

function swapBuilds(pointer) {
  return { ...pointer, active: pointer.previous, previous: pointer.active, pendingVerification: false, lastRollback: null };
}

// The pointer to switch to after llama-server failed to start, or null
// when there's nothing to roll back: only a build an update just switched
// to (pendingVerification) is ever rolled back automatically.
function rollbackPointer(pointer, reason, at) {
  if (!pointer?.pendingVerification || !pointer.previous) return null;
  return { ...swapBuilds(pointer), lastRollback: { from: pointer.active, to: pointer.previous, reason, at } };
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// Keep the active and previous builds; only folders Mana itself installed
// directly under toolsDir are ever candidates, and never one that
// LLAMA_SERVER_BIN/LLAMA_BIN points into (the user's hand-installed build).
function buildsToPrune(pointer, toolsDir, protectedDirs = []) {
  const keep = [pointer.active, pointer.previous, ...protectedDirs].filter(Boolean);
  return pointer.installed.filter(
    (dir) => samePath(path.dirname(dir), toolsDir) && !keep.some((k) => samePath(k, dir)),
  );
}

// Called by llama-server-runtime.js after it spawned llama-server from
// binDir: a clean start confirms an update-installed build, a failed one
// rolls it back. A start that ran some other build (the pointer changed
// mid-start, or its folder lost llama-server.exe) proves nothing either
// way. Returns the pointer written, or null when nothing changed.
function settleActiveBuild(toolsDir, fs, binDir, startError, now = () => new Date().toISOString()) {
  const pointer = readActivePointer(toolsDir, fs);
  if (!pointer?.pendingVerification) return null;
  if (path.win32.normalize(binDir).toLowerCase() !== path.win32.normalize(pointer.active).toLowerCase()) return null;
  const next = startError
    ? rollbackPointer(pointer, String(startError.message || startError).slice(0, 500), now())
    : { ...pointer, pendingVerification: false };
  if (!next) return null;
  writeActivePointer(toolsDir, next, fs);
  return next;
}

// Same Expand-Archive-via-env-vars approach as plugin-store.js's
// installFromZip (no zip dependency in this codebase, and no string
// interpolation of paths into the PowerShell command).
function defaultExtractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $env:MANA_LLAMA_ZIP -DestinationPath $env:MANA_LLAMA_DEST -Force",
      ],
      { windowsHide: true, env: { ...process.env, MANA_LLAMA_ZIP: zipPath, MANA_LLAMA_DEST: destDir } },
      (error) => (error ? reject(new Error(`Failed to extract ${path.basename(zipPath)}: ${error.message}`)) : resolve()),
    );
  });
}

function defaultRunVersion(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ["--version"], { windowsHide: true, timeout: 30000, cwd: path.dirname(bin) }, (error, stdout, stderr) =>
      error
        ? reject(new Error(`llama-server --version failed: ${error.message}`))
        : resolve(`${stdout}${stderr}`.trim()),
    );
  });
}

function createLlamaBuildManager(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const fetchImpl = options.fetch || globalThis.fetch;
  const toolsDir = options.toolsDir || path.resolve(__dirname, "..", "tools", "llama");
  const extractZip = options.extractZip || defaultExtractZip;
  const runVersion = options.runVersion || defaultRunVersion;
  const findLlamaServerBin = options.findLlamaServerBin;
  const stopServer = options.stopServer || (() => {});
  let job = null; // { state: "running" | "done" | "failed", tag, step, error }

  function protectedDirs() {
    return [env.LLAMA_SERVER_BIN, env.LLAMA_BIN].filter(Boolean).map((bin) => path.dirname(bin));
  }

  function currentBuild() {
    const dir = path.dirname(findLlamaServerBin());
    const parsed = parseBuildFolder(dir);
    if (!parsed) {
      throw codedError(
        `Can't tell which llama.cpp build is active from its folder name (${dir}); updates need a llama-bNNNNN-bin-... folder.`,
        "unknown_variant",
      );
    }
    return { dir, ...parsed };
  }

  function getStatus() {
    let current = null;
    let currentError = null;
    try {
      current = currentBuild();
    } catch (e) {
      currentError = e.message;
    }
    const pointer = readActivePointer(toolsDir, fs);
    return {
      current,
      currentError,
      previous: pointer?.previous || null,
      lastRollback: pointer?.lastRollback || null,
      job,
    };
  }

  async function check() {
    const current = currentBuild();
    const response = await fetchImpl(RELEASES_URL, { headers: GITHUB_HEADERS });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed: HTTP ${response.status}`);
    }
    const latest = pickLatestRelease(await response.json(), current.variant);
    if (!latest) {
      throw new Error(`No recent llama.cpp release has a ${current.variant} build.`);
    }
    return { current, latest, updateAvailable: latest.build > current.build };
  }

  // Streams to disk while hashing, so a ~400MB zip is never held in memory.
  async function download(url, dest) {
    const response = await fetchImpl(url, { headers: { "User-Agent": GITHUB_HEADERS["User-Agent"] } });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    }
    const hash = crypto.createHash("sha256");
    // #1124: bytes so far, for the Background tasks panel's progress bar.
    const progress = { done: 0, total: Number(response.headers?.get?.("content-length")) || null, since: Date.now() };
    if (job) job.download = progress;
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          progress.done += chunk.length;
          yield chunk;
        }
      },
      fs.createWriteStream(dest),
    );
    return `sha256:${hash.digest("hex")}`;
  }

  async function install(current, latest, target) {
    const staging = path.join(toolsDir, ".staging");
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    try {
      // Every archive is downloaded and verified before anything is
      // extracted, and nothing outside `target` and .staging is touched.
      const zips = [];
      for (const asset of latest.assets) {
        job.step = `Downloading ${asset.name}`;
        const zip = path.join(staging, asset.name);
        const actual = await download(asset.url, zip);
        if (asset.digest && actual !== asset.digest) {
          throw new Error(`Checksum mismatch for ${asset.name}: expected ${asset.digest}, got ${actual}. Nothing was installed.`);
        }
        zips.push(zip);
        job.download = null;
      }
      for (const zip of zips) {
        job.step = `Extracting ${path.basename(zip)}`;
        await extractZip(zip, target);
      }
      job.step = "Testing llama-server --version";
      await runVersion(path.join(target, "llama-server.exe"));
    } catch (e) {
      fs.rmSync(target, { recursive: true, force: true });
      throw e;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }

    const pointer = readActivePointer(toolsDir, fs);
    const next = {
      active: target,
      previous: current.dir,
      pendingVerification: true,
      installed: [...(pointer?.installed || []), target],
      lastRollback: null,
    };
    for (const dir of buildsToPrune(next, toolsDir, protectedDirs())) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        next.installed = next.installed.filter((d) => d !== dir);
      } catch (e) {
        // Left in `installed` so the next update retries it.
        console.warn(`llama.cpp update: could not prune ${dir}: ${e.message}`);
      }
    }
    writeActivePointer(toolsDir, next, fs);
    // The next reply restarts llama-server on the new build, which is what
    // confirms it (or rolls it back) -- see settleActiveBuild.
    stopServer();
  }

  // Only ever runs on an explicit user request (the Model tab's Update
  // button); nothing here schedules downloads on its own.
  async function startUpdate({ allowMissingDigest = false } = {}) {
    if (job?.state === "running") throw codedError("A llama.cpp update is already running.", "busy");
    job = { state: "running", tag: null, step: "Checking for update", error: null };
    let checked;
    try {
      checked = await check();
      if (!checked.updateAvailable) {
        throw codedError(`Already on the newest build (b${checked.current.build}).`, "up_to_date");
      }
      if (!checked.latest.digestAvailable && !allowMissingDigest) {
        throw codedError(
          `${checked.latest.tag} has no published SHA-256 digest, so the download can't be verified.`,
          "digest_missing",
        );
      }
      if (fs.existsSync(path.join(toolsDir, checked.latest.folder))) {
        throw codedError(`${checked.latest.folder} is already installed; use Roll back to switch to it.`, "exists");
      }
    } catch (e) {
      job = null;
      throw e;
    }
    const { current, latest } = checked;
    job.tag = latest.tag;
    install(current, latest, path.join(toolsDir, latest.folder)).then(
      () => {
        job = { state: "done", tag: latest.tag, step: `Switched to ${latest.tag}`, error: null };
      },
      (e) => {
        console.warn(`llama.cpp update to ${latest.tag} failed: ${e.message}`);
        job = { state: "failed", tag: latest.tag, step: null, error: e.message };
      },
    );
    return { started: true, tag: latest.tag };
  }

  function rollback() {
    if (job?.state === "running") throw codedError("A llama.cpp update is still running.", "busy");
    const pointer = readActivePointer(toolsDir, fs);
    if (!pointer?.previous) throw codedError("There is no previous llama.cpp build to roll back to.", "no_previous");
    if (!fs.existsSync(path.join(pointer.previous, "llama-server.exe"))) {
      throw codedError(`The previous build is gone (${pointer.previous}).`, "no_previous");
    }
    writeActivePointer(toolsDir, swapBuilds(pointer), fs);
    stopServer();
    return getStatus();
  }

  return { getStatus, check, startUpdate, rollback };
}

module.exports = {
  buildsToPrune,
  createLlamaBuildManager,
  parseBuildFolder,
  pickLatestRelease,
  readActivePointer,
  rollbackPointer,
  selectReleaseAssets,
  settleActiveBuild,
  writeActivePointer,
};
