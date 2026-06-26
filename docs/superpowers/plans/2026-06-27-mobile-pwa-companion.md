# Mobile PWA Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable mobile PWA that connects to PC Mana through authenticated mobile APIs, persists phone chats locally, supports text/voice/spoken replies, and syncs explicit chat summaries to the PC without a cloud database.

**Architecture:** Keep the PC as the main Mana runtime. Add focused `node-bot` modules for mobile auth, local memory storage, and mobile Express routes, then serve a static PWA from `node-bot/mobile-app`. The phone stores full chat history in IndexedDB and only sends explicit summaries to PC Mana.

**Tech Stack:** Node.js, Express 4, multer, built-in `node:test`, static HTML/CSS/JavaScript PWA, IndexedDB, MediaRecorder, Web App Manifest, service worker, Cloudflare Tunnel/Access documentation.

---

## File Structure

Create or modify these files:

- Modify: `node-bot/server.js`
  - Export a `createApp(deps)` function and keep current production behavior through `startServer()`.
  - Register existing routes inside the app factory.
  - Mount mobile routes and static PWA assets.
- Create: `node-bot/mobile-auth.js`
  - Passcode hashing, verification, session token creation, and auth middleware.
- Create: `node-bot/mobile-memory-store.js`
  - File-backed summary storage with idempotent upsert/list behavior.
- Create: `node-bot/mobile-routes.js`
  - `/mobile/*` APIs for health, unlock, text chat, audio chat, authenticated speech synthesis, summaries, and PWA static serving hooks.
- Create: `node-bot/test/mobile-auth.test.js`
  - Unit tests for passcode/session behavior.
- Create: `node-bot/test/mobile-memory-store.test.js`
  - Unit tests for local summary persistence and duplicate ids.
- Create: `node-bot/test/mobile-routes.test.js`
  - Route-level tests using an ephemeral app and real HTTP server.
- Create: `node-bot/mobile-app/index.html`
  - PWA shell and app screens.
- Create: `node-bot/mobile-app/styles.css`
  - Mobile-first app styling.
- Create: `node-bot/mobile-app/app.js`
  - PWA state, IndexedDB, auth, chat, push-to-talk, audio playback, summary sync.
- Create: `node-bot/mobile-app/manifest.webmanifest`
  - Install metadata.
- Create: `node-bot/mobile-app/service-worker.js`
  - Cache app shell only.
- Create: `node-bot/mobile-app/icons/icon-192.svg`
  - Simple Mana app icon.
- Create: `node-bot/mobile-app/icons/icon-512.svg`
  - Larger install icon.
- Modify: `node-bot/.env.sample`
  - Document mobile passcode/session/data settings.
- Create: `docs/mobile_pwa_cloudflare.md`
  - Setup guide for local test, Cloudflare Tunnel, Cloudflare Access, and phone install.
- Modify: `.gitignore`
  - Ignore local `node-bot/data/` memory files.

## Task 1: Create Mobile Auth Module

**Files:**
- Create: `node-bot/mobile-auth.js`
- Test: `node-bot/test/mobile-auth.test.js`

- [ ] **Step 1: Write failing auth tests**

Create `node-bot/test/mobile-auth.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-auth.test.js
```

Expected: FAIL with module-not-found for `../mobile-auth`.

- [ ] **Step 3: Implement mobile auth**

Create `node-bot/mobile-auth.js`:

```js
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
```

- [ ] **Step 4: Run auth tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-auth.test.js
```

Expected: PASS for all three auth tests.

- [ ] **Step 5: Commit**

```powershell
git add node-bot/mobile-auth.js node-bot/test/mobile-auth.test.js
git commit -m "Add mobile passcode auth module"
```

## Task 2: Create File-Backed Mobile Memory Store

**Files:**
- Create: `node-bot/mobile-memory-store.js`
- Test: `node-bot/test/mobile-memory-store.test.js`

- [ ] **Step 1: Write failing memory store tests**

Create `node-bot/test/mobile-memory-store.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMobileMemoryStore } = require("../mobile-memory-store");

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-mobile-store-"));
  return {
    dir,
    store: createMobileMemoryStore({
      dataDir: dir,
      now: () => "2026-06-27T00:00:00.000Z",
    }),
  };
}

test("saveSummary persists and lists phone summaries", () => {
  const { store } = makeTempStore();

  const saved = store.saveSummary({
    id: "phone-1",
    source: "phone",
    direction: "phone-to-pc",
    chatId: "chat-1",
    title: "Dinner plans",
    summary: "The user talked about dinner plans.",
  });

  assert.equal(saved.id, "phone-1");
  assert.equal(saved.createdAt, "2026-06-27T00:00:00.000Z");
  assert.deepEqual(store.listSummaries({ direction: "phone-to-pc" }), [saved]);
});

test("saveSummary is idempotent for duplicate ids", () => {
  const { store } = makeTempStore();

  const first = store.saveSummary({
    id: "same-id",
    source: "phone",
    direction: "phone-to-pc",
    chatId: "chat-1",
    summary: "First summary.",
  });
  const second = store.saveSummary({
    id: "same-id",
    source: "phone",
    direction: "phone-to-pc",
    chatId: "chat-1",
    summary: "Different summary should not duplicate.",
  });

  assert.equal(second.id, first.id);
  assert.equal(store.listSummaries().length, 1);
  assert.equal(store.listSummaries()[0].summary, "First summary.");
});

