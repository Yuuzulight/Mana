# Component Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured component readiness to `/health` while preserving existing flat health fields.

**Architecture:** Build component status objects in `node-bot/server.js` from existing local configuration and helper status functions, then include them under `components` in `/health`. Keep checks local and synchronous; Doctor remains responsible for network probes.

**Tech Stack:** Node.js CommonJS, Express, Node built-in test runner.

---

## File Structure

- Create `node-bot/test/health-components.test.js`: route-level tests for component health shape and redaction.
- Modify `node-bot/server.js`: add `buildHealthComponents()` helper and include `components` in `/health`.
- Modify `docs/roadmap/issue-10-component-health.md`: record implementation progress and verification.

---

### Task 1: Failing Component Health Tests

**Files:**
- Create: `node-bot/test/health-components.test.js`

- [ ] **Step 1: Add route tests**

Create `node-bot/test/health-components.test.js`:

```js
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../server");

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health includes component readiness while preserving top-level fields", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.ttsConfigured, "boolean");
    assert.equal(typeof body.llamaConfigured, "boolean");
    assert.equal(typeof body.remoteAiEnabled, "boolean");

    assert.deepEqual(Object.keys(body.components).sort(), [
      "backend",
      "cloudflareTunnel",
      "ffxivMarket",
      "localLlama",
      "localMemory",
      "mobileAuth",
      "tts",
      "vtubeStudio",
      "whisper",
    ]);
    assert.equal(body.components.backend.status, "available");
    assert.equal(body.components.backend.configured, true);
    assert.equal(typeof body.components.localLlama.message, "string");
  });
});

test("health component details do not expose secret values", async () => {
  const app = createApp({
    env: {
      MOBILE_PASSCODE_HASH: "secret-passcode-hash",
      MOBILE_SESSION_SECRET: "secret-session-value",
      CLOUDFLARE_TUNNEL_TOKEN: "secret-cloudflare-token",
      VTUBE_STUDIO_ENABLED: "1",
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    const raw = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.components.mobileAuth.status, "available");
    assert.equal(body.components.cloudflareTunnel.status, "configured");
    assert.equal(body.components.vtubeStudio.status, "configured");
    assert.equal(raw.includes("secret-passcode-hash"), false);
    assert.equal(raw.includes("secret-session-value"), false);
    assert.equal(raw.includes("secret-cloudflare-token"), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health\node-bot
node --test test\health-components.test.js
```

Expected: FAIL because `/health` does not include `components`.

---

### Task 2: Implement Component Health

**Files:**
- Modify: `node-bot/server.js`
- Test: `node-bot/test/health-components.test.js`

- [ ] **Step 1: Add local env support to `createApp`**

In `createApp(deps = {})`, define:

```js
const appEnv = deps.env || process.env;
```

Then pass `appEnv` into `registerRoutes` through `deps`:

```js
registerRoutes(app, upload, { ...deps, env: appEnv });
```

- [ ] **Step 2: Add health component helpers before `/health` route**

Add these helpers near `registerRoutes`:

