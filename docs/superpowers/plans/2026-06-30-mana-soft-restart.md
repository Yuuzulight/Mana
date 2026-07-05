# Mana Soft Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only soft backend restart command that works from Mana chat and from PowerShell while keeping the desktop launcher open.

**Architecture:** Add a focused restart controller module in `node-bot`, register a local-only admin route, and let `/reply` intercept restart commands before model inference. The backend exits with a documented restart exit code after the response is sent; the Electron launcher and the terminal supervisor respawn only for that exit code with a small loop guard.

**Tech Stack:** Node.js CommonJS, Express 4, Electron launcher process management, `node:test`, PowerShell/npm scripts.

---

## File Structure

- Create `node-bot/admin-restart.js`: owns restart command parsing, loopback checks, restart response payloads, and deferred shutdown scheduling.
- Create `node-bot/restart-client.js`: CLI helper for `npm run restart`.
- Create `node-bot/mana-supervisor.js`: terminal fallback supervisor for `npm run mana`.
- Create `node-bot/test/admin-restart.test.js`: unit tests for restart helpers and CLI-friendly formatting.
- Modify `node-bot/server-routes.js`: register `POST /admin/restart` and intercept chat restart commands inside `POST /reply`.
- Modify `node-bot/server.js`: create and pass the restart controller into route registration; update `startServer()` to exit with the restart code when requested.
- Modify `node-bot/package.json`: add `restart` and `mana` scripts.
- Create `windows-launcher/backend-supervisor.js`: testable launcher child-process restart policy.
- Create `windows-launcher/test/backend-supervisor.test.js`: launcher restart policy tests.
- Modify `windows-launcher/main.js`: delegate backend child close handling to `backend-supervisor.js`.
- Modify `docs/quick_start_windows.md` and `node-bot/README.md`: document `/restart`, `npm run restart`, and `npm run mana`.

---

### Task 1: Restart Helper Module

**Files:**
- Create: `node-bot/admin-restart.js`
- Test: `node-bot/test/admin-restart.test.js`

- [ ] **Step 1: Write failing helper tests**

Create `node-bot/test/admin-restart.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANA_RESTART_EXIT_CODE,
  buildRestartAcceptedPayload,
  formatRestartClientResult,
  isLoopbackAddress,
  isRestartCommand,
} = require("../admin-restart");

test("isRestartCommand accepts explicit Mana restart phrases only", () => {
  assert.equal(isRestartCommand("/restart"), true);
  assert.equal(isRestartCommand("/soft-restart"), true);
  assert.equal(isRestartCommand("soft restart Mana"), true);
  assert.equal(isRestartCommand("restart Mana"), true);
  assert.equal(isRestartCommand("restart the backend"), false);
  assert.equal(isRestartCommand("please restart my PC"), false);
});

test("isLoopbackAddress accepts loopback forms and rejects remote addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.50"), false);
  assert.equal(isLoopbackAddress("10.0.0.2"), false);
});

test("buildRestartAcceptedPayload documents soft backend restart behavior", () => {
  assert.deepEqual(buildRestartAcceptedPayload(), {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: MANA_RESTART_EXIT_CODE,
    message: "Mana backend soft restart requested. The launcher or supervisor will start it again.",
  });
});

test("formatRestartClientResult prints success and unavailable messages", () => {
  assert.match(
    formatRestartClientResult({
      ok: true,
      payload: buildRestartAcceptedPayload(),
    }),
    /soft restart requested/i,
  );
  assert.match(
    formatRestartClientResult({
      ok: false,
      error: "fetch failed",
    }),
    /Mana backend is not reachable/i,
  );
});
```

- [ ] **Step 2: Run helper tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
node --test test\admin-restart.test.js
```

Expected: fail with `Cannot find module '../admin-restart'`.

- [ ] **Step 3: Implement helper module**

Create `node-bot/admin-restart.js`:

```js
const MANA_RESTART_EXIT_CODE = 77;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isRestartCommand(text) {
  const normalized = cleanText(text).toLowerCase();
  return [
    "/restart",
    "/soft-restart",
    "soft restart mana",
    "restart mana",
  ].includes(normalized);
}

function isLoopbackAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
}

function getRequestAddress(req) {
  return (
    req?.ip ||
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    ""
  );
}

function buildRestartAcceptedPayload() {
  return {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: MANA_RESTART_EXIT_CODE,
    message:
      "Mana backend soft restart requested. The launcher or supervisor will start it again.",
  };
}

