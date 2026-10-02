const fs = require("fs");
const path = require("path");

const NODE_BOT_DIR = path.join(__dirname, "..");

// #1186/#1187: these folders hold live data -- voice uploads in tmp/, and
// pending file-write approvals the launcher shows as toasts. A test must
// point the env var at its own temp dir; falling back to the real folder
// under the test runner throws instead of leaving files behind there.
function liveDir(envVar, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) {
    throw new Error(`${envVar} is unset in a test run; refusing to use ${fallback}`);
  }
  return fallback;
}

const pendingWritesDir = () =>
  liveDir("MANA_PENDING_WRITES_DIR", path.join(NODE_BOT_DIR, "data", "pending_writes"));
const uploadTmpDir = () => liveDir("MANA_UPLOAD_TMP_DIR", path.join(NODE_BOT_DIR, "tmp"));

// multer diskStorage destination: looked up per upload rather than once at
// startup, so a test's MANA_UPLOAD_TMP_DIR applies.
function uploadDestination(req, file, cb) {
  try {
    const dir = uploadTmpDir();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  } catch (e) {
    cb(e);
  }
}

module.exports = { pendingWritesDir, uploadTmpDir, uploadDestination };
