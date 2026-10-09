const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const {
  runDoctorChecks,
  runDoctorChecksAsync,
  checkVramBudgets,
  checkCodingSession,
} = require("../doctor");
const { withServer, withRawServer, useTestAdminToken } = require("./helpers");

// Every route but a few public ones needs an admin key (admin-key.js).
const fetch = useTestAdminToken();

test("doctor checks return structured pass warn and fail results", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-"));
  const existingFile = path.join(tempDir, "llama-cli.exe");
  fs.writeFileSync(existingFile, "fake");

  try {
    const result = runDoctorChecks({
      env: {
        MANA_ALLOW_REMOTE_AI: "1",
        LLAMA_BIN: existingFile,
        LLAMA_MODEL: path.join(tempDir, "missing-model.gguf"),
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MANA_MOBILE_PASSCODE_HASH: "",
      },
      paths: {
        dataDir: tempDir,
      },
      whisperToolsDir: tempDir,
      ports: [],
      services: [],
      versions: {
        node: "v22.19.0",
      },
      zedCommandResolver: () => null,
      gpu: null,
    });

    assert.equal(result.ok, false);
    // Issue #48: mobile-2fa always reports "pass" (it's opt-in, so not
    // having enabled it is a valid state, not a warning) -- one more pass
    // than before that check existed.
    // Issue #1343: vram-budgets and coding-session report pass with defaults.
    assert.equal(result.summary.pass, 9);
    assert.equal(result.summary.warn, 10);
    assert.equal(result.summary.fail, 1);

    assert.deepEqual(
      result.checks.map((check) => check.id),
      [
        "node-runtime",
        "local-ai-policy",
        "llama-binary",
        "llama-model",
        "llama-server-binary",
        "llama-vision-model",
        "whisper-config",
        "tts-services",
        "mcp-server",
        "gpu",
        "recommended-model-profile",
        "vram-budgets",
        "coding-session",
        "mobile-auth",
        "mobile-2fa",
        "remote-exposure",
        "storage",
        "zed-editor",
        "vscode-editor",
        "zed-external-agent",
      ],
    );
    assert.equal(result.checks.find((check) => check.id === "node-runtime").status, "pass");
    assert.equal(
      result.checks.find((check) => check.id === "local-ai-policy").status,
      "warn",
    );
    assert.equal(result.checks.find((check) => check.id === "llama-model").status, "fail");
    assert.equal(result.checks.find((check) => check.id === "zed-editor").status, "warn");
    assert.equal(result.checks.find((check) => check.id === "vscode-editor").status, "warn");
    assert.equal(
      result.checks.find((check) => check.id === "zed-external-agent").status,
      "warn",
    );
    assert.match(
      result.checks.find((check) => check.id === "llama-model").message,
      /not found/i,
    );
    assert.equal(result.generatedAt.endsWith("Z"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("doctor surfaces the injected hardware model recommendation", () => {
  const fakeRecommendation = {
    profile: "fast",
    label: "Fast fallback",
    reason: "Detected ~6.0GB GPU VRAM (via nvidia-smi). Under 8GB...",
    detected: { vramMb: 6144, ramMb: 32768 },
  };
  const result = runDoctorChecks({
    env: { MANA_ALLOW_REMOTE_AI: "0" },
    paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
    ports: [],
    services: [],
    versions: { node: "v22.19.0" },
    zedCommandResolver: () => null,
    modelManagement: {
      getRecommendedModelProfile: () => fakeRecommendation,
    },
  });

  const check = result.checks.find((c) => c.id === "recommended-model-profile");
  assert.equal(check.status, "pass");
  assert.match(check.message, /Fast fallback \(fast\)/);
  assert.match(check.message, /manual profile selection.*unaffected/i);
  assert.deepEqual(check.details.recommendation, fakeRecommendation);
});

test("doctor GPU row: pass with CUDA, otherwise warns that voice and chat run on CPU", () => {
  const run = (gpu) =>
    runDoctorChecks({
      env: { MANA_ALLOW_REMOTE_AI: "0" },
      paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
      ports: [],
      services: [],
      versions: { node: "v22.19.0" },
      zedCommandResolver: () => null,
      gpu,
    }).checks.find((c) => c.id === "gpu");

  const cuda = run({ vendor: "nvidia", name: "NVIDIA GeForce RTX 5080", vramMb: 16303, cuda: true, sharedMemory: false });
  assert.equal(cuda.status, "pass");
  assert.match(cuda.message, /RTX 5080 \(15\.9 GB VRAM\): CUDA available/);

  const none = run(null);
  assert.equal(none.status, "warn");
  assert.equal(none.message, "No NVIDIA GPU: voice and chat run on CPU.");

  const amd = run({ vendor: "amd", name: "AMD Radeon RX 7900 XTX", vramMb: 24576, cuda: false, sharedMemory: false });
  assert.equal(amd.status, "warn");
  assert.match(amd.message, /found AMD Radeon RX 7900 XTX, 24\.0 GB VRAM.*run on CPU/);

  const igpu = run({ vendor: "intel", name: "Intel(R) Iris(R) Xe Graphics", vramMb: null, cuda: false, sharedMemory: true });
  assert.match(igpu.message, /integrated, shared memory/);

  const noSmi = run({ vendor: "nvidia", name: "NVIDIA GeForce RTX 3060", vramMb: 12288, cuda: false, sharedMemory: false });
  assert.equal(noSmi.status, "warn");
  assert.match(noSmi.message, /nvidia-smi isn't answering/);
});

test("doctor passes an auto-detected llama-server and only warns when none is found", () => {
  const run = (findLlamaServerBin) =>
    runDoctorChecks({
      env: { MANA_ALLOW_REMOTE_AI: "0" },
      paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
      ports: [],
      services: [],
      versions: { node: "v22.19.0" },
      zedCommandResolver: () => null,
      findLlamaServerBin,
    }).checks.find((c) => c.id === "llama-server-binary");

  const found = run(() => "D:\\llama\\llama-server.exe");
  assert.equal(found.status, "pass");
  assert.match(found.message, /auto-detected/);
  assert.equal(found.details.path, "D:\\llama\\llama-server.exe");

  const missing = run(() => {
    throw new Error("llama-server executable not found");
  });
  assert.equal(missing.status, "warn");
  assert.match(missing.message, /auto-detection found none/);
});

function runDoctorForFishWarmup(fishTtsWarmup) {
  return runDoctorChecks({
    env: { MANA_ALLOW_REMOTE_AI: "0" },
    paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
    ports: [],
    services: [],
    versions: { node: "v22.19.0" },
    zedCommandResolver: () => null,
    fishTtsWarmup,
  });
}

test("doctor omits the voice-warmup check entirely when there's nothing to report (issue #215)", () => {
  for (const status of [undefined, "idle", "skipped"]) {
    const result = runDoctorForFishWarmup(status);
    assert.equal(
      result.checks.find((c) => c.id === "fish-tts-warmup"),
      undefined,
      `expected no fish-tts-warmup check for status ${status}`,
    );
  }
});

test("doctor warns while Fish Speech's torch.compile warmup is in progress", () => {
  const result = runDoctorForFishWarmup("warming");
  const check = result.checks.find((c) => c.id === "fish-tts-warmup");
  assert.equal(check.status, "warn");
  assert.match(check.message, /compiling/i);
});

test("doctor warns (not fails) when Fish Speech's warmup call itself failed", () => {
  const result = runDoctorForFishWarmup("failed");
  const check = result.checks.find((c) => c.id === "fish-tts-warmup");
  assert.equal(check.status, "warn");
  assert.match(check.message, /warmup request failed/i);
});

test("doctor passes once Fish Speech's warmup has completed", () => {
  const result = runDoctorForFishWarmup("ready");
  const check = result.checks.find((c) => c.id === "fish-tts-warmup");
  assert.equal(check.status, "pass");
  assert.match(check.message, /warmed up/i);
});

function runDoctorForSessionSearchVector(sessionSearchVectorEnabled) {
  return runDoctorChecks({
    env: { MANA_ALLOW_REMOTE_AI: "0" },
    paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
    ports: [],
    services: [],
    versions: { node: "v22.19.0" },
    zedCommandResolver: () => null,
    sessionSearchVectorEnabled,
  });
}

test("doctor omits the session-search-vector-index check when no sessionSearchIndex was passed at all (issue #321)", () => {
  const result = runDoctorForSessionSearchVector(undefined);
  assert.equal(
    result.checks.find((c) => c.id === "session-search-vector-index"),
    undefined,
  );
});

test("doctor warns when sqlite-vec's vector index failed to load", () => {
  const result = runDoctorForSessionSearchVector(false);
  const check = result.checks.find((c) => c.id === "session-search-vector-index");
  assert.equal(check.status, "warn");
  assert.match(check.message, /keyword-only/i);
  assert.match(check.message, /package-lock\.json/);
});

test("doctor passes when sqlite-vec's vector index loaded", () => {
  const result = runDoctorForSessionSearchVector(true);
  const check = result.checks.find((c) => c.id === "session-search-vector-index");
  assert.equal(check.status, "pass");
  assert.match(check.message, /hybrid keyword \+ semantic/i);
});

function runDoctorForPromptComposition(promptComposition) {
  return runDoctorChecks({
    env: { MANA_ALLOW_REMOTE_AI: "0" },
    paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
    ports: [],
    services: [],
    versions: { node: "v22.19.0" },
    zedCommandResolver: () => null,
    promptComposition,
  });
}

test("doctor omits the prompt-composition check when nothing has been recorded yet (issue #400)", () => {
  const result = runDoctorForPromptComposition(null);
  assert.equal(
    result.checks.find((c) => c.id === "prompt-composition"),
    undefined,
  );
});

test("doctor passes prompt-composition when the last assembled prompt dropped nothing", () => {
  const result = runDoctorForPromptComposition({
    totalChars: 500,
    totalEstTokens: 125,
    blocks: [
      { name: "system-prompt", chars: 500, estTokens: 125, dropped: { skillsOmitted: 0 } },
    ],
  });
  const check = result.checks.find((c) => c.id === "prompt-composition");
  assert.equal(check.status, "pass");
  assert.match(check.message, /dropped nothing/i);
});

test("doctor warns prompt-composition when a block dropped content, naming which block", () => {
  const result = runDoctorForPromptComposition({
    totalChars: 500,
    totalEstTokens: 125,
    blocks: [
      { name: "system-prompt", chars: 400, estTokens: 100, dropped: { skillsOmitted: 3 } },
      { name: "prompt-memory", chars: 100, estTokens: 25, dropped: { truncated: false, turnsDroppedByAge: 0 } },
    ],
  });
  const check = result.checks.find((c) => c.id === "prompt-composition");
  assert.equal(check.status, "warn");
  assert.match(check.message, /system-prompt/);
});

// Q18 (#645): plain-text secrets are named by Doctor (never their values),
// not warned about on every start.
test("doctor names plain-text secrets in .env, from GET /doctor", async () => {
  const run = (plainTextSecrets) =>
    runDoctorChecks({
      env: { MANA_ALLOW_REMOTE_AI: "0" },
      paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
      versions: { node: "v22.19.0" },
      zedCommandResolver: () => null,
      plainTextSecrets,
    }).checks.find((c) => c.id === "plain-text-secrets");
  assert.equal(run(undefined), undefined);
  assert.equal(run([]).status, "pass");
  const warned = run(["OPENAI_API_KEY", "ADMIN_TOKEN"]);
  assert.equal(warned.status, "warn");
  assert.match(warned.message, /2 secret\(s\) in plain text in node-bot\/\.env: OPENAI_API_KEY, ADMIN_TOKEN/);

  let seen = null;
  const app = createApp({
    plainTextSecretKeys: () => ["MANA_DISCORD_BOT_TOKEN"],
    doctor: (options) => {
      seen = options.plainTextSecrets;
      return { ok: true, summary: { pass: 0, warn: 0, fail: 0 }, checks: [] };
    },
  });
  await withServer(app, async (baseUrl) => {
    await fetch(`${baseUrl}/doctor`);
  });
  assert.deepEqual(seen, ["MANA_DISCORD_BOT_TOKEN"]);
});

// Q28 (#620): closed memory-graph windows are kept forever, so Doctor shows
// how many there are -- from the live graph, via GET /doctor.
test("doctor shows the memory graph's history size, from the live graph", async () => {
  assert.equal(runDoctorForPromptComposition(null).checks.find((c) => c.id === "memory-graph-history"), undefined);

  let seen = null;
  const app = createApp({
    acpMemoryStore: { memoryGraph: { getHistorySize: () => ({ live: 3, closed: 4, archived: 5 }) } },
    doctor: (options) => {
      seen = options.memoryGraphHistory;
      return runDoctorChecks({
        env: { MANA_ALLOW_REMOTE_AI: "0" },
        paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
        versions: { node: "v22.19.0" },
        zedCommandResolver: () => null,
        memoryGraphHistory: options.memoryGraphHistory,
      });
    },
  });
  await withServer(app, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/doctor`)).json();
    const check = body.checks.find((c) => c.id === "memory-graph-history");
    assert.equal(check.status, "pass");
    assert.match(check.message, /3 live associations; 9 closed association windows kept/);
  });
  assert.deepEqual(seen, { live: 3, closed: 4, archived: 5 });
});

test("doctor passes remote exposure when no tunnel is configured", () => {
  const result = runDoctorChecks({
    env: {},
    paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
    ports: [],
    services: [],
    versions: { node: "v22.19.0" },
    zedCommandResolver: () => null,
  });
  const check = result.checks.find((c) => c.id === "remote-exposure");
  assert.equal(check.status, "pass");
  assert.match(check.message, /only reachable on localhost/i);
});

test("doctor warns on remote exposure when a tunnel and mobile auth are both configured", () => {
  const result = runDoctorChecks({
    env: {
      MANA_TUNNEL_URL: "https://mana.example.com",
      MOBILE_PASSCODE_HASH: "hash",
      MOBILE_SESSION_SECRET: "secret",
    },
    paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
    ports: [],
    services: [],
    versions: { node: "v22.19.0" },
    zedCommandResolver: () => null,
  });
  const check = result.checks.find((c) => c.id === "remote-exposure");
  assert.equal(check.status, "warn");
  assert.match(check.message, /reachable from the internet/i);
});

// Issue #670: a non-loopback MANA_BIND_HOST is the LAN version of a tunnel.
test("doctor warns on remote exposure when MANA_BIND_HOST is not loopback", () => {
  const run = (env) =>
    runDoctorChecks({
      env,
      paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
      ports: [],
      services: [],
      versions: { node: "v22.19.0" },
      zedCommandResolver: () => null,
    }).checks.find((c) => c.id === "remote-exposure");

  const lan = run({ MANA_BIND_HOST: "0.0.0.0" });
  assert.equal(lan.status, "warn");
  assert.match(lan.message, /MANA_BIND_HOST=0\.0\.0\.0/);

  assert.equal(run({ MANA_BIND_HOST: "127.0.0.1" }).status, "pass");

  const lanAndTunnel = run({ MANA_BIND_HOST: "0.0.0.0", CLOUDFLARE_TUNNEL_TOKEN: "token" });
  assert.equal(lanAndTunnel.status, "fail");
  assert.match(lanAndTunnel.message, /MANA_BIND_HOST=0\.0\.0\.0/);
});

test("doctor fails remote exposure when a tunnel is configured without mobile auth", () => {
  const result = runDoctorChecks({
    env: { CLOUDFLARE_TUNNEL_TOKEN: "token" },
    paths: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-test-")) },
    ports: [],
    services: [],
    versions: { node: "v22.19.0" },
    zedCommandResolver: () => null,
  });
  const check = result.checks.find((c) => c.id === "remote-exposure");
  assert.equal(check.status, "fail");
  assert.match(check.message, /unauthenticated routes/i);
});

test("doctor reports Mana external agent entry point availability", () => {
  const result = runDoctorChecks({
    env: {
      MANA_ALLOW_REMOTE_AI: "0",
      LLAMA_BIN: "",
      LLAMA_MODEL: "",
      WHISPER_BIN: "",
      WHISPER_MODEL: "",
      MOBILE_PASSCODE_HASH: "",
      MOBILE_SESSION_SECRET: "",
    },
    paths: {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-acp-")),
    },
    whisperToolsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-acp-whisper-")),
    services: [],
    versions: {
      node: "v22.19.0",
    },
    zedCommandResolver: () => null,
  });

  try {
    const acp = result.checks.find((check) => check.id === "zed-external-agent");

    assert.equal(acp.status, "pass");
    assert.match(acp.message, /Mana external agent entry point is available/i);
    assert.match(acp.details.command, /mana-acp-agent\.js --acp$/);
    assert.equal(acp.details.remoteAllowed, false);
  } finally {
    fs.rmSync(result.checks.find((check) => check.id === "storage").details.dataDir, {
      recursive: true,
      force: true,
    });
  }
});

test("doctor reports configured Zed editor availability", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-zed-"));
  const zedBin = path.join(tempDir, "zed.exe");
  const vscodeBin = path.join(tempDir, "code.cmd");
  fs.writeFileSync(zedBin, "fake");
  fs.writeFileSync(vscodeBin, "fake");

  try {
    const result = runDoctorChecks({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
        ZED_BIN: zedBin,
        VSCODE_BIN: vscodeBin,
      },
      paths: {
        dataDir: tempDir,
      },
      whisperToolsDir: tempDir,
      services: [],
      versions: {
        node: "v22.19.0",
      },
    });

    const zed = result.checks.find((check) => check.id === "zed-editor");
    const vscode = result.checks.find((check) => check.id === "vscode-editor");

    assert.equal(zed.status, "pass");
    assert.equal(zed.details.command, zedBin);
    assert.equal(zed.details.source, "ZED_BIN");
    assert.equal(vscode.status, "pass");
    assert.equal(vscode.details.command, vscodeBin);
    assert.equal(vscode.details.source, "VSCODE_BIN");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createApp exposes doctor checks without leaking secrets", async () => {
  const app = createApp({
    doctor: () => ({
      ok: true,
      generatedAt: "2026-06-28T00:00:00.000Z",
      summary: { pass: 1, warn: 0, fail: 0 },
      checks: [
        {
          id: "local-ai-policy",
          label: "Local AI policy",
          status: "pass",
          message: "Remote AI is disabled.",
          details: {
            secretValue: "[redacted]",
          },
        },
      ],
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/doctor`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.summary.pass, 1);
    assert.equal(body.checks[0].id, "local-ai-policy");
    assert.equal(JSON.stringify(body).includes("unit-test-secret"), false);
  });
});

test("async doctor probes Qwen3-TTS's /health when it's the provider", async () => {
  await withRawServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end();
  }, async ({ url }) => {
    const result = await runDoctorChecksAsync({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
        TTS_PROVIDER: "qwen3tts",
        QWEN3_TTS_URL: url,
        FISH_TTS_URL: "http://127.0.0.1:1",
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-qwen-")),
      },
      whisperToolsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-qwen-whisper-")),
      ports: [],
      versions: { node: "v22.19.0" },
    });

    const tts = result.checks.find((check) => check.id === "tts-services");
    assert.equal(tts.status, "pass");
    assert.deepEqual(tts.details.services, [
      { id: "qwen3tts", url: `${url}/health`, ok: true, statusCode: 200 },
    ]);

    fs.rmSync(result.checks.find((check) => check.id === "storage").details.dataDir, {
      recursive: true,
      force: true,
    });
  });
});