test("createMobileMemoryStore reloads existing summaries from disk", () => {
  const { dir, store } = makeTempStore();
  store.saveSummary({
    id: "persisted",
    source: "pc",
    direction: "pc-to-phone",
    chatId: "desktop",
    summary: "PC note for phone.",
  });

  const reloaded = createMobileMemoryStore({ dataDir: dir });

  assert.equal(reloaded.listSummaries()[0].id, "persisted");
  assert.equal(reloaded.listSummaries({ direction: "pc-to-phone" }).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-memory-store.test.js
```

Expected: FAIL with module-not-found for `../mobile-memory-store`.

- [ ] **Step 3: Implement memory store**

Create `node-bot/mobile-memory-store.js`:

```js
const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeJsonArray(filePath, items) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSummary(input, createdAt) {
  const id = cleanText(input.id, 120);
  const summary = cleanText(input.summary, 4000);
  if (!id) {
    throw new Error("summary id is required");
  }
  if (!summary) {
    throw new Error("summary text is required");
  }

  const direction =
    input.direction === "pc-to-phone" ? "pc-to-phone" : "phone-to-pc";

  return {
    id,
    source: cleanText(input.source || "phone", 40),
    direction,
    chatId: cleanText(input.chatId, 120),
    title: cleanText(input.title, 160),
    summary,
    createdAt,
  };
}

function createMobileMemoryStore(options = {}) {
  const dataDir =
    options.dataDir || process.env.MOBILE_MEMORY_DIR || path.join(__dirname, "data");
  const now = options.now || (() => new Date().toISOString());
  const filePath = path.join(dataDir, "mobile-summaries.json");

  ensureDir(dataDir);

  function listSummaries(filter = {}) {
    const summaries = readJsonArray(filePath);
    if (!filter.direction) {
      return summaries;
    }
    return summaries.filter((item) => item.direction === filter.direction);
  }

  function saveSummary(input) {
    const summaries = readJsonArray(filePath);
    const existing = summaries.find((item) => item.id === input.id);
    if (existing) {
      return existing;
    }

    const summary = normalizeSummary(input, now());
    summaries.push(summary);
    writeJsonArray(filePath, summaries);
    return summary;
  }

  return {
    filePath,
    listSummaries,
    saveSummary,
  };
}

module.exports = {
  createMobileMemoryStore,
};
```

- [ ] **Step 4: Run memory store tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-memory-store.test.js
```

Expected: PASS for all three memory store tests.

- [ ] **Step 5: Commit**

```powershell
git add node-bot/mobile-memory-store.js node-bot/test/mobile-memory-store.test.js
git commit -m "Add mobile memory summary store"
```

## Task 3: Refactor Server Into Testable App Factory

**Files:**
- Modify: `node-bot/server.js`
- Test: `node-bot/test/mobile-routes.test.js`

- [ ] **Step 1: Write failing app factory smoke test**

Create `node-bot/test/mobile-routes.test.js`:

```js
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../server");

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("createApp exposes existing health route", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
  });
});
```

- [ ] **Step 2: Run route test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-routes.test.js
```

Expected: FAIL because `createApp` is not exported.

- [ ] **Step 3: Refactor `server.js` minimally**

Modify `node-bot/server.js` with these structural changes:

1. Replace the top-level app construction:

```js
const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
const upload = multer({ dest: path.join(__dirname, "tmp") });
```

with:

```js
function createApp(deps = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "15mb" }));
  const upload = multer({ dest: path.join(__dirname, "tmp") });
  registerRoutes(app, upload, deps);
  return app;
}
```

2. Insert a `registerRoutes(app, upload, deps = {}) {` wrapper immediately before the first current route:

```js
function registerRoutes(app, upload, deps = {}) {
```

The first current route is:

```js
app.get("/health", (req, res) => {
```

3. Close `registerRoutes` immediately before the current port/listen block.

4. Replace the current bottom:

```js
const port = process.env.PORT || 5005;
app.listen(port, () => console.log("Node local bot listening on", port));
```

with:

```js
function startServer() {
  const port = process.env.PORT || 5005;
  const app = createApp();
  return app.listen(port, () => console.log("Node local bot listening on", port));
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
};
```

Do not change existing route bodies in this task.

- [ ] **Step 4: Run route smoke test**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-routes.test.js
```

Expected: PASS for `createApp exposes existing health route`.

- [ ] **Step 5: Run full node-bot tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test
```

Expected: PASS for existing market tests and new route smoke test.

- [ ] **Step 6: Commit**

```powershell
git add node-bot/server.js node-bot/test/mobile-routes.test.js
git commit -m "Refactor backend into testable app factory"
```

## Task 4: Add Mobile Routes

**Files:**
- Create: `node-bot/mobile-routes.js`
- Modify: `node-bot/server.js`
- Modify: `node-bot/test/mobile-routes.test.js`

- [ ] **Step 1: Add failing route tests**

Append these tests to `node-bot/test/mobile-routes.test.js`:

```js
const { createMobileAuth, hashPasscode } = require("../mobile-auth");
const { createMobileMemoryStore } = require("../mobile-memory-store");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeMobileDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-mobile-routes-"));
  const auth = createMobileAuth({
    passcodeHash: hashPasscode("2468", "route-test-salt"),
    sessionSecret: "route-test-secret",
    now: () => 1000,
    sessionTtlMs: 60_000,
  });
  const memoryStore = createMobileMemoryStore({
    dataDir,
    now: () => "2026-06-27T00:00:00.000Z",
  });
  return {
    mobileAuth: auth,
    mobileMemoryStore: memoryStore,
    buildAssistantReply: async (text) => `Mana heard: ${text}`,
    synthesizeReply: async () => Buffer.from("fake-wav"),
    runWhisper: () => "voice message",
    normalizeUploadedAudio: (file) => ({ tmpPath: file.path, audioPath: file.path }),
    cleanupUploadedAudio: () => {},
  };
}

async function postJson(baseUrl, pathName, body, token = "") {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("mobile unlock returns token and health reports configured auth", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/mobile/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.authConfigured, true);

    const { response, body } = await postJson(baseUrl, "/mobile/auth/unlock", {
      passcode: "2468",
    });

    assert.equal(response.status, 200);
    assert.equal(typeof body.token, "string");
  });
});

