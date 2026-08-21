const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const esprima = require("esprima");
const { createEditSnapshotStore } = require("./edit-snapshot-store");

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
  const str = String(value);
  // cmd.exe has no escape sequence for a literal " inside a /c "..."
  // command line -- backslash means nothing to its tokenizer, so \" just
  // closes the quote early and lets whatever follows (e.g. "& calc.exe")
  // parse as a new command. Windows forbids " in real file paths anyway,
  // so refusing it here costs nothing legitimate while closing that gap.
  if (str.includes('"')) {
    throw new Error("argument cannot contain a double quote");
  }
  return `"${str}"`;
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

// Intentionally accepts any local path -- "pick which folder Mana's editor
// integration points at" is the feature, so there's no narrower path to
// sanitize down to. The HTTP routes that reach this (server.js's
// /editors/workspace, /editors/open, /zed/open) are gated behind
// checkAdminAuth precisely because this has no path containment of its own.
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

// Issue #372: the type check on proposedContent cannot tell a complete file
// from a truncated one. A model that runs out of output tokens partway
// through returns a perfectly valid string that happens to stop early, and
// approving it writes that over the real file. The generated diff renders
// the loss honestly as a large deletion, but on a big change that is easy
// to read past -- and the bigger the file, the likelier the truncation and
// the worse the loss.
//
// These catch a cliff, not real deletions: a deliberate large cut is still
// possible via allowShrink. Deliberately no syntax parsing -- balanced
// brackets would be a stronger tell but only for known languages, and the
// two checks here need nothing but lengths.
const DEFAULT_MIN_RETAINED_RATIO = 0.5;

// Issue #420: blocking, not advisory. A proposal that cannot even parse
// is not a valid edit, and applying it would hand the workspace a broken
// file. JS uses esprima (already a dependency, used the same way by
// utils/reply-verifier.js) -- a pure AST parser with no code-execution
// capability at all, unlike node:vm's Script constructor (which this
// originally used): parsing untrusted text with an actual JS engine is a
// legitimate static-analysis red flag even when nothing ever calls
// .runInThisContext() on the result, since it's the same API real code
// execution goes through. esprima can't execute anything, at any call
// depth, so the concern doesn't apply -- not just quieter about it, an
// actually different code path. JSON via JSON.parse is the same kind of
// non-executing, in-process check. Python shells out to the system
// interpreter since there's no in-process parser available here -- this
// is a rare, human/model-triggered action (one proposal at a time), not
// a hot polling loop, so a blocking spawnSync is fine here, unlike a
// repeatedly-polled endpoint. Any other extension (C#, TS, etc.) is
// unchecked -- pass, not blocked -- matching skills-store.js's
// verifySkillScript's own "can't classify it, don't hold it against the
// proposal" behavior rather than trying to build a parser for every
// language a workspace might contain.
function verifyProposalSyntax({ relativePath, proposedContent }) {
  const ext = path.extname(String(relativePath || "")).toLowerCase();

  if (ext === ".js" || ext === ".cjs") {
    // .mjs is deliberately excluded: esprima.parseScript parses "script"
    // goal, not "module" goal, so it throws on plain import/export --
    // which is virtually every real .mjs file. Checking it would reject
    // valid ESM edits as broken, the exact failure mode this feature must
    // avoid.
    try {
      esprima.parseScript(proposedContent);
      return { ok: true, checked: true };
    } catch (e) {
      return { ok: false, checked: true, error: e.message || String(e) };
    }
  }

  if (ext === ".json") {
    try {
      JSON.parse(proposedContent);
      return { ok: true, checked: true };
    } catch (e) {
      return { ok: false, checked: true, error: e.message || String(e) };
    }
  }

  if (ext === ".py") {
    const result = spawnSync(
      "python",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
      { input: proposedContent, encoding: "utf8", windowsHide: true },
    );
    if (result.error || result.status === null || result.status === 9009) {
      // No python on PATH -- unchecked, not blocked, same as any other
      // unrecognized extension. Status 9009 also covers Windows' "app
      // execution alias" stub (present by default even with no Python
      // installed): it launches successfully, so result.error is unset,
      // but exits 9009 instead of running any code.
      return { ok: true, checked: false };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        checked: true,
        error: (result.stderr || "").trim() || "python syntax check failed",
      };
    }
    return { ok: true, checked: true };
  }

  return { ok: true, checked: false };
}

function assertNotTruncated({
  originalContent,
  proposedContent,
  allowShrink,
  minRetainedRatio,
}) {
  if (allowShrink) return;
  // No original to compare against (a new file) means nothing to lose.
  if (typeof originalContent !== "string" || !originalContent.length) return;

  if (!proposedContent.length) {
    throw new Error(
      "edit proposal rejected: empty content would erase a non-empty file (pass allowShrink to override)",
    );
  }

  const retained = proposedContent.length / originalContent.length;
  if (retained < minRetainedRatio) {
    const percent = Math.round(retained * 100);
    throw new Error(
      `edit proposal rejected: content is ${percent}% of the original, which looks truncated rather than edited (pass allowShrink to override)`,
    );
  }
}