function createRestartController(options = {}) {
  const exitProcess =
    options.exitProcess ||
    ((code) => {
      process.exit(code);
    });
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const delayMs = Math.max(1, Number(options.delayMs || 250));

  function scheduleRestart() {
    schedule(() => exitProcess(MANA_RESTART_EXIT_CODE), delayMs);
  }

  return {
    exitCode: MANA_RESTART_EXIT_CODE,
    buildAcceptedPayload: buildRestartAcceptedPayload,
    scheduleRestart,
  };
}

function formatRestartClientResult(result) {
  if (result?.ok) {
    return result.payload?.message || "Mana backend soft restart requested.";
  }

  return `Mana backend is not reachable. Start Mana first, then try again. Details: ${
    result?.error || "unknown error"
  }`;
}

module.exports = {
  MANA_RESTART_EXIT_CODE,
  buildRestartAcceptedPayload,
  createRestartController,
  formatRestartClientResult,
  getRequestAddress,
  isLoopbackAddress,
  isRestartCommand,
};
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
node --test test\admin-restart.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit helper module**

```powershell
git add node-bot\admin-restart.js node-bot\test\admin-restart.test.js
git commit -m "Add Mana backend restart helpers"
```

---

### Task 2: Backend Admin Route And Chat Command

**Files:**
- Modify: `node-bot/server-routes.js`
- Modify: `node-bot/server.js`
- Modify: `node-bot/test/server-routes.test.js`

- [ ] **Step 1: Write failing backend route tests**

Append to `node-bot/test/server-routes.test.js`:

```js
test("admin restart route accepts loopback requests and schedules restart", async () => {
  let scheduled = 0;
  const app = createApp({
    restartController: {
      buildAcceptedPayload: () => ({
        ok: true,
        action: "restart",
        scope: "backend",
        exitCode: 77,
        message: "Mana backend soft restart requested. The launcher or supervisor will start it again.",
      }),
      scheduleRestart: () => {
        scheduled += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/admin/restart`, {});

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.exitCode, 77);
    assert.equal(scheduled, 1);
  });
});