test("mobile chat and summaries require auth", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const { response: chatResponse } = await postJson(
      baseUrl,
      "/mobile/chat/text",
      { text: "hello" },
    );

    assert.equal(chatResponse.status, 401);
  });
});

test("mobile text chat replies and summary sync persists", async () => {
  const deps = makeMobileDeps();
  const app = createApp(deps);

  await withServer(app, async (baseUrl) => {
    const unlock = await postJson(baseUrl, "/mobile/auth/unlock", {
      passcode: "2468",
    });
    const token = unlock.body.token;

    const chat = await postJson(
      baseUrl,
      "/mobile/chat/text",
      { text: "hello Mana" },
      token,
    );
    assert.equal(chat.response.status, 200);
    assert.equal(chat.body.reply, "Mana heard: hello Mana");

    const summary = await postJson(
      baseUrl,
      "/mobile/summaries",
      {
        id: "summary-1",
        chatId: "chat-1",
        title: "Test chat",
        summary: "The user greeted Mana.",
      },
      token,
    );
    assert.equal(summary.response.status, 200);
    assert.equal(summary.body.summary.id, "summary-1");

    const listResponse = await fetch(`${baseUrl}/mobile/summaries`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.summaries.length, 1);
  });
});
```

- [ ] **Step 2: Run route tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-routes.test.js
```

Expected: FAIL with `/mobile/health` not found or `registerMobileRoutes` missing.

- [ ] **Step 3: Implement mobile routes**

Create `node-bot/mobile-routes.js`:

