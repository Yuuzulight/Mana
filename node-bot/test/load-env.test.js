const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadEnvFile } = require("../load-env");

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
