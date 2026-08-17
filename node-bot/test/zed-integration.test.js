const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const {
  buildZedOpenTarget,
  createEditorIntegrations,
  createEditorWorkspaceInspector,
  createEditorWorkspaceStore,
  createZedIntegration,
} = require("../zed-integration");
const { withServer } = require("./helpers");

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

test("workspace store normalizes files to their parent directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-workspace-"));
  const sourceFile = path.join(tempDir, "index.js");
  fs.writeFileSync(sourceFile, "console.log('workspace');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();

    const fileWorkspace = workspaceStore.setWorkspace(sourceFile, {
      editor: "zed",
      reason: "open",
    });
    const folderWorkspace = workspaceStore.setWorkspace(tempDir, {
      editor: "vscode",
      reason: "manual",
    });

    assert.equal(fileWorkspace.path, tempDir);
    assert.equal(fileWorkspace.editor, "zed");
    assert.equal(fileWorkspace.reason, "open");
    assert.equal(folderWorkspace.path, tempDir);
    assert.equal(folderWorkspace.editor, "vscode");
    assert.equal(folderWorkspace.reason, "manual");
    assert.equal(workspaceStore.getWorkspace().path, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("generic open records the active workspace after opening a file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-open-workspace-"));
  const sourceFile = path.join(tempDir, "app.js");
  fs.writeFileSync(sourceFile, "console.log('open workspace');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
    });

    const result = await editors.open({ editor: "vscode", targetPath: sourceFile, line: 3 });

    assert.equal(result.workspace.path, tempDir);
    assert.equal(result.workspace.editor, "vscode");
    assert.equal(editors.getWorkspace().path, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace inspector lists files and skips heavy folders", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-inspect-"));
  fs.mkdirSync(path.join(tempDir, "src"));
  fs.mkdirSync(path.join(tempDir, "node_modules"));
  fs.writeFileSync(path.join(tempDir, "README.md"), "# Mana\n");
  fs.writeFileSync(path.join(tempDir, "src", "app.js"), "console.log('app');\n");
  fs.writeFileSync(path.join(tempDir, "node_modules", "ignored.js"), "ignored\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const inspector = createEditorWorkspaceInspector({ workspaceStore });

    const result = inspector.listFiles();

    assert.equal(result.workspacePath, tempDir);
    assert.deepEqual(
      result.files.map((file) => file.relativePath).sort(),
      ["README.md", "src/app.js"],
    );
    assert.equal(result.truncated, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace inspector reads bounded text files inside the workspace only", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-read-"));
  fs.mkdirSync(path.join(tempDir, "src"));
  fs.writeFileSync(path.join(tempDir, "src", "app.js"), "console.log('inside');\n");
  const outsideFile = path.join(os.tmpdir(), `mana-outside-${Date.now()}.js`);
  fs.writeFileSync(outsideFile, "console.log('outside');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const inspector = createEditorWorkspaceInspector({
      workspaceStore,
      maxReadBytes: 10,
    });

    const result = inspector.readFile("src/app.js");

    assert.equal(result.relativePath, "src/app.js");
    assert.equal(result.content, "console.lo");
    assert.equal(result.truncated, true);
    assert.throws(() => inspector.readFile(outsideFile), /inside the active workspace/i);
    assert.throws(() => inspector.readFile("../outside.js"), /inside the active workspace/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
});

