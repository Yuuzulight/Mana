const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function defaultCommandResolver(command) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });

  if (result.status !== 0) {
    return null;
  }

  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || null;
}

function normalizePositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return number;
}

function buildEditorOpenTarget({ targetPath, line, column } = {}) {
  const cleanPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!cleanPath) {
    throw new Error("path is required");
  }

  if (!fs.existsSync(cleanPath)) {
    throw new Error("path does not exist");
  }

  const normalizedLine = normalizePositiveInteger(line, "line");
  const normalizedColumn = normalizePositiveInteger(column, "column");
  if (!normalizedLine) {
    return cleanPath;
  }

  return normalizedColumn
    ? `${cleanPath}:${normalizedLine}:${normalizedColumn}`
    : `${cleanPath}:${normalizedLine}`;
}

function buildZedOpenTarget(options = {}) {
  return buildEditorOpenTarget(options);
}

function buildVsCodeOpenArgs(options = {}) {
  const target = buildEditorOpenTarget(options);
  const hasLine = options.line !== undefined && options.line !== null && options.line !== "";
  return hasLine ? ["-g", target] : [target];
}

function quoteWindowsCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildSpawnInvocation(command, args, platform = process.platform) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(" "),
    ],
  };
}

function normalizeWorkspacePath(targetPath) {
  const cleanPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!cleanPath) {
    throw new Error("workspace path is required");
  }
  if (!fs.existsSync(cleanPath)) {
    throw new Error("workspace path does not exist");
  }

  const stats = fs.statSync(cleanPath);
  return stats.isDirectory() ? cleanPath : path.dirname(cleanPath);
}

function createEditorWorkspaceStore(options = {}) {
  const now = options.now || (() => new Date());
  let workspace = null;

  function setWorkspace(targetPath, metadata = {}) {
    const workspacePath = normalizeWorkspacePath(targetPath);
    workspace = {
      path: workspacePath,
      editor: metadata.editor || null,
      reason: metadata.reason || "manual",
      updatedAt: now().toISOString(),
    };
    return workspace;
  }

  function getWorkspace() {
    return workspace;
  }

  return {
    getWorkspace,
    setWorkspace,
  };
}

function createEditorIntegration(config, options = {}) {
  const env = options.env || process.env;
  const commandResolver = options.commandResolver || defaultCommandResolver;
  const spawnProcess = options.spawn || spawn;
  const platform = options.platform || process.platform;
  const configuredEnvValue =
    typeof env[config.envVar] === "string" ? env[config.envVar].trim() : "";

  function getStatus() {
    if (configuredEnvValue) {
      if (fs.existsSync(configuredEnvValue)) {
        return {
          available: true,
          command: configuredEnvValue,
          source: config.envVar,
          message: `${config.label} CLI is configured.`,
        };
      }

      return {
        available: false,
        command: configuredEnvValue,
        source: config.envVar,
        message: `${config.envVar} is configured, but the file does not exist.`,
      };
    }

    const pathCommand = commandResolver(config.pathCommand);
    if (pathCommand) {
      return {
        available: true,
        command: pathCommand,
        source: "PATH",
        message: `${config.label} CLI is available on PATH.`,
      };
    }

    return {
      available: false,
      command: null,
      source: "none",
      message: `${config.label} CLI was not found. Add ${config.pathCommand} to PATH or set ${config.envVar}.`,
    };
  }

  function open({ targetPath, line, column } = {}) {
    const status = getStatus();
    if (!status.available) {
      return Promise.reject(new Error(status.message));
    }

    const args = config.buildArgs({ targetPath, line, column });
    const invocation = buildSpawnInvocation(status.command, args, platform);
    return new Promise((resolve, reject) => {
      const child = spawnProcess(invocation.command, invocation.args, {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });

      child.once("error", reject);
      child.once("spawn", () => {
        if (typeof child.unref === "function") {
          child.unref();
        }
        resolve({
          opened: true,
          editor: config.id,
          command: status.command,
          args,
          target: args[args.length - 1],
        });
      });
    });
  }

  return {
    getStatus,
    open,
  };
}

const EDITOR_CONFIGS = {
  zed: {
    id: "zed",
    label: "Zed",
    envVar: "ZED_BIN",
    pathCommand: "zed",
    buildArgs: (options) => [buildEditorOpenTarget(options)],
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    envVar: "VSCODE_BIN",
    pathCommand: "code",
    buildArgs: buildVsCodeOpenArgs,
  },
};

function normalizeEditorId(editor, defaultEditor = "zed") {
  const normalized = String(editor || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EDITOR_CONFIGS, normalized)) {
    return normalized;
  }
  return defaultEditor;
}

function createZedIntegration(options = {}) {
  return createEditorIntegration(EDITOR_CONFIGS.zed, options);
}

function createEditorIntegrations(options = {}) {
  const env = options.env || process.env;
  const defaultEditor = normalizeEditorId(env.MANA_DEFAULT_EDITOR, "zed");
  const workspaceStore = options.workspaceStore || createEditorWorkspaceStore();
  const editors = Object.fromEntries(
    Object.entries(EDITOR_CONFIGS).map(([id, config]) => [
      id,
      createEditorIntegration(config, options),
    ]),
  );

  function getStatus() {
    return {
      defaultEditor,
      editors: Object.fromEntries(
        Object.entries(editors).map(([id, integration]) => [
          id,
          integration.getStatus(),
        ]),
      ),
    };
  }

  function open({ editor, targetPath, line, column } = {}) {
    const editorId = normalizeEditorId(editor, defaultEditor);
    return editors[editorId].open({ targetPath, line, column }).then((result) => ({
      ...result,
      workspace: workspaceStore.setWorkspace(targetPath, {
        editor: editorId,
        reason: "open",
      }),
    }));
  }

  function getWorkspace() {
    return workspaceStore.getWorkspace();
  }

  function setWorkspace(targetPath, metadata = {}) {
    return workspaceStore.setWorkspace(targetPath, {
      editor: normalizeEditorId(metadata.editor, defaultEditor),
      reason: metadata.reason || "manual",
    });
  }

  return {
    getWorkspace,
    getStatus,
    open,
    setWorkspace,
  };
}

module.exports = {
  buildZedOpenTarget,
  createEditorIntegrations,
  createEditorWorkspaceStore,
  createZedIntegration,
  defaultCommandResolver,
};
