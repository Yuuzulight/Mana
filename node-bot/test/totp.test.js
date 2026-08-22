const assert = require("node:assert/strict");
const test = require("node:test");

const {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  buildOtpauthUri,
} = require("../totp");

test("generateTotpCode matches the official RFC 6238 test vector", () => {
  // RFC 6238 Appendix B: ASCII secret "12345678901234567890", SHA1, 8
  // digits, T=59s -> counter=1 -> expected code "94287082".
  const secretBase32 = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const code = generateTotpCode(secretBase32, { now: 59 * 1000, digits: 8 });
  assert.equal(code, "94287082");
});

test("base32Encode/base32Decode round-trip arbitrary bytes", () => {
  const original = Buffer.from("a mobile pairing secret", "utf8");
  const encoded = base32Encode(original);
  const decoded = base32Decode(encoded);
  assert.equal(decoded.toString("utf8"), original.toString("utf8"));
});

test("verifyTotpCode accepts the current code and rejects a wrong one", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const code = generateTotpCode(secret, { now });

  assert.equal(verifyTotpCode(secret, code, { now }), true);
  assert.equal(verifyTotpCode(secret, "000000", { now }), false);
  assert.equal(verifyTotpCode(secret, "", { now }), false);
  assert.equal(verifyTotpCode("", code, { now }), false);
});

test("verifyTotpCode tolerates one step of clock drift but not two", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const codeOneStepAgo = generateTotpCode(secret, { now: now - 30 * 1000 });
  const codeTwoStepsAgo = generateTotpCode(secret, { now: now - 60 * 1000 });

  assert.equal(verifyTotpCode(secret, codeOneStepAgo, { now }), true);
  assert.equal(verifyTotpCode(secret, codeTwoStepsAgo, { now }), false);
});

test("verifyTotpCode rejects non-numeric input without throwing", () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotpCode(secret, "not-a-code"), false);
  assert.equal(verifyTotpCode(secret, "12345a"), false);
});

test("buildOtpauthUri encodes label/issuer and carries the raw secret", () => {
  const uri = buildOtpauthUri({ secretBase32: "ABCD1234", label: "mana@phone", issuer: "Mana" });
  assert.match(uri, /^otpauth:\/\/totp\/Mana:mana%40phone\?/);
  assert.match(uri, /secret=ABCD1234/);
  assert.match(uri, /issuer=Mana/);
  assert.match(uri, /algorithm=SHA1&digits=6&period=30/);
});
