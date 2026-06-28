const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const {
  buildZedOpenTarget,
  createZedIntegration,
} = require("../zed-integration");

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

test("createZedIntegration reports configured env binary when it exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-test-"));
  const zedBin = path.join(tempDir, "zed.exe");
  fs.writeFileSync(zedBin, "fake");

  try {
    const zed = createZedIntegration({
      env: { ZED_BIN: zedBin },
      commandResolver: () => null,
    });

    assert.deepEqual(zed.getStatus(), {
      available: true,
      command: zedBin,
      source: "ZED_BIN",
      message: "Zed CLI is configured.",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createZedIntegration finds zed on PATH when env binary is unset", () => {
  const zed = createZedIntegration({
    env: {},
    commandResolver: () => "C:\\Program Files\\Zed\\zed.exe",
  });

  assert.deepEqual(zed.getStatus(), {
    available: true,
    command: "C:\\Program Files\\Zed\\zed.exe",
    source: "PATH",
    message: "Zed CLI is available on PATH.",
  });
});

test("buildZedOpenTarget resolves existing paths and appends line and column", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-open-"));
  const sourceFile = path.join(tempDir, "app.js");
  fs.writeFileSync(sourceFile, "console.log('mana');\n");

  try {
    assert.equal(
      buildZedOpenTarget({ targetPath: sourceFile, line: 12, column: 3 }),
      `${sourceFile}:12:3`,
    );
    assert.equal(buildZedOpenTarget({ targetPath: tempDir }), tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildZedOpenTarget rejects missing paths and invalid line numbers", () => {
  assert.throws(
    () => buildZedOpenTarget({ targetPath: "" }),
    /path is required/i,
  );
  assert.throws(
    () => buildZedOpenTarget({ targetPath: "C:\\missing\\file.js" }),
    /path does not exist/i,
  );
  assert.throws(
    () => buildZedOpenTarget({ targetPath: __filename, line: 0 }),
    /line must be a positive integer/i,
  );
});

test("open launches Zed without shell expansion", async () => {
  const calls = [];
  const zed = createZedIntegration({
    env: {},
    commandResolver: () => "zed",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { once: (event, handler) => event === "spawn" && handler() };
    },
  });

  const result = await zed.open({ targetPath: __filename, line: 7 });

  assert.equal(result.opened, true);
  assert.deepEqual(calls, [
    {
      command: "zed",
      args: [`${__filename}:7`],
      options: {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    },
  ]);
});

test("createApp exposes Zed status and open routes", async () => {
  const calls = [];
  const app = createApp({
    zed: createZedIntegration({
      env: {},
      commandResolver: () => "zed",
      spawn: (command, args) => {
        calls.push({ command, args });
        return { once: (event, handler) => event === "spawn" && handler() };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const statusResponse = await fetch(`${baseUrl}/zed/status`);
    const statusBody = await statusResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.available, true);
    assert.equal(statusBody.source, "PATH");

    const openResponse = await fetch(`${baseUrl}/zed/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: __filename, line: 4 }),
    });
    const openBody = await openResponse.json();

    assert.equal(openResponse.status, 200);
    assert.equal(openBody.opened, true);
    assert.deepEqual(calls, [{ command: "zed", args: [`${__filename}:4`] }]);
  });
});