```js
function makeHealthComponent(status, configured, message, details = {}) {
  return {
    status,
    configured: Boolean(configured),
    message,
    ...details,
  };
}

function hasEnvValue(env, names) {
  return names.some((name) => typeof env[name] === "string" && env[name].trim());
}

function buildHealthComponents({
  env,
  llamaStatus,
  ttsProvider,
  ttsBin,
  whisperBin,
  whisperModel,
  mobileMemoryStore,
}) {
  const mobileAuthConfigured = hasEnvValue(env, ["MOBILE_PASSCODE_HASH", "MANA_MOBILE_PASSCODE_HASH"]) &&
    hasEnvValue(env, ["MOBILE_SESSION_SECRET", "MANA_MOBILE_SESSION_SECRET"]);
  const cloudflareConfigured = hasEnvValue(env, [
    "CLOUDFLARE_TUNNEL_TOKEN",
    "CLOUDFLARE_TUNNEL_ID",
    "CLOUDFLARE_TUNNEL_URL",
    "MANA_TUNNEL_URL",
  ]);
  const vtubeEnabled = env.VTUBE_STUDIO_ENABLED !== "0";
  const whisperConfigured = Boolean(whisperBin && whisperModel);
  const ttsConfigured = ttsProvider !== "none";
  const ttsStatus = !ttsConfigured
    ? "unavailable"
    : ttsProvider === "cli" && !ttsBin
      ? "degraded"
      : "configured";

  return {
    backend: makeHealthComponent("available", true, "Backend is running."),
    localLlama: makeHealthComponent(
      llamaStatus.ok ? "available" : "unavailable",
      llamaStatus.ok,
      llamaStatus.message,
      {
        model: llamaStatus.model,
        bin: llamaStatus.bin,
      },
    ),
    whisper: makeHealthComponent(
      whisperConfigured ? "available" : "unavailable",
      whisperConfigured,
      whisperConfigured ? "Whisper is configured." : "Whisper binary or model is missing.",
      {
        binConfigured: Boolean(whisperBin),
        modelConfigured: Boolean(whisperModel),
      },
    ),
    tts: makeHealthComponent(
      ttsStatus,
      ttsConfigured,
      ttsConfigured ? `TTS provider is ${ttsProvider}.` : "TTS is disabled.",
      { provider: ttsProvider },
    ),
    mobileAuth: makeHealthComponent(
      mobileAuthConfigured ? "available" : "unavailable",
      mobileAuthConfigured,
      mobileAuthConfigured ? "Mobile auth is configured." : "Mobile auth secrets are missing.",
    ),
    localMemory: makeHealthComponent(
      mobileMemoryStore?.filePath ? "available" : "degraded",
      Boolean(mobileMemoryStore?.filePath),
      mobileMemoryStore?.filePath
        ? "Local mobile memory store is available."
        : "Local mobile memory store path is unavailable.",
      {
        filePath: mobileMemoryStore?.filePath || null,
      },
    ),
    cloudflareTunnel: makeHealthComponent(
      cloudflareConfigured ? "configured" : "unavailable",
      cloudflareConfigured,
      cloudflareConfigured ? "Cloudflare Tunnel is configured." : "Cloudflare Tunnel is not configured.",
    ),
    ffxivMarket: makeHealthComponent(
      "configured",
      true,
      "FFXIV market providers are configured from local defaults.",
      {
        universalisConfigured: true,
        xivapiConfigured: true,
      },
    ),
    vtubeStudio: makeHealthComponent(
      vtubeEnabled ? "configured" : "unavailable",
      vtubeEnabled,
      vtubeEnabled ? "VTube Studio integration is enabled." : "VTube Studio integration is disabled.",
    ),
  };
}
```

- [ ] **Step 3: Include `components` in `/health`**

Inside `registerRoutes`, create or reuse the same mobile memory store instance:

```js
const mobileMemoryStore = deps.mobileMemoryStore || createMobileMemoryStore();
```

Use it in `registerMobileRoutes` instead of creating a second store.

In `/health`, add:

```js
const env = deps.env || process.env;
const components = buildHealthComponents({
  env,
  llamaStatus,
  ttsProvider: TTS_PROVIDER,
  ttsBin: TTS_BIN,
  whisperBin: WHISPER_BIN,
  whisperModel: WHISPER_MODEL,
  mobileMemoryStore,
});
```

Then include `components` in the JSON response.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health\node-bot
node --test test\health-components.test.js test\mobile-routes.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit implementation**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health
git add node-bot\server.js node-bot\test\health-components.test.js
git commit -m "feat: add component health status"
```

---

### Task 3: Docs And Verification

**Files:**
- Modify: `docs/roadmap/issue-10-component-health.md`

- [ ] **Step 1: Update roadmap note**

Append:

```md
## Progress

- Added structured `/health.components` status for backend, local llama, Whisper, TTS, mobile auth, local memory, Cloudflare Tunnel config, FFXIV market providers, and VTube Studio.
- Preserved existing flat `/health` fields for launcher compatibility.
- Kept `/health` checks local and non-secret.

## Verification

- `node --test test\health-components.test.js test\mobile-routes.test.js test\doctor.test.js`
- `node --check server.js`
- `npm test`
```

- [ ] **Step 2: Run focused verification**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health\node-bot
node --test test\health-components.test.js test\mobile-routes.test.js test\doctor.test.js
node --check server.js
```

Expected: PASS.

- [ ] **Step 3: Run full suite**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health\node-bot
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health
git add docs\roadmap\issue-10-component-health.md
git commit -m "docs: update component health roadmap"
```

- [ ] **Step 5: Push and update PR**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health
git push
gh pr ready 17
gh pr edit 17 --body-file docs\roadmap\issue-10-component-health.md
```
