// #1158: downloads from her browser. Each one waits, in a pending folder
// under node-bot/data, for my OK in Approvals (every time, never
// "always"); approved, it goes into one folder (MANA_BROWSER_DOWNLOAD_DIR,
// default Downloads\Mana) marked as from the internet (Windows'
// Zone.Identifier), and the chat says where it is. She never opens or
// reads it.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ACTION_TYPE = "browser-download";
// Denied downloads (the gate never tells us) and ones from before a
// restart are swept after this long.
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// A plain file name: no folders, no characters Windows refuses.
function safeName(name) {
  const base = path.basename(String(name || "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return base.slice(0, 150) || "download";
}

// name.ext, then "name (2).ext", ... so nothing is overwritten.
function freePath(dir, name) {
  const { name: stem, ext } = path.parse(name);
  for (let n = 1; ; n += 1) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname || "a web page";
  } catch (e) {
    return "a web page";
  }
}

function createBrowserDownloads(options = {}) {
  const approvalGate = options.approvalGate;
  const dir = options.dir || process.env.MANA_BROWSER_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads", "Mana");
  const pendingDir = options.pendingDir || path.join(__dirname, "..", "..", "node-bot", "data", "browser-downloads-pending");
  const notify = options.notify || (() => {});
  const now = options.now || Date.now;
  const waiting = new Map();

  approvalGate.registerExecutor(ACTION_TYPE, async ({ id } = {}) => {
    const entry = waiting.get(id);
    if (!entry) throw new Error("that download isn't waiting any more (Mana restarted, or it was already saved)");
    fs.mkdirSync(dir, { recursive: true });
    const target = freePath(dir, entry.name);
    // Copy, not rename: the folders can be on different drives.
    fs.copyFileSync(entry.pendingPath, target);
    fs.rmSync(entry.pendingPath, { force: true });
    waiting.delete(id);
    try {
      fs.writeFileSync(`${target}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${entry.url}\r\n`);
    } catch (e) {
      // Not NTFS: no mark, the chat note still says where it came from.
    }
    await Promise.resolve(
      notify({
        type: "browser-download",
        title: "Mana saved a download",
        text: `Saved "${path.basename(target)}" from ${entry.host} to ${dir}. It came from a web page, so open it with care.`,
        url: target,
      }),
    ).catch(() => {});
    return { path: target };
  });

  function sweep() {
    let names = [];
    try {
      names = fs.readdirSync(pendingDir);
    } catch (e) {
      return;
    }
    for (const name of names) {
      const file = path.join(pendingDir, name);
      try {
        if (now() - fs.statSync(file).mtimeMs > PENDING_MAX_AGE_MS) fs.rmSync(file, { force: true });
      } catch (e) {
        // gone already
      }
    }
  }

  // A Playwright Download: saved to the pending folder, then asked about.
  async function handle(download) {
    sweep();
    const id = crypto.randomBytes(6).toString("hex");
    const name = safeName(download.suggestedFilename());
    const url = download.url();
    fs.mkdirSync(pendingDir, { recursive: true });
    const pendingPath = path.join(pendingDir, id);
    await download.saveAs(pendingPath);
    waiting.set(id, { pendingPath, name, host: hostOf(url), url });
    const result = await approvalGate.requestApproval(ACTION_TYPE, {
      summary: `Save "${name}" from ${hostOf(url)} to ${dir}`,
      payload: { id },
      forceReview: true,
    });
    return { name, status: result.status };
  }

  return { handle, dir };
}

module.exports = { createBrowserDownloads, safeName, ACTION_TYPE };