test("async doctor probes configured TTS health URLs", async () => {
  await withRawServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end();
  }, async ({ url }) => {
    const result = await runDoctorChecksAsync({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
        TTS_PROVIDER: "kokoro",
        KOKORO_TTS_URL: url,
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-tts-")),
      },
      whisperToolsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-tts-whisper-")),
      ports: [],
      versions: {
        node: "v22.19.0",
      },
    });

    const tts = result.checks.find((check) => check.id === "tts-services");

    assert.equal(tts.status, "pass");
    assert.equal(tts.details.services.length, 1);
    assert.deepEqual(tts.details.services[0], {
      id: "kokoro",
      url: `${url}/health`,
      ok: true,
      statusCode: 200,
    });

    fs.rmSync(result.checks.find((check) => check.id === "storage").details.dataDir, {
      recursive: true,
      force: true,
    });
  });
});

test("async doctor checks GPT-SoVITS only when it is the selected provider", async () => {
  await withRawServer((req, res) => {
    // api_v2.py has no /health route; any response (even 404) means alive.
    res.writeHead(404);
    res.end();
  }, async ({ url }) => {
    const enabledResult = await runDoctorChecksAsync({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
        TTS_PROVIDER: "gpt_sovits",
        GPT_SOVITS_TTS_URL: url,
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-sovits-")),
      },
      whisperToolsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-sovits-whisper-")),
      ports: [],
      versions: { node: "v22.19.0" },
    });

    const sovits = enabledResult.checks.find((check) => check.id === "gpt-sovits");
    assert.equal(sovits.status, "pass");
    assert.match(sovits.message, /reachable/i);

    fs.rmSync(
      enabledResult.checks.find((check) => check.id === "storage").details.dataDir,
      { recursive: true, force: true },
    );

    const disabledResult = await runDoctorChecksAsync({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
        TTS_PROVIDER: "kokoro",
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-sovits-off-")),
      },
      whisperToolsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-sovits-off-whisper-")),
      ports: [],
      versions: { node: "v22.19.0" },
    });

    assert.equal(
      disabledResult.checks.find((check) => check.id === "gpt-sovits"),
      undefined,
    );

    fs.rmSync(
      disabledResult.checks.find((check) => check.id === "storage").details.dataDir,
      { recursive: true, force: true },
    );
  });
});