```js
const express = require("express");
const multer = require("multer");
const path = require("path");
const { createMobileAuth } = require("./mobile-auth");
const { createMobileMemoryStore } = require("./mobile-memory-store");

function createDefaultMobileAuth() {
  return createMobileAuth({
    passcodeHash: process.env.MOBILE_PASSCODE_HASH || "",
    sessionSecret: process.env.MOBILE_SESSION_SECRET || "",
    sessionTtlMs: Number(process.env.MOBILE_SESSION_TTL_MS || 12 * 60 * 60 * 1000),
  });
}

function registerMobileRoutes(app, deps = {}) {
  const router = express.Router();
  const upload = multer({ dest: path.join(__dirname, "tmp") });
  const mobileAuth = deps.mobileAuth || createDefaultMobileAuth();
  const memoryStore = deps.mobileMemoryStore || createMobileMemoryStore();
  const buildAssistantReply = deps.buildAssistantReply;
  const synthesizeReply = deps.synthesizeReply;
  const runWhisper = deps.runWhisper;
  const normalizeUploadedAudio =
    deps.normalizeUploadedAudio || ((file) => ({ tmpPath: file.path, audioPath: file.path }));
  const cleanupUploadedAudio = deps.cleanupUploadedAudio || (() => {});

  router.get("/health", (req, res) => {
    return res.json({
      ok: true,
      authConfigured: mobileAuth.isConfigured,
      textChat: Boolean(buildAssistantReply),
      audioChat: Boolean(runWhisper),
      spokenReplies: Boolean(synthesizeReply),
    });
  });

  router.post("/auth/unlock", (req, res) => {
    const passcode = typeof req.body?.passcode === "string" ? req.body.passcode : "";
    const result = mobileAuth.unlock(passcode);
    if (!result.ok) {
      return res.status(401).json({ error: result.error });
    }
    return res.json({
      token: result.token,
      expiresAt: result.expiresAt,
    });
  });

  router.post("/chat/text", mobileAuth.requireAuth, async (req, res) => {
    try {
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) {
        return res.status(400).json({ error: "text is required" });
      }
      if (!buildAssistantReply) {
        return res.status(503).json({ error: "assistant reply is unavailable" });
      }

      const reply = await buildAssistantReply(text, "", "");
      return res.json({
        reply,
        ttsConfigured: Boolean(synthesizeReply),
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: String(error.message || error) });
    }
  });

  router.post(
    "/chat/audio",
    mobileAuth.requireAuth,
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "file is required" });
        }
        if (!runWhisper || !buildAssistantReply) {
          return res.status(503).json({ error: "audio chat is unavailable" });
        }

        const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);
        const transcript = runWhisper(audioPath);
        cleanupUploadedAudio(tmpPath, audioPath);
        const reply = await buildAssistantReply(transcript, "", "");
        return res.json({
          transcript,
          reply,
          ttsConfigured: Boolean(synthesizeReply),
        });
      } catch (error) {
        console.error(error);
        return res.status(500).json({ error: String(error.message || error) });
      }
    },
  );

  router.post("/synthesize", mobileAuth.requireAuth, async (req, res) => {
    try {
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) {
        return res.status(400).json({ error: "text is required" });
      }
      if (!synthesizeReply) {
        return res.status(503).json({ error: "speech synthesis is unavailable" });
      }

      const audio = await synthesizeReply(text);
      res.setHeader("Content-Type", "audio/wav");
      return res.send(audio);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: String(error.message || error) });
    }
  });

  router.post("/summaries", mobileAuth.requireAuth, (req, res) => {
    try {
      const summary = memoryStore.saveSummary({
        id: req.body?.id,
        source: "phone",
        direction: "phone-to-pc",
        chatId: req.body?.chatId,
        title: req.body?.title,
        summary: req.body?.summary,
      });
      return res.json({ summary });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get("/summaries", mobileAuth.requireAuth, (req, res) => {
    const direction =
      typeof req.query.direction === "string" ? req.query.direction : "";
    return res.json({
      summaries: memoryStore.listSummaries({ direction }),
    });
  });

  app.use("/mobile", router);
}

module.exports = {
  registerMobileRoutes,
};
```

- [ ] **Step 4: Mount mobile routes in server app factory**

Modify `node-bot/server.js`:

Add near the other requires:

```js
const { registerMobileRoutes } = require("./mobile-routes");
const { createMobileAuth } = require("./mobile-auth");
const { createMobileMemoryStore } = require("./mobile-memory-store");
```

Inside `registerRoutes(app, upload, deps = {})`, after existing routes are registered and before the function closes, add:

```js
  registerMobileRoutes(app, {
    mobileAuth:
      deps.mobileAuth ||
      createMobileAuth({
        passcodeHash: process.env.MOBILE_PASSCODE_HASH || "",
        sessionSecret: process.env.MOBILE_SESSION_SECRET || "",
        sessionTtlMs: Number(
          process.env.MOBILE_SESSION_TTL_MS || 12 * 60 * 60 * 1000,
        ),
      }),
    mobileMemoryStore: deps.mobileMemoryStore || createMobileMemoryStore(),
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    synthesizeReply: deps.synthesizeReply || synthesizeReply,
    runWhisper: deps.runWhisper || runWhisper,
    normalizeUploadedAudio:
      deps.normalizeUploadedAudio || normalizeUploadedAudio,
    cleanupUploadedAudio: deps.cleanupUploadedAudio || cleanupUploadedAudio,
  });
```

- [ ] **Step 5: Run mobile route tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test -- test/mobile-routes.test.js
```

Expected: PASS for health, auth enforcement, text chat, and summaries.

- [ ] **Step 6: Run full node-bot tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add node-bot/mobile-routes.js node-bot/server.js node-bot/test/mobile-routes.test.js
git commit -m "Add authenticated mobile API routes"
```

## Task 5: Add PWA Shell And Local Chat Storage

**Files:**
- Create: `node-bot/mobile-app/index.html`
- Create: `node-bot/mobile-app/styles.css`
- Create: `node-bot/mobile-app/app.js`
- Create: `node-bot/mobile-app/manifest.webmanifest`
- Create: `node-bot/mobile-app/service-worker.js`
- Create: `node-bot/mobile-app/icons/icon-192.svg`
- Create: `node-bot/mobile-app/icons/icon-512.svg`
- Modify: `node-bot/mobile-routes.js`

- [ ] **Step 1: Add static PWA serving**

Modify `node-bot/mobile-routes.js` by adding near the end of `registerMobileRoutes`, before `app.use("/mobile", router);`:

```js
  app.use(
    "/mobile/app",
    express.static(path.join(__dirname, "mobile-app"), {
      extensions: ["html"],
      index: "index.html",
    }),
  );
```

- [ ] **Step 2: Create PWA HTML**

