const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const { runDoctorChecks } = require("../doctor");

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
    });

    assert.equal(result.ok, false);
    assert.equal(result.summary.pass, 3);
    assert.equal(result.summary.warn, 4);
    assert.equal(result.summary.fail, 1);

    assert.deepEqual(
      result.checks.map((check) => check.id),
      [
        "node-runtime",
        "local-ai-policy",
        "llama-binary",
        "llama-model",
        "whisper-config",
        "tts-services",
        "mobile-auth",
        "storage",
      ],
    );
    assert.equal(result.checks.find((check) => check.id === "node-runtime").status, "pass");
    assert.equal(
      result.checks.find((check) => check.id === "local-ai-policy").status,
      "warn",
    );
    assert.equal(result.checks.find((check) => check.id === "llama-model").status, "fail");
    assert.match(
      result.checks.find((check) => check.id === "llama-model").message,
      /not found/i,
    );
    assert.equal(result.generatedAt.endsWith("Z"), true);
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