// No default port check runs here -- see getDefaultPortChecks's comment in
// doctor.js: checking whether node-bot's own configured port is "free"
// only makes sense before it's started, and the only real caller of
// runDoctorChecksAsync is this same server's own /doctor route, where that
// port is trivially always in use by the process answering the request.
// This test only exercises a caller-supplied port check (options.ports),
// which is still real and still useful (e.g. a plugin's own service port).
test("async doctor reports availability of a caller-supplied port", async () => {
  await withRawServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  }, async ({ port }) => {
    const result = await runDoctorChecksAsync({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-port-")),
      },
      whisperToolsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-port-whisper-")),
      ports: [{ id: "occupied-test", host: "127.0.0.1", port }],
      versions: {
        node: "v22.19.0",
      },
    });

    const ports = result.checks.find((check) => check.id === "ports");

    assert.equal(ports.status, "warn");
    assert.equal(ports.details.ports.length, 1);
    assert.equal(ports.details.ports[0].id, "occupied-test");
    assert.equal(ports.details.ports[0].ok, false);

    fs.rmSync(result.checks.find((check) => check.id === "storage").details.dataDir, {
      recursive: true,
      force: true,
    });
  });
});

test("async doctor reports Zed external agent backend health", async () => {
  await withRawServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end();
  }, async ({ url }) => {
    const result = await runDoctorChecksAsync({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
        MANA_BACKEND_URL: url,
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-acp-backend-")),
      },
      whisperToolsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-acp-backend-whisper-")),
      ports: [],
      services: [],
      versions: {
        node: "v22.19.0",
      },
    });

    try {
      const backend = result.checks.find(
        (check) => check.id === "zed-external-agent-backend",
      );

      assert.equal(backend.status, "pass");
      assert.match(backend.message, /local backend is reachable/i);
      assert.equal(backend.details.url, `${url}/health`);
      assert.equal(backend.details.ok, true);
    } finally {
      fs.rmSync(result.checks.find((check) => check.id === "storage").details.dataDir, {
        recursive: true,
        force: true,
      });
    }
  });
});

