const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_INSPECTOR_EXCLUDES = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
]);

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

function toWorkspaceRelativePath(workspacePath, targetPath) {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedTarget = path.resolve(resolvedWorkspace, String(targetPath || ""));
  const relativePath = path.relative(resolvedWorkspace, resolvedTarget);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("file path must be inside the active workspace");
  }
  return {
    fullPath: resolvedTarget,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

function requireActiveWorkspace(workspaceStore) {
  const workspace = workspaceStore.getWorkspace();
  if (!workspace?.path) {
    throw new Error("active workspace is not set");
  }
  if (!fs.existsSync(workspace.path)) {
    throw new Error("active workspace path does not exist");
  }
  return workspace;
}

function createEditorWorkspaceInspector(options = {}) {
  const workspaceStore = options.workspaceStore;
  if (!workspaceStore) {
    throw new Error("workspaceStore is required");
  }
  const maxFiles = Math.max(1, Number(options.maxFiles || 200));
  const maxReadBytes = Math.max(1, Number(options.maxReadBytes || 64 * 1024));
  const excludes = new Set([
    ...DEFAULT_INSPECTOR_EXCLUDES,
    ...(Array.isArray(options.excludes) ? options.excludes : []),
  ]);

  function listFiles() {
    const workspace = requireActiveWorkspace(workspaceStore);
    const workspacePath = path.resolve(workspace.path);
    const files = [];
    let truncated = false;

    function walk(dirPath) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );

      for (const entry of entries) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        if (excludes.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        const relativePath = path
          .relative(workspacePath, fullPath)
          .split(path.sep)
          .join("/");
        files.push({
          relativePath,
          sizeBytes: fs.statSync(fullPath).size,
        });
      }
    }

    walk(workspacePath);
    return {
      workspacePath,
      files,
      truncated,
    };
  }

  function readFile(relativeFilePath) {
    const workspace = requireActiveWorkspace(workspaceStore);
    const workspacePath = path.resolve(workspace.path);
    const target = toWorkspaceRelativePath(workspacePath, relativeFilePath);
    if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
      throw new Error("workspace file does not exist");
    }

    const buffer = fs.readFileSync(target.fullPath);
    const truncated = buffer.length > maxReadBytes;
    return {
      workspacePath,
      relativePath: target.relativePath,
      content: buffer.subarray(0, maxReadBytes).toString("utf8"),
      truncated,
      sizeBytes: buffer.length,
    };
  }

  return {
    listFiles,
    readFile,
  };
}

function createSimpleLineDiff({ relativePath, originalContent, proposedContent }) {
  const originalLines = String(originalContent || "").split(/\r?\n/);
  const proposedLines = String(proposedContent || "").split(/\r?\n/);
  const lines = [`--- ${relativePath}`, `+++ ${relativePath}`];
  const maxLines = Math.max(originalLines.length, proposedLines.length);

  for (let index = 0; index < maxLines; index += 1) {
    const originalLine = originalLines[index];
    const proposedLine = proposedLines[index];
    if (originalLine === proposedLine) {
      if (originalLine !== undefined && originalLine !== "") {
        lines.push(` ${originalLine}`);
      }
      continue;
    }
    if (originalLine !== undefined && originalLine !== "") {
      lines.push(`-${originalLine}`);
    }
    if (proposedLine !== undefined && proposedLine !== "") {
      lines.push(`+${proposedLine}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function createEditProposalStore(options = {}) {
  const now = options.now || (() => new Date());
  const idFactory =
    options.idFactory ||
    (() => `proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const proposals = new Map();

  function createProposal({
    relativePath,
    originalContent,
    proposedContent,
    summary = "",
  } = {}) {
    if (typeof proposedContent !== "string") {
      throw new Error("proposedContent is required");
    }

    const proposal = {
      id: idFactory(),
      status: "pending",
      relativePath,
      summary: String(summary || "").trim(),
      originalContent,
      proposedContent,
      diff: createSimpleLineDiff({
        relativePath,
        originalContent,
        proposedContent,
      }),
      createdAt: now().toISOString(),
    };
    proposals.set(proposal.id, proposal);
    return proposal;
  }

  function listProposals() {
    return [...proposals.values()].map((proposal) => ({
      id: proposal.id,
      status: proposal.status,
      relativePath: proposal.relativePath,
      summary: proposal.summary,
      createdAt: proposal.createdAt,
    }));
  }

  function getProposal(id) {
    const proposal = proposals.get(String(id || ""));
    if (!proposal) {
      throw new Error("edit proposal not found");
    }
    return proposal;
  }

  return {
    createProposal,
    getProposal,
    listProposals,
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
  const workspaceInspector =
    options.workspaceInspector ||
    createEditorWorkspaceInspector({
      workspaceStore,
      maxFiles: options.maxWorkspaceFiles,
      maxReadBytes: options.maxWorkspaceReadBytes,
    });
  const proposalStore =
    options.proposalStore ||
    createEditProposalStore({
      idFactory: options.idFactory,
      now: options.now,
    });
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

  function listWorkspaceFiles() {
    return workspaceInspector.listFiles();
  }

  function readWorkspaceFile(relativeFilePath) {
    return workspaceInspector.readFile(relativeFilePath);
  }

  function createEditProposal({ path: proposalPath, proposedContent, summary } = {}) {
    const original = workspaceInspector.readFile(proposalPath);
    return proposalStore.createProposal({
      relativePath: original.relativePath,
      originalContent: original.content,
      proposedContent,
      summary,
    });
  }

  function listEditProposals() {
    return proposalStore.listProposals();
  }

  function getEditProposal(id) {
    return proposalStore.getProposal(id);
  }

  return {
    createEditProposal,
    getEditProposal,
    getWorkspace,
    getStatus,
    listWorkspaceFiles,
    listEditProposals,
    open,
    readWorkspaceFile,
    setWorkspace,
  };
}

module.exports = {
  buildZedOpenTarget,
  createEditorIntegrations,
  createEditorWorkspaceInspector,
  createEditorWorkspaceStore,
  createZedIntegration,
  defaultCommandResolver,
};