Create `node-bot/mobile-app/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#101820" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="stylesheet" href="./styles.css" />
    <title>Mana Mobile</title>
  </head>
  <body>
    <main class="app-shell">
      <section id="lockScreen" class="lock-screen">
        <h1>Mana</h1>
        <p id="lockStatus">Unlock mobile Mana</p>
        <form id="unlockForm" class="unlock-form">
          <input
            id="passcodeInput"
            type="password"
            inputmode="numeric"
            autocomplete="current-password"
            placeholder="Passcode"
            required
          />
          <button type="submit">Unlock</button>
        </form>
      </section>

      <section id="chatScreen" class="chat-screen hidden">
        <header class="top-bar">
          <button id="chatListButton" class="icon-button" type="button">☰</button>
          <div>
            <h1 id="chatTitle">Mana</h1>
            <p id="connectionStatus">Checking connection...</p>
          </div>
          <button id="settingsButton" class="icon-button" type="button">⚙</button>
        </header>

        <aside id="chatDrawer" class="drawer hidden">
          <div class="drawer-header">
            <h2>Chats</h2>
            <button id="newChatButton" type="button">New</button>
          </div>
          <div id="chatList" class="chat-list"></div>
        </aside>

        <section id="messages" class="messages"></section>

        <section class="summary-panel">
          <button id="sendSummaryButton" type="button">Send Summary</button>
          <button id="syncButton" type="button">Sync</button>
          <span id="syncStatus">No pending summaries</span>
        </section>

        <form id="messageForm" class="composer">
          <button id="micButton" class="icon-button" type="button">🎙</button>
          <input id="messageInput" type="text" autocomplete="off" placeholder="Message Mana" />
          <button id="speakerButton" class="icon-button active" type="button">🔊</button>
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
    <script src="./app.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Create PWA CSS**

Create `node-bot/mobile-app/styles.css`:

```css
:root {
  color-scheme: dark;
  --bg: #101820;
  --panel: #17232e;
  --panel-2: #21313f;
  --text: #f4f7fb;
  --muted: #a8b6c4;
  --accent: #58c4b8;
  --danger: #ff6b6b;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Arial, sans-serif;
}

button,
input {
  font: inherit;
}

button {
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #07100f;
  min-height: 44px;
  padding: 0 14px;
  font-weight: 700;
}

input {
  min-height: 44px;
  border: 1px solid #314658;
  border-radius: 8px;
  background: #0d151c;
  color: var(--text);
  padding: 0 12px;
}

.hidden {
  display: none !important;
}

.app-shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

.lock-screen {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
  padding: 24px;
}

.lock-screen h1 {
  margin: 0;
  font-size: 42px;
}

.unlock-form {
  display: grid;
  gap: 12px;
}

.chat-screen {
  min-height: 100dvh;
  display: grid;
  grid-template-rows: auto 1fr auto auto;
}

.top-bar,
.summary-panel,
.composer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: var(--panel);
}

.top-bar h1 {
  margin: 0;
  font-size: 18px;
}

.top-bar p,
#syncStatus {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.icon-button {
  width: 44px;
  min-width: 44px;
  padding: 0;
  background: var(--panel-2);
  color: var(--text);
}

.icon-button.active {
  outline: 2px solid var(--accent);
}

.messages {
  overflow: auto;
  padding: 14px;
}

.message {
  max-width: 82%;
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--panel-2);
  line-height: 1.35;
  white-space: pre-wrap;
}

.message.user {
  margin-left: auto;
  background: #2f5f69;
}

.message.system {
  max-width: 100%;
  color: var(--muted);
  background: transparent;
  padding: 4px;
}

.composer input {
  min-width: 0;
  flex: 1;
}

