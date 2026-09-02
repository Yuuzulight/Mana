const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

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
      "@mana/cloud-sync",
      "@mana/scheduled-export",
      "@mana/structured-connectors",
      "approvalGate",
      "backend",
      "backgroundMemory",
      "browserAutomation",
      "cloudflareTunnel",
      "contextPush",
      "cronScheduler",
      "deepResearch",
      "dirScanner",
      "discordBot",
      "documentReader",
      "ffxivMarket",
      "hooks",
      "imageGeneration",
      "jobApplications",
      "jobSearchAdzuna",
      "localLlama",
      "localMemory",
      "matrixBridge",
      "mcpClients",
      "memoryFacts",
      "mobileAuth",
      // Issue #357: the editable personality layer reports whether it has
      // been adjusted. Running on the base persona is a healthy state, not
      // a missing configuration.
      "personality",
      "presets",
      "prompt-composition",
      "retrieverAdmin",
      "screenSensing",
      "sessions",
      "skills",
      "stockMarket",
      "telegramBridge",
      "toolCallLog",
      "tts",
      "videoWatch",
      "vtubeStudio",
      "webAccess",
      "whisper",
    ]);
    assert.equal(body.components.backend.status, "available");
    assert.equal(body.components.backend.configured, true);
    // ffxivMarket defaults to disabled (Settings > Plugins) unlike the
    // other plugins, so its health reflects that instead of the
    // "configured from local defaults" status it'd report if enabled.
    assert.deepEqual(body.components.ffxivMarket, {
      status: "disabled",
      configured: false,
      message: "FFXIV Market & Crafting is disabled. Enable it in Settings > Plugins.",
    });
    // No ALPHA_VANTAGE_API_KEY in the test env, so this reports unconfigured
    // rather than failing -- same "optional, degrades gracefully" shape as
    // the other API-key-gated capabilities (webAccess, cloudflareTunnel).
    assert.deepEqual(body.components.stockMarket, {
      status: "unconfigured",
      configured: false,
      message:
        "Set ALPHA_VANTAGE_API_KEY to enable real-world stock market data (see docs/API_KEYS.md).",
    });
    // No ADZUNA_APP_ID/ADZUNA_APP_KEY in the test env either -- same
    // graceful-degradation shape as stockMarket above.
    assert.deepEqual(body.components.jobSearchAdzuna, {
      status: "unconfigured",
      configured: false,
      message:
        "Set ADZUNA_APP_ID and ADZUNA_APP_KEY to enable live job search (see plugins/job-search-adzuna/README.md).",
    });
    assert.equal(typeof body.components.localLlama.message, "string");
  });
});

test("repeated /health requests do not grow the Express route stack", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    await fetch(`${baseUrl}/health`);
    const stackLengthAfterFirstCall = app._router.stack.length;

    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/health`);
    }

    assert.equal(app._router.stack.length, stackLengthAfterFirstCall);
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
    assert.match(
      body.components.cloudflareTunnel.message,
      /reachable from the internet/i,
    );
    assert.equal(body.components.vtubeStudio.status, "configured");
    assert.equal(raw.includes("secret-passcode-hash"), false);
    assert.equal(raw.includes("secret-session-value"), false);
    assert.equal(raw.includes("secret-cloudflare-token"), false);
  });
});