test("editor integrations create safe edit proposals without writing files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-proposal-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore({
      now: () => new Date("2026-06-29T00:00:00.000Z"),
    });
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-1",
    });

    const proposal = editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update test value",
    });

    assert.equal(proposal.id, "proposal-1");
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.relativePath, "src.js");
    assert.equal(proposal.summary, "Update test value");
    assert.equal(proposal.originalContent, "const value = 1;\n");
    assert.equal(proposal.proposedContent, "const value = 2;\n");
    assert.match(proposal.diff, /-const value = 1;/);
    assert.match(proposal.diff, /\+const value = 2;/);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 1;\n");
    assert.deepEqual(editors.listEditProposals().map((item) => item.id), ["proposal-1"]);
    assert.equal(editors.getEditProposal("proposal-1").proposedContent, "const value = 2;\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("editor integrations approve a pending proposal and write the proposed content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-approve-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const timestamps = [
      new Date("2026-06-29T00:00:00.000Z"),
      new Date("2026-06-29T00:01:00.000Z"),
    ];
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-approve-1",
      now: () => timestamps.shift() || new Date("2026-06-29T00:02:00.000Z"),
    });

    editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update value",
    });

    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 1;\n");

    const applied = editors.approveEditProposal("proposal-approve-1");

    assert.equal(applied.id, "proposal-approve-1");
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedAt, "2026-06-29T00:01:00.000Z");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 2;\n");
    assert.equal(editors.getEditProposal("proposal-approve-1").status, "applied");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("editor integrations reject approval when the file changed after proposal creation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-conflict-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-conflict-1",
    });

    editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update value",
    });
    fs.writeFileSync(sourceFile, "const value = 3;\n");

    assert.throws(
      () => editors.approveEditProposal("proposal-conflict-1"),
      /content changed/i,
    );
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 3;\n");
    assert.equal(editors.getEditProposal("proposal-conflict-1").status, "pending");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("editor integrations reject approving the same proposal twice", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-approve-once-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-once-1",
    });

    editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update value",
    });
    editors.approveEditProposal("proposal-once-1");

    assert.throws(
      () => editors.approveEditProposal("proposal-once-1"),
      /not pending/i,
    );
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 2;\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("createApp exposes active editor workspace routes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-route-workspace-"));
  const sourceFile = path.join(tempDir, "route.js");
  fs.writeFileSync(sourceFile, "console.log('route workspace');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    const app = createApp({
      editors: createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
        spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
      }),
    });

    await withServer(app, async (baseUrl) => {
      const emptyResponse = await fetch(`${baseUrl}/editors/workspace`);
      const emptyBody = await emptyResponse.json();

      assert.equal(emptyResponse.status, 200);
      assert.equal(emptyBody.workspace, null);

      const setResponse = await fetch(`${baseUrl}/editors/workspace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourceFile, editor: "zed" }),
      });
      const setBody = await setResponse.json();

      assert.equal(setResponse.status, 200);
      assert.equal(setBody.workspace.path, tempDir);
      assert.equal(setBody.workspace.editor, "zed");

      const getResponse = await fetch(`${baseUrl}/editors/workspace`);
      const getBody = await getResponse.json();

      assert.equal(getResponse.status, 200);
      assert.equal(getBody.workspace.path, tempDir);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createApp exposes explicit read-only workspace inspection routes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-route-inspect-"));
  fs.mkdirSync(path.join(tempDir, "src"));
  fs.writeFileSync(path.join(tempDir, "README.md"), "# Mana route\n");
  fs.writeFileSync(path.join(tempDir, "src", "index.js"), "console.log('route');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const app = createApp({
      editors: createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
        spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
      }),
    });

    await withServer(app, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/editors/workspace/files`);
      const listBody = await listResponse.json();

      assert.equal(listResponse.status, 200);
      assert.deepEqual(
        listBody.files.map((file) => file.relativePath).sort(),
        ["README.md", "src/index.js"],
      );

      const readResponse = await fetch(
        `${baseUrl}/editors/workspace/file?path=${encodeURIComponent("src/index.js")}`,
      );
      const readBody = await readResponse.json();

      assert.equal(readResponse.status, 200);
      assert.equal(readBody.relativePath, "src/index.js");
      assert.equal(readBody.content, "console.log('route');\n");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createApp exposes safe edit proposal routes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-route-proposal-"));
  const sourceFile = path.join(tempDir, "app.js");
  fs.writeFileSync(sourceFile, "console.log('before');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const app = createApp({
      editors: createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
        idFactory: () => "proposal-route-1",
        spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
      }),
    });

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/editors/workspace/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "app.js",
          proposedContent: "console.log('after');\n",
          summary: "Change log text",
        }),
      });
      const createBody = await createResponse.json();

      assert.equal(createResponse.status, 200);
      assert.equal(createBody.proposal.id, "proposal-route-1");
      assert.equal(createBody.proposal.status, "pending");
      assert.match(createBody.proposal.diff, /-console\.log\('before'\);/);
      assert.match(createBody.proposal.diff, /\+console\.log\('after'\);/);
      assert.equal(fs.readFileSync(sourceFile, "utf8"), "console.log('before');\n");

      const listResponse = await fetch(`${baseUrl}/editors/workspace/proposals`);
      const listBody = await listResponse.json();

      assert.equal(listResponse.status, 200);
      assert.deepEqual(listBody.proposals.map((item) => item.id), ["proposal-route-1"]);

      const getResponse = await fetch(`${baseUrl}/editors/workspace/proposals/proposal-route-1`);
      const getBody = await getResponse.json();

      assert.equal(getResponse.status, 200);
      assert.equal(getBody.proposal.proposedContent, "console.log('after');\n");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createApp approves an edit proposal through the shared backend route", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-route-approve-"));
  const sourceFile = path.join(tempDir, "app.js");
  fs.writeFileSync(sourceFile, "console.log('before');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const timestamps = [
      new Date("2026-06-29T00:00:00.000Z"),
      new Date("2026-06-29T00:01:00.000Z"),
    ];
    const app = createApp({
      editors: createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
        idFactory: () => "proposal-route-approve-1",
        now: () => timestamps.shift() || new Date("2026-06-29T00:02:00.000Z"),
        spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
      }),
    });

    await withServer(app, async (baseUrl) => {
      await fetch(`${baseUrl}/editors/workspace/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "app.js",
          proposedContent: "console.log('after');\n",
          summary: "Change log text",
        }),
      });

      const approveResponse = await fetch(
        `${baseUrl}/editors/workspace/proposals/proposal-route-approve-1/approve`,
        { method: "POST" },
      );
      const approveBody = await approveResponse.json();

      assert.equal(approveResponse.status, 200);
      assert.equal(approveBody.proposal.id, "proposal-route-approve-1");
      assert.equal(approveBody.proposal.status, "applied");
      assert.equal(approveBody.proposal.appliedAt, "2026-06-29T00:01:00.000Z");
      assert.equal(fs.readFileSync(sourceFile, "utf8"), "console.log('after');\n");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createApp returns an error when approving a missing proposal", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-route-approve-missing-"));

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const app = createApp({
      editors: createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
        spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
      }),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/editors/workspace/proposals/missing-proposal/approve`,
        { method: "POST" },
      );
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.equal(body.proposal, null);
      assert.match(body.error, /edit proposal not found/i);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Issue #372 -- exercised through the real createEditProposal path rather
// than the proposal store directly, which is not exported.
function withTruncationWorkspace(originalContent, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-trunc-"));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src", "app.js"), originalContent);
  try {
    const workspaceStore = createEditorWorkspaceStore({
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    run(
      createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
      }),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("a proposal that erases a non-empty file is rejected (issue #372)", () => {
  withTruncationWorkspace("line one\nline two\nline three\n", (editors) => {
    assert.throws(
      () => editors.createEditProposal({ path: "src/app.js", proposedContent: "" }),
      /would erase a non-empty file/,
    );
  });
});

test("a proposal that collapses to a fraction of the original is rejected (issue #372)", () => {
  // What a model hitting its output token limit partway through produces: a
  // perfectly valid string that simply stops early.
  withTruncationWorkspace("x".repeat(1000), (editors) => {
    assert.throws(
      () => editors.createEditProposal({ path: "src/app.js", proposedContent: "x".repeat(100) }),
      /looks truncated rather than edited/,
    );
  });
});

test("allowShrink permits a deliberate large deletion (issue #372)", () => {
  withTruncationWorkspace("x".repeat(1000), (editors) => {
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "x".repeat(10),
      allowShrink: true,
    });
    assert.equal(proposal.status, "pending");
  });
});

test("an ordinary edit is unaffected by the truncation check (issue #372)", () => {
  withTruncationWorkspace("const a = 1;\nconst b = 2;\n", (editors) => {
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 1;\nconst b = 3;\n",
    });
    assert.equal(proposal.status, "pending");
  });
});