test("admin restart route rejects non-loopback forwarded clients", async () => {
  let scheduled = 0;
  const app = createApp({
    restartController: {
      buildAcceptedPayload: () => ({ ok: true }),
      scheduleRestart: () => {
        scheduled += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/restart`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "192.168.1.50",
      },
      body: "{}",
    });
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(payload, { error: "restart is only available from this PC" });
    assert.equal(scheduled, 0);
  });
});

test("reply handles restart command locally without model inference", async () => {
  let replyCalls = 0;
  let scheduled = 0;
  const app = createApp({
    restartController: {
      buildAcceptedPayload: () => ({
        ok: true,
        action: "restart",
        scope: "backend",
        exitCode: 77,
        message: "Mana backend soft restart requested. The launcher or supervisor will start it again.",
      }),
      scheduleRestart: () => {
        scheduled += 1;
      },
    },
    buildAssistantReply: async () => {
      replyCalls += 1;
      return "model should not run";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "/restart",
    });

    assert.equal(response.status, 200);
    assert.match(payload.reply, /soft restart requested/i);
    assert.equal(payload.restart.ok, true);
    assert.equal(payload.ttsConfigured, false);
    assert.equal(replyCalls, 0);
    assert.equal(scheduled, 1);
  });
});
```

- [ ] **Step 2: Run backend route tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
node --test test\server-routes.test.js
```

Expected: fail because `/admin/restart` is missing and `/reply` calls the model for `/restart`.

- [ ] **Step 3: Wire restart helpers into routes**

In `node-bot/server-routes.js`, add imports near the top:

```js
const {
  getRequestAddress,
  isLoopbackAddress,
  isRestartCommand,
} = require("./admin-restart");
```

In `registerCoreRoutes`, include `restartController` in the dependency destructuring:

```js
    restartController,
```

Before `/transcribe-only`, add:

```js
  app.post("/admin/restart", async (req, res) => {
    const forwardedFor = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    const address = forwardedFor || getRequestAddress(req);
    if (!isLoopbackAddress(address)) {
      return res.status(403).json({ error: "restart is only available from this PC" });
    }

    if (!restartController?.scheduleRestart) {
      return res.status(500).json({ error: "restart controller is not configured" });
    }

    const payload = restartController.buildAcceptedPayload();
    res.json(payload);
    res.once("finish", () => restartController.scheduleRestart());
  });
```

Inside `/reply`, immediately after `const transcript = requireString(...)`, add:

```js
      if (isRestartCommand(transcript)) {
        if (!restartController?.scheduleRestart) {
          return res.status(500).json({ error: "restart controller is not configured" });
        }
        const payload = restartController.buildAcceptedPayload();
        res.json({
          reply: payload.message,
          restart: payload,
          ttsConfigured: false,
        });
        res.once("finish", () => restartController.scheduleRestart());
        return;
      }
```

- [ ] **Step 4: Wire restart controller into server**

In `node-bot/server.js`, add near the local imports:

```js
const { createRestartController } = require("./admin-restart");
```

Inside `registerRoutes`, add to the `registerCoreRoutes` dependency object:

```js
  restartController:
    deps.restartController ||
    createRestartController({
      exitProcess: deps.exitProcess,
      schedule: deps.schedule,
    }),
```

- [ ] **Step 5: Run backend route tests to verify they pass**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
node --test test\admin-restart.test.js test\server-routes.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit backend route changes**

```powershell
git add node-bot\server-routes.js node-bot\server.js node-bot\test\server-routes.test.js
git commit -m "Add local backend soft restart route"
```

---

### Task 3: Restart CLI And Terminal Supervisor

**Files:**
- Create: `node-bot/restart-client.js`
- Create: `node-bot/mana-supervisor.js`
- Modify: `node-bot/package.json`
- Test: `node-bot/test/admin-restart.test.js`

- [ ] **Step 1: Add failing tests for supervisor policy**

Append to `node-bot/test/admin-restart.test.js`:

```js
const { shouldRespawnBackend } = require("../mana-supervisor");

test("terminal supervisor respawns only documented restart exits within cap", () => {
  assert.equal(
    shouldRespawnBackend({
      code: MANA_RESTART_EXIT_CODE,
      recentRestartCount: 0,
      maxRestarts: 3,
    }),
    true,
  );
  assert.equal(
    shouldRespawnBackend({
      code: 1,
      recentRestartCount: 0,
      maxRestarts: 3,
    }),
    false,
  );
  assert.equal(
    shouldRespawnBackend({
      code: MANA_RESTART_EXIT_CODE,
      recentRestartCount: 3,
      maxRestarts: 3,
    }),
    false,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
node --test test\admin-restart.test.js
```

Expected: fail because `../mana-supervisor` does not exist.

- [ ] **Step 3: Implement restart client**

Create `node-bot/restart-client.js`:

```js
const { formatRestartClientResult } = require("./admin-restart");

async function requestRestart(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const backendUrl = String(
    options.backendUrl || process.env.MANA_BACKEND_URL || "http://127.0.0.1:5005",
  ).replace(/\/+$/, "");

  try {
    const response = await fetchImpl(`${backendUrl}/admin/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: payload.error || `HTTP ${response.status}` };
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

if (require.main === module) {
  requestRestart().then((result) => {
    process.stdout.write(`${formatRestartClientResult(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  });
}

module.exports = {
  requestRestart,
};
```

- [ ] **Step 4: Implement terminal supervisor**

Create `node-bot/mana-supervisor.js`:

```js
const path = require("node:path");
const { spawn } = require("node:child_process");
const { MANA_RESTART_EXIT_CODE } = require("./admin-restart");

function shouldRespawnBackend({ code, recentRestartCount, maxRestarts }) {
  return code === MANA_RESTART_EXIT_CODE && recentRestartCount < maxRestarts;
}

function createRestartWindow(nowMs, windowMs) {
  const restarts = [];
  return {
    count() {
      const cutoff = nowMs() - windowMs;
      while (restarts.length && restarts[0] < cutoff) {
        restarts.shift();
      }
      return restarts.length;
    },
    record() {
      restarts.push(nowMs());
    },
  };
}

function startSupervisor(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const rootDir = options.rootDir || __dirname;
  const serverPath = options.serverPath || path.join(rootDir, "server.js");
  const restartDelayMs = Math.max(1, Number(options.restartDelayMs || 500));
  const maxRestarts = Math.max(1, Number(options.maxRestarts || 5));
  const restartWindowMs = Math.max(1000, Number(options.restartWindowMs || 30000));
  const nowMs = options.nowMs || (() => Date.now());
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const restartWindow = createRestartWindow(nowMs, restartWindowMs);
  let child = null;

  function start() {
    output.write(`Starting Mana backend: ${serverPath}\n`);
    child = spawnImpl(process.execPath, [serverPath], {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
    });

    child.on("close", (code) => {
      child = null;
      const recentRestartCount = restartWindow.count();
      if (shouldRespawnBackend({ code, recentRestartCount, maxRestarts })) {
        restartWindow.record();
        output.write("Mana backend soft restart accepted. Restarting...\n");
        schedule(start, restartDelayMs);
        return;
      }

      if (code === MANA_RESTART_EXIT_CODE) {
        errorOutput.write("Mana backend restart limit reached. Not restarting.\n");
      } else {
        output.write(`Mana backend exited with code ${code}.\n`);
      }
    });
  }

  start();

  return {
    get child() {
      return child;
    },
  };
}

if (require.main === module) {
  startSupervisor();
}

module.exports = {
  shouldRespawnBackend,
  startSupervisor,
};
```

- [ ] **Step 5: Add npm scripts**

Modify `node-bot/package.json` scripts:

```json
"mana": "node mana-supervisor.js",
"restart": "node restart-client.js"
```

Keep existing `start`, `doctor`, and `test`.

- [ ] **Step 6: Run tests and command syntax checks**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
node --check restart-client.js
node --check mana-supervisor.js
node --test test\admin-restart.test.js
```

Expected: all pass.

- [ ] **Step 7: Commit CLI and supervisor**

```powershell
git add node-bot\restart-client.js node-bot\mana-supervisor.js node-bot\package.json node-bot\test\admin-restart.test.js
git commit -m "Add Mana restart CLI supervisor"
```

---

### Task 4: Launcher Backend Restart Policy

**Files:**
- Create: `windows-launcher/backend-supervisor.js`
- Create: `windows-launcher/test/backend-supervisor.test.js`
- Modify: `windows-launcher/main.js`

- [ ] **Step 1: Write failing launcher supervisor tests**

Create `windows-launcher/test/backend-supervisor.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANA_RESTART_EXIT_CODE,
  createBackendRestartPolicy,
} = require("../backend-supervisor");

test("launcher restart policy respawns intentional restart exits", () => {
  const scheduled = [];
  const policy = createBackendRestartPolicy({
    nowMs: () => 1000,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });

  assert.equal(
    policy.handleExit({
      code: MANA_RESTART_EXIT_CODE,
      restart: () => "started",
    }),
    "scheduled",
  );
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 500);
});

test("launcher restart policy ignores unexpected backend exits", () => {
  let scheduled = 0;
  const policy = createBackendRestartPolicy({
    schedule: () => {
      scheduled += 1;
    },
  });

  assert.equal(policy.handleExit({ code: 1, restart: () => {} }), "ignored");
  assert.equal(scheduled, 0);
});

test("launcher restart policy caps repeated fast restarts", () => {
  let now = 1000;
  let scheduled = 0;
  const policy = createBackendRestartPolicy({
    maxRestarts: 2,
    nowMs: () => now,
    schedule: () => {
      scheduled += 1;
    },
  });

  assert.equal(policy.handleExit({ code: MANA_RESTART_EXIT_CODE, restart: () => {} }), "scheduled");
  now += 100;
  assert.equal(policy.handleExit({ code: MANA_RESTART_EXIT_CODE, restart: () => {} }), "scheduled");
  now += 100;
  assert.equal(policy.handleExit({ code: MANA_RESTART_EXIT_CODE, restart: () => {} }), "capped");
  assert.equal(scheduled, 2);
});
```

- [ ] **Step 2: Run launcher tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\windows-launcher
node --test test\backend-supervisor.test.js
```

Expected: fail because `../backend-supervisor` does not exist.

- [ ] **Step 3: Implement launcher restart policy module**

Create `windows-launcher/backend-supervisor.js`:

```js
const MANA_RESTART_EXIT_CODE = 77;

function createBackendRestartPolicy(options = {}) {
  const restartDelayMs = Math.max(1, Number(options.restartDelayMs || 500));
  const maxRestarts = Math.max(1, Number(options.maxRestarts || 5));
  const restartWindowMs = Math.max(1000, Number(options.restartWindowMs || 30000));
  const nowMs = options.nowMs || (() => Date.now());
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const restartTimes = [];

  function prune() {
    const cutoff = nowMs() - restartWindowMs;
    while (restartTimes.length && restartTimes[0] < cutoff) {
      restartTimes.shift();
    }
  }

  function handleExit({ code, restart }) {
    if (code !== MANA_RESTART_EXIT_CODE) {
      return "ignored";
    }

    prune();
    if (restartTimes.length >= maxRestarts) {
      return "capped";
    }

    restartTimes.push(nowMs());
    schedule(restart, restartDelayMs);
    return "scheduled";
  }

  return {
    handleExit,
  };
}

module.exports = {
  MANA_RESTART_EXIT_CODE,
  createBackendRestartPolicy,
};
```

- [ ] **Step 4: Wire launcher close handling**

In `windows-launcher/main.js`, add near imports:

```js
const { createBackendRestartPolicy } = require("./backend-supervisor");
```

Near constants, add:

```js
const backendRestartPolicy = createBackendRestartPolicy();
```

Replace the existing `backendProcess.on("close", ...)` body with:

```js
  backendProcess.on("close", (code) => {
    console.log(`Node server exited with code ${code}`);
    backendProcess = null;
    const action = backendRestartPolicy.handleExit({
      code,
      restart: startWindowsServices,
    });
    if (action === "scheduled") {
      console.log("Node backend requested soft restart. Restarting shortly.");
    } else if (action === "capped") {
      console.error("Node backend restart limit reached. Not restarting.");
    }
  });
```

- [ ] **Step 5: Run launcher checks**

Run:

```powershell
cd C:\ManaAI\Mana\windows-launcher
node --check backend-supervisor.js
node --check main.js
node --test test\backend-supervisor.test.js test\doctor-panel.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit launcher restart policy**

```powershell
git add windows-launcher\backend-supervisor.js windows-launcher\main.js windows-launcher\test\backend-supervisor.test.js
git commit -m "Restart Mana backend from launcher"
```

---

### Task 5: Documentation And Final Verification

**Files:**
- Modify: `docs/quick_start_windows.md`
- Modify: `node-bot/README.md`

- [ ] **Step 1: Document restart commands**

Add to `docs/quick_start_windows.md` near the daily run/startup section:

```md
### Soft Restart After Local Changes

If Mana is running from the Windows launcher or `Mana.exe`, type one of these in chat:

```text
/restart
/soft-restart
soft restart Mana
restart Mana
```

Mana restarts only the local Node backend. The launcher and avatar stay open.

From PowerShell:

```powershell
cd C:\ManaAI\Mana\node-bot
npm run restart
```

For a terminal-only workflow with automatic respawn:

```powershell
cd C:\ManaAI\Mana\node-bot
npm run mana
```
```

Add to `node-bot/README.md` near server startup:

```md
### Soft Restart

Run the backend under the lightweight supervisor:

```powershell
npm run mana
```

Ask the running backend to restart:

```powershell
npm run restart
```

The restart endpoint is local-only and rejects non-loopback callers.
```

- [ ] **Step 2: Run final syntax and test checks**

Run:

```powershell
cd C:\ManaAI\Mana\node-bot
node --check admin-restart.js
node --check restart-client.js
node --check mana-supervisor.js
node --check server-routes.js
node --check server.js
node --test test\admin-restart.test.js test\server-routes.test.js
```

Run:

```powershell
cd C:\ManaAI\Mana\windows-launcher
node --check backend-supervisor.js
node --check main.js
node --test test\backend-supervisor.test.js test\doctor-panel.test.js
```

Expected: all commands exit `0`.

- [ ] **Step 3: Optional manual smoke test**

If the user wants a live check and no backend is currently doing important work:

```powershell
cd C:\ManaAI\Mana\node-bot
npm run mana
```

In a second PowerShell:

```powershell
cd C:\ManaAI\Mana\node-bot
npm run restart
```

Expected: the first terminal logs that the backend requested a soft restart and then starts `server.js` again.

- [ ] **Step 4: Commit docs**

```powershell
git add docs\quick_start_windows.md node-bot\README.md
git commit -m "Document Mana soft restart commands"
```

---

## Self-Review

- Spec coverage: route, chat commands, CLI restart command, terminal supervisor fallback, launcher respawn, loopback-only safety, restart-loop cap, docs, and tests are each covered.
- Placeholder scan: no `TODO`, `TBD`, or open-ended implementation steps remain.
- Type consistency: restart exit code is `77` everywhere; helper names are `isRestartCommand`, `isLoopbackAddress`, `createRestartController`, `shouldRespawnBackend`, and `createBackendRestartPolicy`.
