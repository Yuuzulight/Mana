const crypto = require("crypto");

// RFC 6238 TOTP over RFC 4648 base32, hand-rolled rather than a dependency --
// no otplib/speakeasy/notp anywhere in this repo today, and mobile-auth.js
// already hand-rolls PBKDF2 passcode hashing and HMAC token signing with
// node:crypto directly, so this follows the same established precedent.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = "";
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, "0");
  }
  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, "0");
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(input) {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// One random secret, generated once at enrollment and never rotated
// automatically -- same lifecycle as MOBILE_SESSION_SECRET.
function generateTotpSecret(byteLength = 20) {
  return base32Encode(crypto.randomBytes(byteLength));
}

function hotp(secretBase32, counter, digits) {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = String(truncated % 10 ** digits).padStart(digits, "0");
  return code;
}

function generateTotpCode(secretBase32, { step = 30, digits = 6, now = Date.now() } = {}) {
  const counter = Math.floor(now / 1000 / step);
  return hotp(secretBase32, counter, digits);
}

function timingSafeCodeEquals(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  try {
    return crypto.timingSafeEqual(bufferA, bufferB);
  } catch (e) {
    return false;
  }
}

// window=1 tolerates the code from one step before/after "now" -- standard
// TOTP practice for clock drift and the few seconds between an app
// displaying a code and the user typing it in.
function verifyTotpCode(secretBase32, code, { step = 30, digits = 6, window = 1, now = Date.now() } = {}) {
  if (!secretBase32 || !code) return false;
  const normalized = String(code).trim();
  if (!/^\d+$/.test(normalized)) return false;

  const counter = Math.floor(now / 1000 / step);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = hotp(secretBase32, counter + offset, digits);
    if (timingSafeCodeEquals(candidate, normalized)) {
      return true;
    }
  }
  return false;
}

function buildOtpauthUri({ secretBase32, label, issuer = "Mana" }) {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedLabel = encodeURIComponent(label || "mobile");
  return (
    `otpauth://totp/${encodedIssuer}:${encodedLabel}` +
    `?secret=${secretBase32}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`
  );
}

module.exports = {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  buildOtpauthUri,
};
