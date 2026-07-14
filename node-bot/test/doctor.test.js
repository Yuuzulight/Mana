const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const { runDoctorChecks, runDoctorChecksAsync } = require("../doctor");

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

async function withRawServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn({ port, url: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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
      ports: [],
      services: [],
      versions: {
        node: "v22.19.0",
      },
      zedCommandResolver: () => null,
    });

    assert.equal(result.ok, false);
    assert.equal(result.summary.pass, 5);
    assert.equal(result.summary.warn, 9);
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
        "mobile-auth",
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
        TTS_PROVIDER: "chatterbox",
        CHATTERBOX_TTS_URL: url,
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-tts-")),
      },
      ports: [],
      versions: {
        node: "v22.19.0",
      },
    });

    const tts = result.checks.find((check) => check.id === "tts-services");

    assert.equal(tts.status, "pass");
    assert.equal(tts.details.services.length, 1);
    assert.deepEqual(tts.details.services[0], {
      id: "chatterbox",
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
        TTS_PROVIDER: "chatterbox",
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-sovits-off-")),
      },
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

test("async doctor reports backend port availability", async () => {
  await withRawServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  }, async ({ port }) => {
    const freePort = await getFreePort();
    const result = await runDoctorChecksAsync({
      env: {
        MANA_ALLOW_REMOTE_AI: "0",
        LLAMA_BIN: "",
        LLAMA_MODEL: "",
        WHISPER_BIN: "",
        WHISPER_MODEL: "",
        MOBILE_PASSCODE_HASH: "",
        MOBILE_SESSION_SECRET: "",
        PORT: String(freePort),
      },
      paths: {
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-doctor-port-")),
      },
      ports: [{ id: "occupied-test", host: "127.0.0.1", port }],
      versions: {
        node: "v22.19.0",
      },
    });

    const ports = result.checks.find((check) => check.id === "ports");

    assert.equal(ports.status, "warn");
    assert.equal(ports.details.ports.length, 2);
    assert.equal(ports.details.ports[0].id, "mana-backend");
    assert.equal(ports.details.ports[0].ok, true);
    assert.equal(ports.details.ports[1].id, "occupied-test");
    assert.equal(ports.details.ports[1].ok, false);

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