.drawer {
  position: fixed;
  z-index: 10;
  inset: 0 auto 0 0;
  width: min(84vw, 340px);
  padding: 14px;
  background: #0d151c;
  box-shadow: 8px 0 24px rgba(0, 0, 0, 0.35);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chat-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.chat-list button {
  width: 100%;
  text-align: left;
  background: var(--panel);
  color: var(--text);
}
```

- [ ] **Step 4: Create IndexedDB app logic**

Create `node-bot/mobile-app/app.js`:

```js
const DB_NAME = "mana-mobile";
const DB_VERSION = 1;
const TOKEN_KEY = "manaMobileToken";
const TOKEN_EXPIRES_KEY = "manaMobileTokenExpiresAt";

const state = {
  db: null,
  token: localStorage.getItem(TOKEN_KEY) || "",
  tokenExpiresAt: Number(localStorage.getItem(TOKEN_EXPIRES_KEY) || 0),
  chats: [],
  currentChatId: "",
  speakerEnabled: true,
  mediaRecorder: null,
  recordedChunks: [],
};

const els = {
  lockScreen: document.getElementById("lockScreen"),
  chatScreen: document.getElementById("chatScreen"),
  unlockForm: document.getElementById("unlockForm"),
  passcodeInput: document.getElementById("passcodeInput"),
  lockStatus: document.getElementById("lockStatus"),
  messages: document.getElementById("messages"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  connectionStatus: document.getElementById("connectionStatus"),
  chatTitle: document.getElementById("chatTitle"),
  chatDrawer: document.getElementById("chatDrawer"),
  chatList: document.getElementById("chatList"),
  chatListButton: document.getElementById("chatListButton"),
  newChatButton: document.getElementById("newChatButton"),
  sendSummaryButton: document.getElementById("sendSummaryButton"),
  syncButton: document.getElementById("syncButton"),
  syncStatus: document.getElementById("syncStatus"),
  micButton: document.getElementById("micButton"),
  speakerButton: document.getElementById("speakerButton"),
};

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("chats", { keyPath: "id" });
      db.createObjectStore("summaries", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(storeName) {
  const tx = state.db.transaction(storeName, "readonly");
  return await requestToPromise(tx.objectStore(storeName).getAll());
}

async function put(storeName, value) {
  const tx = state.db.transaction(storeName, "readwrite");
  await requestToPromise(tx.objectStore(storeName).put(value));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function createChat() {
  const id = crypto.randomUUID();
  return {
    id,
    title: "New chat",
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    summaryState: "none",
  };
}

async function saveCurrentChat() {
  const chat = state.chats.find((item) => item.id === state.currentChatId);
  if (chat) {
    chat.updatedAt = new Date().toISOString();
    await put("chats", chat);
  }
}

async function loadChats() {
  state.chats = await getAll("chats");
  state.chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!state.chats.length) {
    const chat = createChat();
    state.chats.push(chat);
    await put("chats", chat);
  }
  state.currentChatId = state.chats[0].id;
  render();
}

function currentChat() {
  return state.chats.find((item) => item.id === state.currentChatId);
}

function addMessage(role, text) {
  const chat = currentChat();
  chat.messages.push({
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
  });
  if (role === "user" && chat.title === "New chat") {
    chat.title = text.slice(0, 40) || "New chat";
  }
  saveCurrentChat();
  render();
}

function render() {
  const chat = currentChat();
  els.chatTitle.textContent = chat?.title || "Mana";
  els.messages.innerHTML = "";
  for (const message of chat?.messages || []) {
    const node = document.createElement("div");
    node.className = `message ${message.role}`;
    node.textContent = message.text;
    els.messages.appendChild(node);
  }
  els.messages.scrollTop = els.messages.scrollHeight;

  els.chatList.innerHTML = "";
  for (const item of state.chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.title;
    button.onclick = () => {
      state.currentChatId = item.id;
      els.chatDrawer.classList.add("hidden");
      render();
    };
    els.chatList.appendChild(button);
  }
}

function showChat() {
  els.lockScreen.classList.add("hidden");
  els.chatScreen.classList.remove("hidden");
}

function showLock(message) {
  els.chatScreen.classList.add("hidden");
  els.lockScreen.classList.remove("hidden");
  els.lockStatus.textContent = message || "Unlock mobile Mana";
}

function authHeaders() {
  return { Authorization: `Bearer ${state.token}` };
}

async function unlock(passcode) {
  const response = await fetch("/mobile/auth/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Unlock failed");
  }
  state.token = body.token;
  state.tokenExpiresAt = body.expiresAt;
  localStorage.setItem(TOKEN_KEY, state.token);
  localStorage.setItem(TOKEN_EXPIRES_KEY, String(state.tokenExpiresAt));
}

async function checkHealth() {
  try {
    const response = await fetch("/mobile/health");
    const body = await response.json();
    els.connectionStatus.textContent = body.ok ? "Connected" : "Unavailable";
  } catch (error) {
    els.connectionStatus.textContent = "Offline";
  }
}

async function sendTextMessage(text) {
  addMessage("user", text);
  els.connectionStatus.textContent = "Mana is thinking...";
  const response = await fetch("/mobile/chat/text", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ text, chatId: state.currentChatId }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Chat failed");
  }
  addMessage("assistant", body.reply || "");
  if (state.speakerEnabled && body.ttsConfigured) {
    await playReply(body.reply);
  }
  els.connectionStatus.textContent = "Connected";
}

async function playReply(text) {
  const response = await fetch("/mobile/synthesize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play().catch(() => URL.revokeObjectURL(url));
}

async function sendSummary() {
  const chat = currentChat();
  const text = chat.messages
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
  const summary = text.slice(0, 2000);
  const item = {
    id: crypto.randomUUID(),
    chatId: chat.id,
    title: chat.title,
    summary,
    state: "queued",
    createdAt: new Date().toISOString(),
  };
  await put("summaries", item);
  await syncSummaries();
}

async function syncSummaries() {
  const summaries = await getAll("summaries");
  const queued = summaries.filter((item) => item.state !== "sent");
  for (const item of queued) {
    const response = await fetch("/mobile/summaries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(item),
    });
    if (response.ok) {
      item.state = "sent";
      await put("summaries", item);
    }
  }
  const remaining = (await getAll("summaries")).filter((item) => item.state !== "sent");
  els.syncStatus.textContent = remaining.length
    ? `${remaining.length} pending summaries`
    : "No pending summaries";
}

async function startNewChat() {
  const chat = createChat();
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  await put("chats", chat);
  els.chatDrawer.classList.add("hidden");
  render();
}

els.unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await unlock(els.passcodeInput.value);
    await loadChats();
    showChat();
    checkHealth();
  } catch (error) {
    showLock(error.message);
  }
});