test("Doctor warns when a non-English speech language meets an English-only Whisper model", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-whisper-lang-"));
  const bin = path.join(tempDir, "whisper-cli.exe");
  const model = path.join(tempDir, "ggml-tiny.en.bin");
  fs.writeFileSync(bin, "");
  fs.writeFileSync(model, "");
  const whisperCheck = (whisperLanguage) =>
    runDoctorChecks({
      env: { WHISPER_BIN: bin, WHISPER_MODEL: model },
      paths: { dataDir: tempDir },
      whisperToolsDir: tempDir,
      whisperLanguage,
      ports: [],
      services: [],
      zedCommandResolver: () => null,
    }).checks.find((check) => check.id === "whisper-config");
  try {
    assert.equal(whisperCheck("en").status, "pass");
    const auto = whisperCheck("auto");
    assert.equal(auto.status, "warn");
    assert.match(auto.message, /ggml-tiny\.en\.bin is English-only/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("checkVramBudgets reports headroom, host RAM parking, constrained, and gaming lock", () => {
  const gpu = { name: "NVIDIA GeForce RTX 5080", cuda: true, vramMb: 16303 };

  // Headroom >= 9000 MB: ready for 14B coder
  const pass9g = checkVramBudgets({ gpu, vramUsage: { usedMb: 3000, freeMb: 13303 } });
  assert.equal(pass9g.status, "pass");
  assert.equal(pass9g.details.codingEngineReady, true);
  assert.match(pass9g.message, /ready for instant on-demand 14B Coder engine/);

  // Headroom between 4000 and 8999 MB: everyday resident active, 14B parks resident in RAM
  const pass4g = checkVramBudgets({ gpu, vramUsage: { usedMb: 10000, freeMb: 6303 } });
  assert.equal(pass4g.status, "pass");
  assert.equal(pass4g.details.requiresHostRamParking, true);
  assert.match(pass4g.message, /everyday resident model active/);

  // Headroom < 4000 MB: constrained warn
  const warnLow = checkVramBudgets({ gpu, vramUsage: { usedMb: 14000, freeMb: 2303 } });
  assert.equal(warnLow.status, "warn");
  assert.equal(warnLow.details.codingEngineReady, false);
  assert.match(warnLow.message, /VRAM constrained/);

  // Gaming active: locks out 14B coder
  const warnGaming = checkVramBudgets({
    gpu,
    vramUsage: { usedMb: 12000, freeMb: 4303 },
    gamingWatch: { isGaming: () => true },
  });
  assert.equal(warnGaming.status, "warn");
  assert.equal(warnGaming.details.codingEngineLocked, true);
  assert.match(warnGaming.message, /Gaming mode active/);

  // No CUDA GPU: reports pass (not applicable)
  const noCuda = checkVramBudgets({ gpu: null });
  assert.equal(noCuda.status, "pass");
  assert.match(noCuda.message, /No CUDA GPU detected/);
});

test("checkCodingSession reports everyday mode and active sticky coding mode", () => {
  // Inactive / everyday
  const idle = checkCodingSession(null);
  assert.equal(idle.status, "pass");
  assert.equal(idle.details.active, false);
  assert.match(idle.message, /Everyday mode active/);

  // Active sticky coding session
  const active = checkCodingSession({
    isCodingSessionActive: () => true,
    remainingMs: () => 12 * 60 * 1000,
  });
  assert.equal(active.status, "pass");
  assert.equal(active.details.active, true);
  assert.match(active.message, /Coding mode active/);
  assert.match(active.message, /12m remaining/);
});


test("doctor memory vault row warns per finding kind with paths, reason and recovery (#1389)", () => {
  const finding = (kind, p) => ({ kind, path: p, why: "Why.", fix: "Do this." });
  const base = { vaultDir: "V", writable: true, notes: 3, skipped: [], error: null, mode: "watching" };
  const find = (vault) => runDoctorChecks({ memoryVault: vault }).checks.find((c) => c.id === "memory-vault");

  assert.equal(find({ ...base, findings: [] }).status, "pass");
  const check = find({
    ...base,
    findings: [finding("misplaced-fact", "Facts/A/x.md"), finding("misplaced-fact", "Facts/A/y.md"), finding("unowned-view", "Views/Mine.md")],
  });
  assert.equal(check.status, "warn");
  assert.match(check.message, /Fact notes Mana can't see: Facts\/A\/x\.md, Facts\/A\/y\.md\. Why\. Do this\./);
  assert.match(check.message, /Your files in Views\/: Views\/Mine\.md/);
  assert.match(check.message, /never overwritten/);
});
