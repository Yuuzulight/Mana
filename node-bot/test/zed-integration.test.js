const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const {
  buildZedOpenTarget,
  createEditorIntegrations,
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

test("createEditorIntegrations reports Zed and VS Code availability", () => {
  const editors = createEditorIntegrations({
    env: {},
    commandResolver: (command) =>
      command === "zed"
        ? "C:\\Program Files\\Zed\\zed.exe"
        : "C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
  });

  const status = editors.getStatus();

  assert.equal(status.defaultEditor, "zed");
  assert.equal(status.editors.zed.available, true);
  assert.equal(status.editors.zed.command, "C:\\Program Files\\Zed\\zed.exe");
  assert.equal(status.editors.vscode.available, true);
  assert.equal(
    status.editors.vscode.command,
    "C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
  );
});

test("createEditorIntegrations uses MANA_DEFAULT_EDITOR when it names a supported editor", () => {
  const editors = createEditorIntegrations({
    env: { MANA_DEFAULT_EDITOR: "vscode" },
    commandResolver: (command) => command,
  });

  assert.equal(editors.getStatus().defaultEditor, "vscode");
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

test("generic open uses Zed by default and VS Code when requested", async () => {
  const calls = [];
  const editors = createEditorIntegrations({
    env: {},
    commandResolver: (command) => command,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { once: (event, handler) => event === "spawn" && handler() };
    },
  });

  await editors.open({ targetPath: __filename, line: 7 });
  await editors.open({ editor: "vscode", targetPath: __filename, line: 8, column: 2 });

  assert.deepEqual(calls.map((call) => ({ command: call.command, args: call.args })), [
    { command: "zed", args: [`${__filename}:7`] },
    { command: "code", args: ["-g", `${__filename}:8:2`] },
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].options.shell, false);
});

test("generic open can launch a configured VS Code command script on Windows", async () => {
  const calls = [];
  const editors = createEditorIntegrations({
    env: { MANA_DEFAULT_EDITOR: "vscode" },
    commandResolver: () => "C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
    platform: "win32",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { once: (event, handler) => event === "spawn" && handler() };
    },
  });

  await editors.open({ targetPath: __filename, line: 9 });

  assert.equal(calls[0].command, "cmd.exe");
  assert.deepEqual(calls[0].args, [
    "/d",
    "/s",
    "/c",
    "\"C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\" \"-g\" \"" +
      `${__filename}:9` +
      "\"",
  ]);
  assert.equal(calls[0].options.shell, false);
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

test("createApp exposes generic editor status and open routes", async () => {
  const calls = [];
  const app = createApp({
    editors: createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      spawn: (command, args) => {
        calls.push({ command, args });
        return { once: (event, handler) => event === "spawn" && handler() };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const statusResponse = await fetch(`${baseUrl}/editors/status`);
    const statusBody = await statusResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.defaultEditor, "zed");
    assert.equal(statusBody.editors.zed.available, true);
    assert.equal(statusBody.editors.vscode.available, true);

    const defaultOpenResponse = await fetch(`${baseUrl}/editors/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: __filename, line: 4 }),
    });
    const defaultOpenBody = await defaultOpenResponse.json();

    assert.equal(defaultOpenResponse.status, 200);
    assert.equal(defaultOpenBody.editor, "zed");

    const vscodeOpenResponse = await fetch(`${baseUrl}/editors/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editor: "vscode", path: __filename, line: 5 }),
    });
    const vscodeOpenBody = await vscodeOpenResponse.json();

    assert.equal(vscodeOpenResponse.status, 200);
    assert.equal(vscodeOpenBody.editor, "vscode");
    assert.deepEqual(calls, [
      { command: "zed", args: [`${__filename}:4`] },
      { command: "code", args: ["-g", `${__filename}:5`] },
    ]);
  });
});