els.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text) {
    return;
  }
  els.messageInput.value = "";
  try {
    await sendTextMessage(text);
  } catch (error) {
    addMessage("system", error.message);
    els.connectionStatus.textContent = "Retry needed";
  }
});

els.chatListButton.addEventListener("click", () => {
  els.chatDrawer.classList.toggle("hidden");
});
els.newChatButton.addEventListener("click", startNewChat);
els.sendSummaryButton.addEventListener("click", sendSummary);
els.syncButton.addEventListener("click", syncSummaries);
els.speakerButton.addEventListener("click", () => {
  state.speakerEnabled = !state.speakerEnabled;
  els.speakerButton.classList.toggle("active", state.speakerEnabled);
});

async function init() {
  if (!("indexedDB" in window)) {
    showLock("This browser does not support local chat storage.");
    return;
  }
  state.db = await openDb();
  if (state.token && state.tokenExpiresAt > Date.now()) {
    await loadChats();
    showChat();
    checkHealth();
  } else {
    showLock();
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

init().catch((error) => showLock(error.message));
```

- [ ] **Step 5: Create manifest**

Create `node-bot/mobile-app/manifest.webmanifest`:

```json
{
  "name": "Mana Mobile",
  "short_name": "Mana",
  "start_url": "/mobile/app/",
  "scope": "/mobile/app/",
  "display": "standalone",
  "background_color": "#101820",
  "theme_color": "#101820",
  "icons": [
    {
      "src": "./icons/icon-192.svg",
      "sizes": "192x192",
      "type": "image/svg+xml",
      "purpose": "any"
    },
    {
      "src": "./icons/icon-512.svg",
      "sizes": "512x512",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ]
}
```

- [ ] **Step 6: Create service worker**

Create `node-bot/mobile-app/service-worker.js`:

```js
const CACHE_NAME = "mana-mobile-shell-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/mobile/") && !url.pathname.startsWith("/mobile/app")) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
```

- [ ] **Step 7: Create icons**

Create `node-bot/mobile-app/icons/icon-192.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="36" fill="#101820"/>
  <circle cx="96" cy="84" r="46" fill="#58c4b8"/>
  <path d="M48 154c10-30 27-45 48-45s38 15 48 45" fill="#f4f7fb"/>
  <circle cx="78" cy="82" r="6" fill="#101820"/>
  <circle cx="114" cy="82" r="6" fill="#101820"/>
  <path d="M78 105c11 9 25 9 36 0" fill="none" stroke="#101820" stroke-width="8" stroke-linecap="round"/>
</svg>
```

Create `node-bot/mobile-app/icons/icon-512.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#101820"/>
  <circle cx="256" cy="224" r="124" fill="#58c4b8"/>
  <path d="M128 410c27-80 72-120 128-120s101 40 128 120" fill="#f4f7fb"/>
  <circle cx="208" cy="218" r="16" fill="#101820"/>
  <circle cx="304" cy="218" r="16" fill="#101820"/>
  <path d="M208 280c29 24 67 24 96 0" fill="none" stroke="#101820" stroke-width="22" stroke-linecap="round"/>
</svg>
```

- [ ] **Step 8: Run backend tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add node-bot/mobile-app node-bot/mobile-routes.js
git commit -m "Add installable mobile PWA shell"
```

## Task 6: Add Push-To-Talk Audio Chat

**Files:**
- Modify: `node-bot/mobile-app/app.js`

- [ ] **Step 1: Add push-to-talk helpers**

Append this code above `async function init()` in `node-bot/mobile-app/app.js`:

```js
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.recordedChunks = [];
  state.mediaRecorder = new MediaRecorder(stream);
  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      state.recordedChunks.push(event.data);
    }
  };
  state.mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(state.recordedChunks, { type: state.mediaRecorder.mimeType });
    state.mediaRecorder = null;
    await sendAudioMessage(blob).catch((error) => {
      addMessage("system", error.message);
      els.connectionStatus.textContent = "Voice failed";
    });
  };
  state.mediaRecorder.start();
  els.micButton.classList.add("active");
  els.connectionStatus.textContent = "Listening...";
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
  els.micButton.classList.remove("active");
}

async function sendAudioMessage(blob) {
  const formData = new FormData();
  formData.append("file", blob, "mobile-audio.webm");
  els.connectionStatus.textContent = "Transcribing...";
  const response = await fetch("/mobile/chat/audio", {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Voice chat failed");
  }
  if (body.transcript) {
    addMessage("user", body.transcript);
  }
  addMessage("assistant", body.reply || "");
  if (state.speakerEnabled && body.ttsConfigured) {
    await playReply(body.reply);
  }
  els.connectionStatus.textContent = "Connected";
}
```

- [ ] **Step 2: Wire mic button events**

Add this near the other event listeners in `node-bot/mobile-app/app.js`:

```js
els.micButton.addEventListener("pointerdown", async () => {
  try {
    await startRecording();
  } catch (error) {
    addMessage("system", `Microphone error: ${error.message}`);
  }
});

els.micButton.addEventListener("pointerup", stopRecording);
els.micButton.addEventListener("pointercancel", stopRecording);
els.micButton.addEventListener("click", async () => {
  if (state.mediaRecorder) {
    stopRecording();
    return;
  }
  try {
    await startRecording();
  } catch (error) {
    addMessage("system", `Microphone error: ${error.message}`);
  }
});
```

- [ ] **Step 3: Run tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add node-bot/mobile-app/app.js
git commit -m "Add mobile push-to-talk chat"
```

## Task 7: Add Config, Gitignore, And Cloudflare Docs

**Files:**
- Modify: `node-bot/.env.sample`
- Modify: `.gitignore`
- Create: `docs/mobile_pwa_cloudflare.md`

- [ ] **Step 1: Add local data ignore**

Append to `.gitignore`:

```gitignore

# Local Mana mobile memory store
node-bot/data/
```

- [ ] **Step 2: Add mobile env sample settings**

Append to `node-bot/.env.sample`:

```dotenv

# --- Mobile PWA companion ---
# Generate MOBILE_PASSCODE_HASH with:
# node -e "const { hashPasscode } = require('./mobile-auth'); console.log(hashPasscode('CHANGE_ME_PASSCODE'))"
MOBILE_PASSCODE_HASH=pbkdf2_sha256$120000$REPLACE_SALT$REPLACE_HASH

# Generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MOBILE_SESSION_SECRET=replace-with-random-hex
MOBILE_SESSION_TTL_MS=43200000
MOBILE_MEMORY_DIR=C:\ManaAI\Mana\node-bot\data
```

- [ ] **Step 3: Create Cloudflare setup doc**

Create `docs/mobile_pwa_cloudflare.md`:

```md
# Mana Mobile PWA Cloudflare Setup

This guide exposes only Mana's mobile PWA/API surface through Cloudflare Tunnel. Persistent chat and memory data stay on the phone and PC.

## Local prerequisites

- Mana backend starts successfully on `http://127.0.0.1:5005`.
- `MOBILE_PASSCODE_HASH` is set.
- `MOBILE_SESSION_SECRET` is set.
- `node-bot/data/` is ignored by Git.

Generate a passcode hash from `node-bot`:

```powershell
cd C:\ManaAI\Mana\node-bot
node -e "const { hashPasscode } = require('./mobile-auth'); console.log(hashPasscode('YOUR_PASSCODE'))"
```

Generate a session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Local test

Start Mana, then open:

```text
http://127.0.0.1:5005/mobile/app/
```

Unlock with the configured passcode.

## Cloudflare Tunnel

Install `cloudflared`, authenticate it, and create a tunnel that routes your chosen hostname to:

```text
http://127.0.0.1:5005
```

In Cloudflare Zero Trust, add an Access application for the hostname and allow only your email or identity provider account.

Use a dedicated hostname such as:

```text
https://mana.example.com/mobile/app/
```

Do not expose unrelated local services through this tunnel.

## Phone install

On iPhone Safari:

1. Open the Cloudflare-protected Mana URL.
2. Complete Cloudflare Access login.
3. Unlock with the Mana passcode.
4. Use Share -> Add to Home Screen.

## Verification

- Open the app on cellular data, not Wi-Fi.
- Confirm Cloudflare Access blocks an unauthorized browser.
- Confirm Mana passcode is still required after Cloudflare login.
- Send a text chat.
- Record a push-to-talk message.
- Close and reopen the PWA and confirm chats remain.
- Tap Send Summary and confirm the summary appears in `node-bot/data/mobile-summaries.json`.
```

- [ ] **Step 4: Run tests**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore node-bot/.env.sample docs/mobile_pwa_cloudflare.md
git commit -m "Document mobile PWA configuration"
```

## Task 8: Manual Verification

**Files:**
- No source changes unless a prior task revealed a defect.

- [ ] **Step 1: Start backend**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
$env:MOBILE_PASSCODE_HASH = node -e "const { hashPasscode } = require('./mobile-auth'); console.log(hashPasscode('2468'))"
$env:MOBILE_SESSION_SECRET = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

Expected: backend starts on port `5005`.

- [ ] **Step 2: Open local PWA**

Open:

```text
http://127.0.0.1:5005/mobile/app/
```

Expected: lock screen appears.

- [ ] **Step 3: Unlock and test text chat**

Unlock with:

```text
2468
```

Send:

```text
hello Mana
```

Expected: message persists in the chat view and Mana returns a reply.

- [ ] **Step 4: Test persistence**

Close the browser tab, reopen:

```text
http://127.0.0.1:5005/mobile/app/
```

Expected: previous chat appears after unlock or valid saved session.

- [ ] **Step 5: Test summary sync**

Tap `Send Summary`.

Expected: `node-bot/data/mobile-summaries.json` contains one summary with `direction` set to `phone-to-pc`.

- [ ] **Step 6: Test mobile viewport**

Use browser device emulation for iPhone-size viewport or open from a phone on the same network.

Expected: no overlapping controls, composer remains usable, drawer opens and closes.

- [ ] **Step 7: Final full test run**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit verification fixes if needed**

Only if manual testing required source changes:

```powershell
git add <changed-files>
git commit -m "Fix mobile PWA verification issues"
```
