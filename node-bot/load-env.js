const fs = require("fs");
const path = require("path");
const { parseEnv } = require("util");

// node-bot/.env was documented as Mana's config file (tools/setup-mana.ps1,
// .env.sample, docs) but nothing ever loaded it -- the backend only saw
// whatever the launcher or the user's Windows environment happened to pass.
// .env values win over inherited ones on purpose: it is the file the user
// edits, and stale user-level variables (old paths, deleted models) must not
// silently override it. A missing file is fine (env-only setups keep
// working). Returns the keys it set.
function loadEnvFile(filePath = path.join(__dirname, ".env"), env = process.env) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const parsed = parseEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    env[key] = value;
  }
  return Object.keys(parsed);
}

module.exports = { loadEnvFile };
