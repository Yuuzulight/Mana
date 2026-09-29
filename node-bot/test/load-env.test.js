const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadEnvFile, plainTextSecretKeys, readKeyringSecrets } = require("../load-env");

function writeTempEnv(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-load-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, text);
  return file;
}

test("loadEnvFile sets .env values, overriding inherited ones, and keeps Windows paths intact", () => {
  const file = writeTempEnv(
    [
      "# comment",
      "LLAMA_MODEL=D:\\models\\new.gguf",
      "MANA_RELATED_FACTS_MAX_CHARS=800 # inline comment",
      'FISH_TTS_REF_TEXT="Quoted, with # inside"',
      "",
    ].join("\r\n"),
  );
  const env = { LLAMA_MODEL: "C:\\stale\\deleted.gguf", UNRELATED: "kept" };

  const keys = loadEnvFile(file, env);

  assert.deepEqual(keys.sort(), ["FISH_TTS_REF_TEXT", "LLAMA_MODEL", "MANA_RELATED_FACTS_MAX_CHARS"]);
  assert.equal(env.LLAMA_MODEL, "D:\\models\\new.gguf");
  assert.equal(env.MANA_RELATED_FACTS_MAX_CHARS, "800");
  assert.equal(env.FISH_TTS_REF_TEXT, "Quoted, with # inside");
  assert.equal(env.UNRELATED, "kept");
});

test("loadEnvFile is a no-op when the file doesn't exist", () => {
  const env = { A: "1" };
  assert.deepEqual(loadEnvFile(path.join(os.tmpdir(), "mana-no-such-dir", ".env"), env), []);
  assert.deepEqual(env, { A: "1" });
});

test("loadEnvFile resolves keyring:/op:// references and never leaves reference text or secrets behind", () => {
  const file = writeTempEnv(
    [
      "MANA_DISCORD_BOT_TOKEN=keyring:Mana/discord",
      "MANA_MATRIX_ACCESS_TOKEN=keyring:Mana/missing",
      "MANA_TELEGRAM_BOT_TOKEN=op://Private/Telegram/token",
      "ALPHA_VANTAGE_API_KEY=op://Private/Missing/key",
      "OPENAI_API_KEY=sk-plain-fake",
      "MOBILE_TOTP_SECRET=",
      "LLAMA_CONTEXT=16384",
    ].join("\n"),
  );
  // Inherited reference text (the native launcher loads .env into its own
  // environment first) must not survive a failed lookup.
  const env = { MANA_MATRIX_ACCESS_TOKEN: "keyring:Mana/missing" };
  const warnings = [];
  const keyringCalls = [];

  const keys = loadEnvFile(file, env, {
    readKeyring: (targets) => {
      keyringCalls.push(targets);
      return targets.map((t) => (t === "Mana/discord" ? "discord-fake" : null));
    },
    readOnePassword: (ref) => {
      if (ref === "op://Private/Telegram/token") return "telegram-fake";
      throw new Error("op read failed: isn't an item");
    },
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(keyringCalls, [["Mana/discord", "Mana/missing"]]);
  assert.equal(env.MANA_DISCORD_BOT_TOKEN, "discord-fake");
  assert.equal(env.MANA_TELEGRAM_BOT_TOKEN, "telegram-fake");
  assert.equal("MANA_MATRIX_ACCESS_TOKEN" in env, false);
  assert.equal("ALPHA_VANTAGE_API_KEY" in env, false);
  assert.deepEqual(keys.sort(), [
    "LLAMA_CONTEXT",
    "MANA_DISCORD_BOT_TOKEN",
    "MANA_TELEGRAM_BOT_TOKEN",
    "MOBILE_TOTP_SECRET",
    "OPENAI_API_KEY",
  ]);
  // Q18: plain-text secrets aren't warned about at startup (Doctor names
  // them), and no secret value appears anywhere.
  assert.equal(warnings.length, 2);
  const log = warnings.join("\n");
  assert.match(log, /MANA_MATRIX_ACCESS_TOKEN: no Credential Manager entry "Mana\/missing"/);
  assert.match(log, /ALPHA_VANTAGE_API_KEY: op read failed/);
  assert.doesNotMatch(log, /plain text|OPENAI_API_KEY/);
  assert.doesNotMatch(log, /fake/);

  // Doctor's list: plain-text secrets by name only; references, empty
  // values and non-secrets don't count.
  assert.deepEqual(plainTextSecretKeys(file), ["OPENAI_API_KEY"]);
  assert.deepEqual(plainTextSecretKeys(`${file}.missing`), []);
});

test("loadEnvFile leaves keyring: keys unset when Credential Manager can't be read", () => {
  const file = writeTempEnv("MANA_DISCORD_BOT_TOKEN=keyring:Mana/discord\n");
  const env = {};
  const warnings = [];
  const keys = loadEnvFile(file, env, {
    readKeyring: () => {
      throw new Error("keyring: references need Windows Credential Manager");
    },
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(keys, []);
  assert.deepEqual(env, {});
  assert.deepEqual(warnings, [
    "[env] keyring: references need Windows Credential Manager; leaving MANA_DISCORD_BOT_TOKEN unset",
  ]);
});

// The real CredReadW path (PowerShell + Add-Type compiles and runs), Windows
// only. A made-up target so the suite never reads or writes the user's own
// Credential Manager entries.
test("readKeyringSecrets reports missing Credential Manager entries as null, one per target", { skip: process.platform !== "win32" }, () => {
  const target = `Mana-test/missing-${process.pid}-${Date.now()}`;
  assert.deepEqual(readKeyringSecrets([target, `${target}-2`]), [null, null]);
});
