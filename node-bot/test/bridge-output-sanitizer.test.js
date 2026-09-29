const assert = require("node:assert/strict");
const test = require("node:test");

const { sanitizeBridgeOutput } = require("../bridge-output-sanitizer");

const clean = (text, env = {}) => sanitizeBridgeOutput(text, { env });

test("local file paths are replaced (#670)", () => {
  const cases = [
    ["Saved it to C:\\Users\\Yuuzu\\Documents\\notes.txt.", "Saved it to [local path]"],
    ["model at D:/models/qwen.gguf loaded", "model at [local path] loaded"],
    ["see C:\\Program Files\\Mana\\server.js now", "see [local path] now"],
    ["json: \"C:\\\\Users\\\\me\\\\a.txt\"", "json: \"[local path]\""],
    ["open file:///home/me/secret.txt", "open [local path]"],
    ["share \\\\NAS\\private\\taxes.pdf", "share [local path]"],
    ["it's in /home/yuuzu/.ssh/id_rsa", "it's in [local path]"],
    ["check ~/Downloads/x.zip", "check [local path]"],
    ["log at /var/log/mana.log", "log at [local path]"],
  ];
  for (const [input, expected] of cases) assert.equal(clean(input), expected, input);
});

test("ordinary text, URLs and relative paths are left alone", () => {
  const cases = [
    "See https://example.com/home/docs and http://localhost:5005/tmp/x",
    "Ratio 3:2, time 10:30, node-bot/server.js, and/or /api/memory",
    "scikit uses sk-learn-compatible-estimators",
    "token_count: 123456 and key: remember-this",
    "C: drive is full",
  ];
  for (const input of cases) assert.equal(clean(input), input, input);
});

test("tokens and keys in well-known shapes are redacted", () => {
  const cases = [
    "sk-ant-api03-AbCdEf0123456789xyzXYZ",
    "sk-proj-abc123def456ghi789jkl0",
    "ghp_abcdefghijklmnop1234",
    "github_pat_11ABCDEFG0123456789abcdef",
    "xoxb-1234567890-abcdefghij",
    "AKIAABCDEFGHIJKLMNOP",
    `AIza${"a1".repeat(17)}b`,
    `hf_${"a1".repeat(16)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    `123456789:${"A".repeat(35)}`,
    `${"M".repeat(26)}.GaBcDe.${"x".repeat(38)}`,
    "Authorization: Bearer abcdefghijklmnop0123",
  ];
  for (const secret of cases) {
    const out = clean(`here: ${secret} ok`);
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
    assert.match(out, /\[redacted\]/, secret);
  }
});

test("private key blocks and secret-named assignments are redacted", () => {
  assert.equal(
    clean("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY----- done"),
    "[redacted] done",
  );
  assert.equal(clean("OPENAI_API_KEY=abcdef123456"), "OPENAI_API_KEY=[redacted]");
  assert.equal(clean('{"password": "hunter22"}'), '{"password": "[redacted]"}');
});

test("values of secret-named env vars are redacted wherever they appear", () => {
  const env = {
    MANA_DISCORD_BOT_TOKEN: "plainlookingvalue42",
    ADMIN_TOKEN: "short",
    MANA_BIND_HOST: "127.0.0.1",
  };
  assert.equal(
    clean("the token is plainlookingvalue42, host 127.0.0.1, short", env),
    "the token is [redacted], host 127.0.0.1, short",
  );
});

test("non-string and empty replies pass through", () => {
  assert.equal(clean(null), null);
  assert.equal(clean(""), "");
});
