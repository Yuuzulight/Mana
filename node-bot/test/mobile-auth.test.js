const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMobileAuth,
  hashPasscode,
  verifyPasscode,
} = require("../mobile-auth");

test("hashPasscode and verifyPasscode accept the correct passcode", () => {
  const hashed = hashPasscode("123456", "test-salt");

  assert.equal(verifyPasscode("123456", hashed), true);
  assert.equal(verifyPasscode("000000", hashed), false);
});

test("mobile auth unlock creates a token that middleware accepts", () => {
  const auth = createMobileAuth({
    passcodeHash: hashPasscode("2468", "test-salt"),
    sessionSecret: "unit-test-secret",
    now: () => 1000,
    sessionTtlMs: 60_000,
  });

  const unlock = auth.unlock("2468");

  assert.equal(unlock.ok, true);
  assert.equal(typeof unlock.token, "string");
  assert.equal(auth.verifyToken(unlock.token).ok, true);
});

test("mobile auth rejects wrong passcode and expired tokens", () => {
  let now = 1000;
  const auth = createMobileAuth({
    passcodeHash: hashPasscode("2468", "test-salt"),
    sessionSecret: "unit-test-secret",
    now: () => now,
    sessionTtlMs: 10,
  });

  assert.equal(auth.unlock("9999").ok, false);

  const unlock = auth.unlock("2468");
  now = 1011;

  assert.equal(auth.verifyToken(unlock.token).ok, false);
  assert.match(auth.verifyToken(unlock.token).error, /expired/i);
});

test("mobile auth rejects tokens with extra segments", () => {
  const auth = createMobileAuth({
    passcodeHash: hashPasscode("2468", "test-salt"),
    sessionSecret: "unit-test-secret",
    now: () => 1000,
    sessionTtlMs: 60_000,
  });

  const unlock = auth.unlock("2468");
  const verified = auth.verifyToken(`${unlock.token}.extra`);

  assert.equal(verified.ok, false);
  assert.match(verified.error, /invalid token/i);
});

test("mobile auth rejects malformed non-ASCII token signatures without throwing", () => {
  const auth = createMobileAuth({
    passcodeHash: hashPasscode("2468", "test-salt"),
    sessionSecret: "unit-test-secret",
    now: () => 1000,
    sessionTtlMs: 60_000,
  });

  const unlock = auth.unlock("2468");
  const [body, signature] = unlock.token.split(".");
  const badSignature = "\u00e9".repeat(signature.length);
  const badToken = `${body}.${badSignature}`;

  assert.doesNotThrow(() => auth.verifyToken(badToken));
  const verified = auth.verifyToken(badToken);
  assert.equal(verified.ok, false);
  assert.match(verified.error, /invalid token signature/i);
});

test("verifyPasscode returns false for malformed hashes", () => {
  const malformedHashes = [
    "pbkdf2_sha256$not-a-number$test-salt$abc",
    "pbkdf2_sha256$0$test-salt$abc",
    "pbkdf2_sha256$120000$test-salt$abc",
  ];

  for (const malformedHash of malformedHashes) {
    assert.doesNotThrow(() => verifyPasscode("2468", malformedHash));
    assert.equal(verifyPasscode("2468", malformedHash), false);
  }
});

test("mobile auth rejects malformed configured passcode hashes", () => {
  const auth = createMobileAuth({
    passcodeHash: "pbkdf2_sha256$not-a-number$test-salt$abc",
    sessionSecret: "unit-test-secret",
  });

  const unlock = auth.unlock("2468");

  assert.equal(unlock.ok, false);
  assert.match(unlock.error, /invalid passcode/i);
});