test("a proposal against an empty original is not treated as truncation (issue #372)", () => {
  withTruncationWorkspace("", (editors) => {
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const created = true;\n",
    });
    assert.equal(proposal.status, "pending");
  });
});

test("the truncation threshold is configurable (issue #372)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-trunc-cfg-"));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src", "app.js"), "x".repeat(1000));
  try {
    const workspaceStore = createEditorWorkspaceStore({
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const strict = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      minRetainedRatio: 0.95,
    });

    // A shrink the default 0.5 would have allowed through.
    assert.throws(
      () => strict.createEditProposal({ path: "src/app.js", proposedContent: "x".repeat(900) }),
      /looks truncated/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Issue #349 -- a real git repo in a temp dir, so the commit path is
// exercised rather than mocked.
function withGitWorkspace(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-git-"));
  const git = (args) =>
    require("node:child_process").spawnSync("git", args, {
      cwd: tempDir,
      encoding: "utf8",
      shell: false,
    });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "user.name", "Mana Test"]);
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src", "app.js"), "const a = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  try {
    const workspaceStore = createEditorWorkspaceStore({
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    run({ tempDir, git, workspaceStore });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("approving with commit enabled lands the edit as its own commit (issue #349)", () => {
  withGitWorkspace(({ git, workspaceStore }) => {
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (c) => c,
      workspaceStore,
      commitOnApprove: true,
    });
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 2;\n",
      summary: "Bump the value",
    });
    const applied = editors.approveEditProposal(proposal.id);

    assert.equal(applied.git.committed, true);
    assert.match(git(["log", "-1", "--pretty=%s"]).stdout, /Bump the value/);
  });
});