// Issue #349: git sits *underneath* the proposal flow, not in place of it.
// Review-before-apply is unchanged, and a commit only happens once the user
// has already accepted -- so unreviewed work never enters history, which is
// the failure mode of the "commit first, revert to undo" alternative. What
// it adds is durability (an in-memory proposal dies with the process; a
// commit does not) and a real record of what Mana changed.
//
// Three hard constraints:
//   - Only the accepted file is committed. A bare `git add -A` would sweep
//     whatever the user had in progress into a commit describing Mana's
//     edit. The pathspec on commit keeps it scoped even when other things
//     are already staged.
//   - Never pushes. Nothing here talks to a remote.
//   - A failed commit never undoes the applied edit. The write already
//     succeeded, and reverting real work to keep git tidy would be the
//     destructive choice.
function buildEditCommitMessage({ relativePath, summary }) {
  const subject = String(summary || "")
    .trim()
    .split(/\r?\n/)[0]
    .slice(0, 72);
  const head = subject || `Update ${relativePath}`;
  return `${head}\n\nApproved Mana edit to ${relativePath}.`;
}

function commitAppliedEdit({ workspacePath, relativePath, summary, runGit } = {}) {
  const git =
    runGit ||
    ((args) =>
      spawnSync("git", args, {
        cwd: workspacePath,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      }));

  const inRepo = git(["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo || inRepo.status !== 0) {
    return { committed: false, reason: "workspace is not a git repository" };
  }

  // Needed before the commit below only so a previously-untracked file has
  // something for the pathspec to match.
  const staged = git(["add", "--", relativePath]);
  if (staged.status !== 0) {
    return {
      committed: false,
      reason: `git add failed: ${String(staged.stderr || "").trim()}`,
    };
  }

  const message = buildEditCommitMessage({ relativePath, summary });
  const result = git(["commit", "-m", message, "--", relativePath]);
  if (result.status !== 0) {
    return {
      committed: false,
      reason: `git commit failed: ${String(result.stderr || result.stdout || "").trim()}`,
    };
  }

  return { committed: true, message };
}

function createEditProposalStore(options = {}) {
  const now = options.now || (() => new Date());
  // Generous by default -- the aim is catching a cliff, not policing edits.
  const minRetainedRatio = Number.isFinite(options.minRetainedRatio)
    ? options.minRetainedRatio
    : DEFAULT_MIN_RETAINED_RATIO;
  const idFactory =
    options.idFactory ||
    (() => `proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const proposals = new Map();

  function createProposal({
    relativePath,
    originalContent,
    proposedContent,
    summary = "",
    allowShrink = false,
  } = {}) {
    if (typeof proposedContent !== "string") {
      throw new Error("proposedContent is required");
    }
    assertNotTruncated({ originalContent, proposedContent, allowShrink, minRetainedRatio });

    const verified = verifyProposalSyntax({ relativePath, proposedContent });
    if (!verified.ok) {
      throw new Error(`edit proposal rejected: ${relativePath} does not parse: ${verified.error}`);
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

  function markApplied(id) {
    const proposal = getProposal(id);
    if (proposal.status !== "pending") {
      throw new Error("edit proposal is not pending");
    }

    proposal.status = "applied";
    proposal.appliedAt = now().toISOString();
    return proposal;
  }

  return {
    createProposal,
    getProposal,
    listProposals,
    markApplied,
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
  // Issue #349: off unless asked for. Committing into a user's repository is
  // not something to start doing by default.
  const commitOnApprove = Boolean(options.commitOnApprove);
  const runGit = options.runGit;
  const proposalStore =
    options.proposalStore ||
    createEditProposalStore({
      idFactory: options.idFactory,
      now: options.now,
      minRetainedRatio: options.minRetainedRatio,
    });
  // Issue #428: restorable snapshots of applied edits, independent of git.
  const snapshotStore =
    options.snapshotStore ||
    createEditSnapshotStore({
      dataDir: options.snapshotsDir,
      now: options.now,
      idFactory: options.snapshotIdFactory,
      maxRetained: options.maxRetainedSnapshots,
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

  function createEditProposal({
    path: proposalPath,
    proposedContent,
    summary,
    allowShrink,
  } = {}) {
    const original = workspaceInspector.readFile(proposalPath);
    return proposalStore.createProposal({
      relativePath: original.relativePath,
      originalContent: original.content,
      proposedContent,
      summary,
      allowShrink,
    });
  }

  function listEditProposals() {
    return proposalStore.listProposals();
  }

  function getEditProposal(id) {
    return proposalStore.getProposal(id);
  }

  function approveEditProposal(id, { commit } = {}) {
    const workspace = requireActiveWorkspace(workspaceStore);
    const proposal = proposalStore.getProposal(id);
    if (proposal.status !== "pending") {
      throw new Error("edit proposal is not pending");
    }

    const target = toWorkspaceRelativePath(workspace.path, proposal.relativePath);
    if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
      throw new Error("workspace file does not exist");
    }

    const currentContent = fs.readFileSync(target.fullPath, "utf8");
    // Issue #387: the file already holding exactly what was proposed is not
    // a conflict -- it is the edit, already applied. Reporting that as a
    // failure describes a correct outcome as a broken one, and invites the
    // caller to "fix" a file that is right.
    if (currentContent === proposal.proposedContent) {
      return { ...proposalStore.markApplied(id), alreadyApplied: true };
    }
    if (currentContent !== proposal.originalContent) {
      throw new Error("edit proposal conflict: current file content changed");
    }

    // Issue #428: snapshot before the write, not after -- proposal.originalContent
    // is the last point this content exists anywhere once the write below
    // lands. Only real writes reach here (the alreadyApplied early return
    // above skips this), so nothing gets snapshotted for a no-op approve.
    const snapshot = snapshotStore.recordSnapshot({
      proposalId: id,
      workspacePath: path.resolve(workspace.path),
      relativePath: target.relativePath,
      originalContent: currentContent,
      summary: proposal.summary,
    });

    fs.writeFileSync(target.fullPath, proposal.proposedContent, "utf8");

    // Issue #387: read back before claiming success. writeFileSync throwing
    // is handled by the caller; the uncovered cases are the quiet ones --
    // a partial write on a full or failing disk, an encoding or
    // line-ending transformation somewhere in the path (a live concern on
    // Windows, not a hypothetical), or a watcher racing the write. In each
    // the proposal would be recorded as applied while the file says
    // otherwise, which is worse than a visible failure.
    const writtenContent = fs.readFileSync(target.fullPath, "utf8");
    if (writtenContent !== proposal.proposedContent) {
      throw new Error(
        "edit proposal failed verification: file on disk does not match the approved content",
      );
    }

    const applied = { ...proposalStore.markApplied(id), snapshotId: snapshot.id };

    // Issue #349: opt-in, and never allowed to fail the edit. The file is
    // already written by this point -- a commit problem is reported, not
    // raised, because throwing here would misrepresent an applied edit as a
    // failed one and tempt a caller into "cleaning up" real work.
    const shouldCommit = commit === undefined ? commitOnApprove : Boolean(commit);
    if (!shouldCommit) return applied;

    const git = commitAppliedEdit({
      workspacePath: workspace.path,
      relativePath: target.relativePath,
      summary: proposal.summary,
      runGit,
    });
    return { ...applied, git };
  }

  // Issue #428: metadata only (path/summary/timestamp) -- restoreEditSnapshot
  // is what actually reads a snapshot's saved content back. Scoped to the
  // active workspace -- a snapshot's relativePath is only meaningful
  // relative to the workspace it was recorded in, so listing (and
  // restoring) across a workspace switch would silently target the wrong
  // file on disk.
  function listEditSnapshots() {
    const workspace = workspaceStore.getWorkspace();
    if (!workspace?.path) {
      return [];
    }
    const workspacePath = path.resolve(workspace.path);
    return snapshotStore
      .listSnapshots()
      .filter((record) => record.workspacePath === workspacePath);
  }

  // Deliberately no conflict check against the file's current content --
  // unlike approveEditProposal, which knows exactly what content it expects
  // to find (the proposal it's applying), a snapshot only knows what the
  // file looked like before ITS edit, not what may have changed since. This
  // is a simple, git-independent undo convenience, not a merge system;
  // the UI confirming with the user before restoring is the real safety
  // net here, the same way file_write's approval gate is the safety net
  // for autonomous-loop writes rather than code-level conflict detection.
  function restoreEditSnapshot(id) {
    const record = snapshotStore.getSnapshot(id);
    if (!record) {
      throw new Error("edit snapshot not found");
    }

    const workspace = requireActiveWorkspace(workspaceStore);
    if (record.workspacePath !== path.resolve(workspace.path)) {
      throw new Error("edit snapshot belongs to a different workspace");
    }
    const target = toWorkspaceRelativePath(workspace.path, record.relativePath);
    if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
      throw new Error("workspace file does not exist");
    }

    fs.writeFileSync(target.fullPath, record.originalContent, "utf8");

    // Issue #387's same read-back-before-claiming-success discipline.
    const writtenContent = fs.readFileSync(target.fullPath, "utf8");
    if (writtenContent !== record.originalContent) {
      throw new Error(
        "edit snapshot restore failed verification: file on disk does not match the restored content",
      );
    }

    snapshotStore.deleteSnapshot(id);
    return {
      id,
      relativePath: record.relativePath,
      restoredAt: new Date().toISOString(),
    };
  }

  return {
    approveEditProposal,
    listEditSnapshots,
    restoreEditSnapshot,
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
