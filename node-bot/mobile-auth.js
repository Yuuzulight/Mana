const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hashPasscode(passcode, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto
    .pbkdf2Sync(String(passcode || ""), salt, 120000, 32, "sha256")
    .toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${derived}`;
}

function verifyPasscode(passcode, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") {
    return false;
  }

  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  const actual = crypto
    .pbkdf2Sync(String(passcode || ""), salt, iterations, 32, "sha256")
    .toString("hex");

  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function signPayload(payload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

function createToken(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  const signature = signPayload(body, secret);
  return `${body}.${signature}`;
}

function parseToken(token, secret) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) {
    return { ok: false, error: "Invalid token" };
  }

  const expected = signPayload(body, secret);
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return { ok: false, error: "Invalid token signature" };
  }

  try {
    return {
      ok: true,
      payload: JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    };
  } catch (error) {
    return { ok: false, error: "Invalid token payload" };
  }
}

function createMobileAuth(options = {}) {
  const passcodeHash = options.passcodeHash || "";
  const sessionSecret = options.sessionSecret || "";
  const now = options.now || Date.now;
  const sessionTtlMs = Number(options.sessionTtlMs || 12 * 60 * 60 * 1000);

  function unlock(passcode) {
    if (!passcodeHash || !sessionSecret) {
      return { ok: false, error: "Mobile auth is not configured" };
    }
    if (!verifyPasscode(passcode, passcodeHash)) {
      return { ok: false, error: "Invalid passcode" };
    }

    const issuedAt = now();
    const expiresAt = issuedAt + sessionTtlMs;
    const token = createToken(
      {
        sub: "mobile-user",
        iat: issuedAt,
        exp: expiresAt,
      },
      sessionSecret,
    );
    return { ok: true, token, expiresAt };
  }

  function verifyToken(token) {
    if (!sessionSecret) {
      return { ok: false, error: "Mobile auth is not configured" };
    }

    const parsed = parseToken(token, sessionSecret);
    if (!parsed.ok) {
      return parsed;
    }
    if (!parsed.payload.exp || parsed.payload.exp <= now()) {
      return { ok: false, error: "Token expired" };
    }
    return { ok: true, payload: parsed.payload };
  }

  function requireAuth(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const verified = verifyToken(token);
    if (!verified.ok) {
      return res.status(401).json({ error: verified.error });
    }
    req.mobileSession = verified.payload;
    return next();
  }

  return {
    unlock,
    verifyToken,
    requireAuth,
    isConfigured: Boolean(passcodeHash && sessionSecret),
  };
}

module.exports = {
  createMobileAuth,
  hashPasscode,
  verifyPasscode,
};