test("commit is off unless asked for (issue #349)", () => {
  withGitWorkspace(({ git, workspaceStore }) => {
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (c) => c,
      workspaceStore,
    });
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 3;\n",
    });
    const applied = editors.approveEditProposal(proposal.id);

    assert.equal(applied.git, undefined);
    assert.match(git(["log", "-1", "--pretty=%s"]).stdout, /initial/);
  });
});

test("an unrelated in-progress change is not swept into the commit (issue #349)", () => {
  withGitWorkspace(({ tempDir, git, workspaceStore }) => {
    // The user is midway through editing something else entirely.
    fs.writeFileSync(path.join(tempDir, "src", "other.js"), "const untouched = true;\n");
    git(["add", "-A"]);

    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (c) => c,
      workspaceStore,
      commitOnApprove: true,
    });
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 4;\n",
      summary: "Only this file",
    });
    editors.approveEditProposal(proposal.id);

    const files = git(["show", "--name-only", "--pretty=format:", "HEAD"]).stdout;
    assert.match(files, /src\/app\.js/);
    assert.doesNotMatch(files, /other\.js/);
  });
});

test("a commit failure does not undo the applied edit (issue #349)", () => {
  withGitWorkspace(({ tempDir, workspaceStore }) => {
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (c) => c,
      workspaceStore,
      commitOnApprove: true,
      // Every git call fails.
      runGit: () => ({ status: 1, stderr: "git exploded", stdout: "" }),
    });
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 5;\n",
    });
    const applied = editors.approveEditProposal(proposal.id);

    assert.equal(applied.git.committed, false);
    assert.equal(applied.status, "applied");
    // The write already succeeded; reverting real work to keep git tidy
    // would be the destructive choice.
    assert.equal(fs.readFileSync(path.join(tempDir, "src", "app.js"), "utf8"), "const a = 5;\n");
  });
});

test("a non-git workspace reports why rather than failing the edit (issue #349)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-nogit-"));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src", "app.js"), "const a = 1;\n");
  try {
    const workspaceStore = createEditorWorkspaceStore({
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (c) => c,
      workspaceStore,
      commitOnApprove: true,
    });
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 6;\n",
    });
    const applied = editors.approveEditProposal(proposal.id);

    assert.equal(applied.git.committed, false);
    assert.match(applied.git.reason, /not a git repository/);
    assert.equal(applied.status, "applied");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an already-applied edit is a no-op success, not a conflict (issue #387)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-idem-"));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "src", "app.js"), "const a = 1;\n");
  try {
    const workspaceStore = createEditorWorkspaceStore({
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (c) => c,
      workspaceStore,
    });
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 2;\n",
    });

    // Something else lands exactly the proposed content first.
    fs.writeFileSync(path.join(tempDir, "src", "app.js"), "const a = 2;\n");

    const applied = editors.approveEditProposal(proposal.id);
    assert.equal(applied.alreadyApplied, true);
    assert.equal(applied.status, "applied");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a write that does not land is reported, not marked applied (issue #387)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-zed-verify-"));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  const filePath = path.join(tempDir, "src", "app.js");
  fs.writeFileSync(filePath, "const a = 1;\n");
  const realWriteFileSync = fs.writeFileSync;
  try {
    const workspaceStore = createEditorWorkspaceStore({
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (c) => c,
      workspaceStore,
    });
    const proposal = editors.createEditProposal({
      path: "src/app.js",
      proposedContent: "const a = 2;\nconst b = 3;\n",
    });

    // A write that silently lands only part of the content -- a full disk,
    // or something transforming the bytes on the way through.
    fs.writeFileSync = (p, data, enc) =>
      realWriteFileSync(p, String(data).slice(0, 8), enc);

    assert.throws(
      () => editors.approveEditProposal(proposal.id),
      /does not match the approved content/,
    );
    // Still pending: a proposal whose content never landed must not read as applied.
    assert.equal(editors.getEditProposal(proposal.id).status, "pending");
  } finally {
    fs.writeFileSync = realWriteFileSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
