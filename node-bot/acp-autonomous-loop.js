const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { safeJsonParse } = require("./utils/json-extract");
const { scanDir } = require("./tools/dir_scanner");
const { createAcpTestRunner } = require("./acp-test-runner");
const { createSnapshotStore } = require("./snapshot-store");
const { previewRestore } = require("./ai/snapshot-tool-source");
const {
  createScratchWorkspaceCopy,
  removeScratchWorkspaceCopy,
} = require("./workspace-scratch-copy");

const RETRIEVER_URL = process.env.RETRIEVER_URL || "http://127.0.0.1:9000";
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(__dirname, "..");
const MAX_FILE_READ_BYTES = Number(
  process.env.MAX_FILE_READ_BYTES || 200 * 1024,
); // 200 KB

// Windows drive-letter ("C:\" / "C:/") or UNC ("\\server\share") syntax.
// path.isAbsolute() only recognizes the *host OS's own* absolute-path
// syntax -- on a POSIX host it doesn't know a drive letter is absolute, so
// a model-supplied path like "C:\Windows\system.ini" was silently treated
// as a relative path segment and joined onto REPO_ROOT instead of being
// rejected as foreign/absolute. These tool-call paths come from untrusted
// model output, so the guard needs to reject foreign-absolute syntax
// regardless of which OS actually runs it, not just the host's own.
const WIN_DRIVE_OR_UNC_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

// Resolves a model-supplied path against REPO_ROOT and confirms it stays
// inside it, returning the resolved absolute path or null if the request
// should be rejected. Shared by file_read/file_write/dir_scan so the guard
// only needs fixing in one place.
function resolveWithinRepo(requestedPath) {
  if (
    WIN_DRIVE_OR_UNC_RE.test(requestedPath) &&
    !path.isAbsolute(requestedPath)
  ) {
    return null;
  }
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(REPO_ROOT, requestedPath);
  const rel = path.relative(REPO_ROOT, resolvedPath);
  // On Windows, path.relative() between paths on different drives (or a
  // drive vs. a UNC root) can't express the difference as a relative path,
  // so it returns the "to" path back out unchanged -- which does NOT start
  // with "..". That let paths like "C:\Windows\system.ini" slip past the
  // ".." check above when REPO_ROOT is on a different drive/root. Any rel
  // that is still absolute means resolvedPath never actually descended from
  // REPO_ROOT, so treat that as outside the repo too.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolvedPath;
}

// File-write approval settings
function getApprovalConfig() {
  const requireApproval =
    (process.env.FILE_WRITE_REQUIRE_APPROVAL || "1") !== "0";
  const approvalDir =
    process.env.MANA_PENDING_WRITES_DIR ||
    path.join(__dirname, "data", "pending_writes");
  const approvalTimeoutMs = Number(
    process.env.FILE_WRITE_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000,
  );
  return { requireApproval, approvalDir, approvalTimeoutMs };
}

async function ensureApprovalDir() {
  try {
    const { approvalDir } = getApprovalConfig();
    await fs.promises.mkdir(approvalDir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

async function createPendingRequest(id, payload) {
  await ensureApprovalDir();
  const { approvalDir } = getApprovalConfig();
  const filePath = path.join(approvalDir, `${id}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
  });
  return filePath;
}

// Shared by every approval-gated tool case in this file (file_write,
// snapshot_restore) -- previously file_write called a makeApprovalId()
// that was referenced but never defined anywhere in the codebase (a
// ReferenceError that only fired the first time FILE_WRITE_REQUIRE_APPROVAL
// was actually enabled, since every existing test disabled it). Fixed here
// rather than left as a separate follow-up, since the fix is smaller than
// the workaround (a second, parallel id generator) would have been.
function makeApprovalId(prefix) {
  const hex = crypto.randomBytes(4).toString("hex");
  return prefix ? `${prefix}-${hex}` : hex;
}

function approvalPaths(id) {
  const { approvalDir } = getApprovalConfig();
  const base = path.join(approvalDir, id);
  return {
    pending: `${base}.json`,
    approved: `${base}.approved.json`,
    rejected: `${base}.rejected.json`,
  };
}

async function waitForApprovalResult(id, timeoutMs) {
  const { approvalTimeoutMs } = getApprovalConfig();
  const paths = approvalPaths(id);
  const start = Date.now();
  const maxWait = typeof timeoutMs === "number" ? timeoutMs : approvalTimeoutMs;
  while (Date.now() - start < maxWait) {
    try {
      if (fs.existsSync(paths.approved)) {
        const txt = await fs.promises.readFile(paths.approved, {
          encoding: "utf8",
        });
        try {
          return { approved: true, meta: JSON.parse(txt) };
        } catch (e) {
          return { approved: true, meta: { raw: txt } };
        }
      }
      if (fs.existsSync(paths.rejected)) {
        const txt = await fs.promises.readFile(paths.rejected, {
          encoding: "utf8",
        });
        try {
          return { approved: false, meta: JSON.parse(txt) };
        } catch (e) {
          return { approved: false, meta: { raw: txt } };
        }
      }
    } catch (e) {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { approved: false, timeout: true };
}

// Archive helper: move pending + marker into archive with combined payload
async function archivePendingRequest(id, status, approverMeta, pendingPayload) {
  try {
    await ensureApprovalDir();
    const { approvalDir } = getApprovalConfig();
    const ARCHIVE_DIR = path.join(approvalDir, "archive");
    await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
    const outPath = path.join(ARCHIVE_DIR, `${id}.${status}.json`);
    const archiveObj = {
      id,
      status,
      pending: pendingPayload || null,
      action: approverMeta || null,
      archivedAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(
      outPath,
      JSON.stringify(archiveObj, null, 2),
      "utf8",
    );

    // Remove original pending and marker files if present
    const paths = approvalPaths(id);
    for (const p of [paths.pending, paths.approved, paths.rejected]) {
      try {
        if (fs.existsSync(p)) await fs.promises.unlink(p);
      } catch (e) {
        // ignore
      }
    }

    // Run retention rotation opportunistically
    try {
      await runArchiveRetention();
    } catch (e) {
      // ignore retention errors
    }

    return outPath;
  } catch (e) {
    console.warn("archivePendingRequest failed", e?.message || e);
    return null;
  }
}

// Retention / rotation: move archived files older than RETENTION_DAYS into archive/old/YYYY-MM
const RETENTION_DAYS = Number(
  process.env.FILE_WRITE_ARCHIVE_RETENTION_DAYS || 30,
);
async function runArchiveRetention() {
  try {
    const { approvalDir } = getApprovalConfig();
    const ARCHIVE_DIR = path.join(approvalDir, "archive");
    const OLD_DIR = path.join(ARCHIVE_DIR, "old");
    await fs.promises.mkdir(OLD_DIR, { recursive: true });
    const files = await fs.promises.readdir(ARCHIVE_DIR);
    const now = Date.now();
    for (const f of files) {
      const full = path.join(ARCHIVE_DIR, f);
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) continue;
      const ageMs = now - stat.mtimeMs;
      if (ageMs > RETENTION_DAYS * 24 * 60 * 60 * 1000) {
        const y = new Date(stat.mtimeMs).toISOString().slice(0, 7); // YYYY-MM
        const destDir = path.join(OLD_DIR, y);
        await fs.promises.mkdir(destDir, { recursive: true });
        const dest = path.join(destDir, f);
        await fs.promises.rename(full, dest);
      }
    }
    return true;
  } catch (e) {
    console.warn("runArchiveRetention failed", e?.message || e);
    return false;
  }
}

/**
 * Parses assistant responses and coordinates autonomous tool executions.
 * @param {string} rawModelReply
 * @param {string} sessionId
 */
// Issue #396: per-session ceilings on how many times each tool may run.
//
// Individual actions were already bounded -- file writes by size, scripts by
// wall clock, delegation by concurrency -- but nothing counted the
// aggregate. A loop that finds a task it cannot finish can retry
// indefinitely, every action perfectly legal and bounded, and nothing stops
// it. For Mana that is worse than a wasted bill: each retry occupies the
// single local model on the single GPU, so a runaway loop makes her
// unresponsive to the person sitting in front of her.
//
// Generous by design. This should never fire in normal use, and should
// catch a loop in seconds rather than minutes when it does.
const MAX_TOOL_CALLS_PER_SESSION = Math.max(
  1,
  Number(process.env.MANA_MAX_TOOL_CALLS_PER_SESSION) || 50,
);

// Keyed by session, so one conversation's runaway loop cannot spend
// another's budget. In-memory: a cap is about the session in progress, not
// a quota that should follow the user across a restart.
const sessionToolCounts = new Map();

function countToolCall(sessionId, tool) {
  const key = String(sessionId || "default");
  let counts = sessionToolCounts.get(key);
  if (!counts) {
    counts = new Map();
    sessionToolCounts.set(key, counts);
  }
  const next = (counts.get(tool) || 0) + 1;
  counts.set(tool, next);
  return next;
}

function resetSessionToolCounts(sessionId) {
  if (sessionId === undefined) {
    sessionToolCounts.clear();
    return true;
  }
  return sessionToolCounts.delete(String(sessionId || "default"));
}

// Issue #419: bounds how many times run_tests may report a genuine failure
// (or a timeout) before it refuses to run again for the session, same
// default (3) and reasoning as MAX_CONSECUTIVE_TOOL_ERRORS in
// llama-server-runtime.js and approval-gate.js's maxConsecutiveDenials -- a
// wrongly-broken loop costs one manual retry; an unbroken one costs an
// assistant that nags. A disallowed-command rejection from acp-test-runner
// doesn't consume an attempt here -- that's the model asking for something
// it can't run, not a real test-iteration failure, so retrying with a
// different (valid) command should be free.
const MAX_TEST_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.MANA_MAX_TEST_RETRY_ATTEMPTS) || 3,
);

// How much of a failing run_tests' combined stdout+stderr gets folded into
// injectedContext -- the tail, not the head, since a test runner's actual
// assertion/failure detail is almost always at the end of its output, with
// setup/passing-test noise at the start. Unbounded output here would be
// exactly the kind of repeated-injection prompt bloat #400/#334 measured.
const TEST_OUTPUT_INJECT_CHARS = Math.max(
  200,
  Number(process.env.MANA_TEST_OUTPUT_INJECT_CHARS) || 2000,
);

const sessionTestRetryCounts = new Map();

function resetSessionTestRetryCounts(sessionId) {
  if (sessionId === undefined) {
    sessionTestRetryCounts.clear();
    return true;
  }
  return sessionTestRetryCounts.delete(String(sessionId || "default"));
}

// Real instance, used unless a caller (tests, or a future createAcpAutonomousLoop
// caller) injects its own via executeAutonomousStep's options.testRunner.
const defaultTestRunner = createAcpTestRunner();
// #426 sub-project 1: shared across calls that don't inject their own, same
// as defaultTestRunner above -- a fresh store per call would defeat
// maxRetained pruning (every call would see an empty pool).
const defaultSnapshotStore = createSnapshotStore({});

async function executeAutonomousStep(rawModelReply, sessionId, options = {}) {
  const testRunner = options.testRunner || defaultTestRunner;
  const snapshotStore = options.snapshotStore || defaultSnapshotStore;
  const makeScratchCopy =
    options.createScratchWorkspaceCopy || createScratchWorkspaceCopy;
  const removeScratchCopy =
    options.removeScratchWorkspaceCopy || removeScratchWorkspaceCopy;
  // 1. Leverage your centralized safe extraction utility
  let actions = safeJsonParse(rawModelReply);

  // Fallback: some model outputs may include JSON with Windows-style backslashes
  // or slight formatting that the extractor missed. Attempt a permissive regex parse.
  if (!actions || !Array.isArray(actions)) {
    try {
      const firstBracket = rawModelReply.indexOf("[");
      const lastBracket = rawModelReply.lastIndexOf("]");
      if (
        firstBracket !== -1 &&
        lastBracket !== -1 &&
        lastBracket > firstBracket
      ) {
        let candidate = rawModelReply.slice(firstBracket, lastBracket + 1);
        try {
          actions = JSON.parse(candidate);
        } catch (e) {
          // Try escaping stray backslashes (common in Windows paths inside loose JSON)
          const escaped = candidate.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
          actions = JSON.parse(escaped);
        }
      }
    } catch (e) {
      // ignore and treat as conversational below
    }
  }

  // If it's a standard text string with no JSON tool markers, return conversation directly
  if (!actions || !Array.isArray(actions)) {
    return { status: "conversational", data: rawModelReply };
  }

  console.error(
    `[Mana Agent Loop] ⚙️ Processing ${actions.length} autonomous action(s)...`,
  );

  const results = [];
  // Issue #401: set when the model requests "finish", believing the
  // session's user-stated goal (echoed back to the caller by
  // mana-acp-agent.js's mana/agent/run handler) is done. This loop is
  // driven externally (by Zed, or any other ACP client) -- node-bot
  // cannot force it to stop calling mana/agent/run again, so this is a
  // signal for the caller to respect, not an enforced stop.
  let finishReason = null;

  for (const action of actions) {
    const { tool, args } = action;

    // Issue #396: checked before dispatch, so a capped tool costs nothing
    // beyond the check. Reported in the results rather than thrown, so the
    // model is told it hit a ceiling and can stop, instead of seeing an
    // exception it may read as transient and retry.
    const callCount = countToolCall(sessionId, tool);
    if (callCount > MAX_TOOL_CALLS_PER_SESSION) {
      console.error(
        `[Mana Agent Loop] 🛑 ${tool} hit the per-session cap of ${MAX_TOOL_CALLS_PER_SESSION}; refusing further calls this session.`,
      );
      results.push({
        tool,
        status: "error",
        detail: "session_cap_exceeded",
        cap: MAX_TOOL_CALLS_PER_SESSION,
      });
      continue;
    }

    if (tool === "local_retrieve") {
      const query = args && args.query ? String(args.query) : "";
      console.error(
        `[Mana Tool] 🔍 Executing codebase vector search for query: "${query}"`,
      );

      try {
        // Directly query your custom Python FastAPI retriever microservice
        const response = await axios.post(
          `${RETRIEVER_URL}/retrieve`,
          {
            query: query,
            k: (args && args.k) || 3,
          },
          { timeout: 20000 },
        );

        const hits = Array.isArray(response.data)
          ? response.data
          : response.data?.results || [];

        // Format the retrieved code context chunks for injection
        const contextPayload = hits
          .map((match, idx) => {
            // Best-effort accessors to keep this resilient to retriever shape changes
            const file =
              match?.meta?.filepath ||
              match?.meta?.path ||
              match?.filepath ||
              match?.path ||
              `result_${idx + 1}`;
            const text =
              match?.meta?.text || match?.text || match?.meta?.preview || "";
            return `[Code Match ${idx + 1} from ${file}]\n${text}`;
          })
          .join("\n\n");

        console.error(
          `  ✅ Successfully retracted ${hits.length} matches from vector store.`,
        );

        results.push({
          tool: "local_retrieve",
          status: "ok",
          hits: hits.length,
          injectedContext: `Here is the relevant codebase context retrieved from local index files:\n\n${contextPayload}`,
        });
      } catch (err) {
        console.error(
          `  ❌ Failed to execute vector retrieval tool: ${err.message}`,
        );
        results.push({
          tool: "local_retrieve",
          status: "error",
          detail: err.message,
        });
      }

      continue;
    }

    if (tool === "file_read") {
      const requestedPath = args && args.path ? String(args.path) : null;
      if (!requestedPath) {
        results.push({
          tool: "file_read",
          status: "error",
          detail: "missing_path_arg",
        });
        continue;
      }

      try {
        // Resolve requested path safely within the repository root
        const resolvedPath = resolveWithinRepo(requestedPath);
        if (!resolvedPath) {
          results.push({
            tool: "file_read",
            status: "error",
            detail: "path_outside_repo",
          });
          continue;
        }

        // Check file exists and is a file
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
          results.push({
            tool: "file_read",
            status: "error",
            detail: "not_a_file",
          });
          continue;
        }

        // Limit read size
        const size = stat.size;
        let content = await fs.promises.readFile(resolvedPath, {
          encoding: "utf8",
        });
        let truncated = false;
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_READ_BYTES) {
          content = content.slice(0, MAX_FILE_READ_BYTES);
          truncated = true;
        }

        const injected = `FileRead: ${path.relative(REPO_ROOT, resolvedPath)} (size=${size}${truncated ? ", truncated" : ""})\n\n${content}`;
        const relPath = path
          .relative(REPO_ROOT, resolvedPath)
          .split(path.sep)
          .join("/");
        results.push({
          tool: "file_read",
          status: "ok",
          path: relPath,
          size,
          truncated,
          injectedContext: injected,
        });
        console.error(
          `  ✅ file_read: ${resolvedPath} (${size} bytes${truncated ? ", truncated" : ""})`,
        );
      } catch (err) {
        console.error(`  ❌ Failed to read file: ${err.message}`);
        results.push({
          tool: "file_read",
          status: "error",
          detail: err.message,
        });
      }

      continue;
    }

    // file_write tool: write or append content to files inside the repo (guarded)
    if (tool === "file_write") {
      const allowWrite = String(process.env.ALLOW_FILE_WRITE || "0") === "1";
      const requestedPath = args && args.path ? String(args.path) : null;
      const content =
        args && typeof args.content === "string" ? args.content : null;
      const mode = args && args.mode ? String(args.mode) : "overwrite"; // 'overwrite' | 'append'

      if (!allowWrite) {
        results.push({
          tool: "file_write",
          status: "forbidden",
          detail: "file_write_disabled",
        });
        continue;
      }

      if (!requestedPath || content === null) {
        results.push({
          tool: "file_write",
          status: "error",
          detail: "missing_path_or_content",
        });
        continue;
      }

      try {
        const resolvedPath = resolveWithinRepo(requestedPath);
        if (!resolvedPath) {
          results.push({
            tool: "file_write",
            status: "error",
            detail: "path_outside_repo",
          });
          continue;
        }

        // Disallow writes to sensitive locations
        const lower = resolvedPath.toLowerCase();
        if (
          lower.includes(path.sep + ".git" + path.sep) ||
          lower.endsWith(path.sep + ".env") ||
          lower.includes(path.sep + "tools" + path.sep + "vector_store")
        ) {
          results.push({
            tool: "file_write",
            status: "error",
            detail: "path_forbidden",
          });
          continue;
        }

        // Ensure parent directory exists
        await fs.promises.mkdir(path.dirname(resolvedPath), {
          recursive: true,
        });

        // If approval is required, and action not pre-approved via args.approved, create pending request and wait
        let approvalId = null;
        let approvalPayload = null;
        let approvalMeta = null;
        const { requireApproval } = getApprovalConfig();
        if (requireApproval && !(args && args.approved === true)) {
          const id = makeApprovalId();
          approvalId = id;
          const preview = String(content).slice(0, 2048);
          const payload = {
            id,
            path: path.relative(REPO_ROOT, resolvedPath),
            requestedPath: resolvedPath,
            mode,
            sessionId: sessionId || null,
            preview,
            createdAt: new Date().toISOString(),
          };
          approvalPayload = payload;
          try {
            await createPendingRequest(id, payload);
            console.error(
              `  ⏳ file_write pending approval id=${id} path=${payload.path}`,
            );
            const appr = await waitForApprovalResult(id);
            if (!appr.approved) {
              // archive rejected request
              try {
                await archivePendingRequest(id, "rejected", appr.meta, payload);
              } catch (e) {}
              results.push({
                tool: "file_write",
                status: "rejected",
                detail: appr.timeout
                  ? "approval_timeout"
                  : (appr.meta && appr.meta.reason) || "rejected",
              });
              continue;
            }
            // else approved -> proceed
            approvalMeta = appr.meta;
            console.error(
              `  ✅ file_write approved id=${id} by ${appr.meta?.approver || "unknown"}`,
            );
          } catch (e) {
            results.push({
              tool: "file_write",
              status: "error",
              detail: "approval_error:" + String(e.message || e),
            });
            continue;
          }
        }

        // Read current size if exists to enforce caps
        let existingSize = 0;
        try {
          const st = await fs.promises.stat(resolvedPath);
          if (st && st.isFile()) existingSize = st.size;
        } catch (e) {
          // file may not exist
        }

        const MAX_FILE_WRITE_BYTES = Number(
          process.env.MAX_FILE_WRITE_BYTES || 500 * 1024,
        ); // 500 KB

        if (mode === "append") {
          const newSize = existingSize + Buffer.byteLength(content, "utf8");
          if (newSize > MAX_FILE_WRITE_BYTES) {
            results.push({
              tool: "file_write",
              status: "error",
              detail: "size_limit_exceeded",
            });
            continue;
          }

          await fs.promises.appendFile(resolvedPath, content, {
            encoding: "utf8",
          });
          results.push({
            tool: "file_write",
            status: "ok",
            path: path.relative(REPO_ROOT, resolvedPath),
            action: "appended",
            size: newSize,
          });
          console.error(
            `  ✅ file_write append: ${resolvedPath} (+${Buffer.byteLength(content, "utf8")} bytes)`,
          );
          // archive approval if present
          if (approvalId) {
            try {
              await archivePendingRequest(
                approvalId,
                "approved",
                approvalMeta,
                approvalPayload,
              );
            } catch (e) {
              console.warn("archiving pending request failed", e?.message || e);
            }
          }
        } else {
          // Overwrite mode: snapshot the prior content instead of writing
          // an unreadable .bak.<timestamp> copy that nothing ever read back
          // -- this makes the write actually undoable via the shared
          // snapshot store's built-in "file" restorer.
          try {
            const st = await fs.promises.stat(resolvedPath);
            if (st && st.isFile()) {
              const priorContent = await fs.promises.readFile(resolvedPath, "utf8");
              try {
                snapshotStore.recordSnapshot({
                  kind: "file",
                  key: path.relative(REPO_ROOT, resolvedPath),
                  scope: REPO_ROOT,
                  payload: priorContent,
                  summary: "file_write overwrite",
                  source: "agent",
                });
              } catch (snapshotErr) {
                console.warn(
                  "file_write snapshot failed:",
                  snapshotErr?.message || snapshotErr,
                );
              }
            }
          } catch (e) {
            // ignore if not exists
          }

          if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE_BYTES) {
            results.push({
              tool: "file_write",
              status: "error",
              detail: "size_limit_exceeded",
            });
            continue;
          }

          await fs.promises.writeFile(resolvedPath, content, {
            encoding: "utf8",
          });
          const finalStat = await fs.promises.stat(resolvedPath);
          results.push({
            tool: "file_write",
            status: "ok",
            path: path.relative(REPO_ROOT, resolvedPath),
            action: "overwritten",
            size: finalStat.size,
          });
          console.error(
            `  ✅ file_write overwrite: ${resolvedPath} (${finalStat.size} bytes)`,
          );
          // archive approval if present
          if (approvalId) {
            try {
              await archivePendingRequest(
                approvalId,
                "approved",
                approvalMeta,
                approvalPayload,
              );
            } catch (e) {
              console.warn("archiving pending request failed", e?.message || e);
            }
          }
        }
      } catch (err) {
        console.error(`  ❌ Failed file_write: ${err.message}`);
        results.push({
          tool: "file_write",
          status: "error",
          detail: err.message,
        });
        // archive as error if approval was used
        if (approvalId) {
          try {
            await archivePendingRequest(
              approvalId,
              "error",
              { error: String(err.message) },
              approvalPayload,
            );
          } catch (e) {
            console.warn("archiving pending request failed", e?.message || e);
          }
        }
      }

      continue;
    }

    // Mirrors file_write's approval shape exactly:
    // createPendingRequest/waitForApprovalResult/archivePendingRequest, gated
    // by an env-var-controlled require-approval flag --
    // SNAPSHOT_RESTORE_REQUIRE_APPROVAL instead of FILE_WRITE_REQUIRE_APPROVAL,
    // so the two are independently tunable. Unlike file_write, there is no
    // model-controlled args.approved escape hatch here -- file_write's own
    // use of that pattern is additionally gated behind ALLOW_FILE_WRITE
    // (default off), but snapshot_restore has no equivalent master
    // kill-switch, so honoring untrusted model-supplied "approved": true
    // would let the model self-approve a restore on a stock deployment. A
    // restore always goes through the pending-request/human-approval flow
    // when requireApproval is true -- never auto-decided by the model's own
    // tool-call args.
    if (tool === "snapshot_restore") {
      const id = args && args.id ? String(args.id) : null;
      if (!id) {
        results.push({ tool: "snapshot_restore", status: "error", detail: "missing_id" });
        continue;
      }

      const preview = previewRestore(snapshotStore, id);
      if (!preview) {
        results.push({ tool: "snapshot_restore", status: "error", detail: "snapshot_not_found" });
        continue;
      }

      // Pipeline B's own snapshotStore (defaultSnapshotStore, module-scope
      // in this file) only ever gets the built-in "file" restorer -- the
      // memory-session/memory-fact/skill restorers are registered onto a
      // separate store instance in server.js. Checked here, before staging
      // the pending-request/approval, so an unrestorable kind fails fast
      // instead of wasting a human approval round-trip on a restore that's
      // guaranteed to throw once approved.
      if (!snapshotStore.hasRestorer(preview.record.kind)) {
        results.push({ tool: "snapshot_restore", status: "error", detail: "no_restorer_for_kind" });
        continue;
      }

      const requireApproval = (process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL || "1") !== "0";
      let approvalId = null;
      let approvalPayload = null;
      let approvalMeta = null;
      if (requireApproval) {
        approvalId = makeApprovalId("snapshot-restore");
        approvalPayload = {
          id: approvalId,
          snapshotId: id,
          kind: preview.record.kind,
          key: preview.record.key,
          // Staleness (if any) is already embedded in preview.summary above
          // -- that's the text a human approver actually reads. A separate
          // boolean here would be a second, unread encoding of the same
          // fact that could silently drift from the summary wording.
          summary: preview.summary,
          sessionId: sessionId || null,
          createdAt: new Date().toISOString(),
        };
        try {
          await createPendingRequest(approvalId, approvalPayload);
          console.error(`  ⏳ snapshot_restore pending approval id=${approvalId} snapshotId=${id}`);
          const appr = await waitForApprovalResult(approvalId);
          if (!appr.approved) {
            try {
              await archivePendingRequest(approvalId, "rejected", appr.meta, approvalPayload);
            } catch (e) {}
            results.push({
              tool: "snapshot_restore",
              status: "rejected",
              detail: appr.timeout ? "approval_timeout" : (appr.meta && appr.meta.reason) || "rejected",
            });
            continue;
          }
          approvalMeta = appr.meta;
          console.error(`  ✅ snapshot_restore approved id=${approvalId} by ${appr.meta?.approver || "unknown"}`);
        } catch (e) {
          results.push({ tool: "snapshot_restore", status: "error", detail: "approval_error:" + String(e.message || e) });
          continue;
        }
      }

      try {
        // confirmStale: true -- staleness (if any) was already carried in the
        // pending-request payload above and shown to whoever approved it,
        // exactly like Pipeline A's tool source; approval here IS the
        // confirm-anyway decision.
        const result = await snapshotStore.restoreSnapshot(id, { confirmStale: true });
        results.push({ tool: "snapshot_restore", status: "ok", result });
        if (approvalId) {
          try {
            await archivePendingRequest(approvalId, "approved", approvalMeta, approvalPayload);
          } catch (e) {
            console.warn("archiving pending request failed", e?.message || e);
          }
        }
      } catch (err) {
        results.push({ tool: "snapshot_restore", status: "error", detail: err.message });
        if (approvalId) {
          try {
            await archivePendingRequest(approvalId, "error", { error: String(err.message) }, approvalPayload);
          } catch (e) {}
        }
      }
      continue;
    }

    // Read-only, no approval needed -- mirrors Pipeline A's snapshot__list
    // tool (ai/snapshot-tool-source.js), giving Pipeline B's model the same
    // ability to discover snapshot ids and see each one's source field.
    if (tool === "snapshot_list") {
      const snapshots = snapshotStore.listSnapshots(args && args.kind);
      results.push({ tool: "snapshot_list", status: "ok", snapshots });
      continue;
    }

    if (tool === "dir_scan") {
      // Directory scanning tool: returns list of files within a repo-sandboxed path
      const requestedPath = args && args.path ? String(args.path) : ".";
      try {
        let resolved = resolveWithinRepo(requestedPath);

        // Accept a nextToken from callers to continue a previous paginated scan.
        // The nextToken is a base64 JSON string produced by the scanner that contains
        // { root, offset, limit, fingerprint }.
        if (args && args.nextToken) {
          try {
            const tok = JSON.parse(
              Buffer.from(String(args.nextToken), "base64").toString("utf8"),
            );
            if (tok && tok.root) {
              // Use the token's root if it's within the repo sandbox
              const tokRoot = String(tok.root);
              const resolvedTokRoot = resolveWithinRepo(tokRoot);
              if (resolvedTokRoot) {
                resolved = resolvedTokRoot;
              }
            }
            // If token supplies offset/limit, prefer those over explicit args
            if (tok && typeof tok.offset === "number") {
              args.offset = tok.offset;
            }
            if (tok && (typeof tok.limit === "number" || tok.limit === null)) {
              args.limit = tok.limit;
            }
            // carry fingerprint along for potential future validation (not required here)
            args.__tokenFingerprint =
              tok && tok.fingerprint ? tok.fingerprint : null;
          } catch (e) {
            results.push({
              tool: "dir_scan",
              status: "error",
              detail: "invalid_nextToken",
            });
            continue;
          }
        }

        if (!resolved) {
          results.push({
            tool: "dir_scan",
            status: "error",
            detail: "path_outside_repo",
          });
          continue;
        }
        const maxDepth = Math.max(0, Number((args && args.maxDepth) || 5));
        let exts = null;
        if (args && args.ext) {
          if (Array.isArray(args.ext))
            exts = args.ext.map((s) => String(s).toLowerCase());
          else
            exts = String(args.ext)
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean);
        }
        let exclude = [];
        if (args && args.exclude) {
          if (Array.isArray(args.exclude))
            exclude = args.exclude.map((s) => String(s));
          else
            exclude = String(args.exclude)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        }
        const listObj = scanDir(resolved, {
          path: resolved,
          maxDepth,
          exts,
          exclude,
          limit: args && args.limit ? Number(args.limit) : null,
          offset: args && args.offset ? Number(args.offset) : 0,
          useIndex: args && args.useIndex === true,
        });
        const items = Array.isArray(listObj) ? listObj : listObj.items || [];
        const total =
          listObj && typeof listObj.total === "number"
            ? listObj.total
            : items.length;
        const nextToken =
          listObj && listObj.nextToken ? listObj.nextToken : null;
        results.push({
          tool: "dir_scan",
          status: "ok",
          count: items.length,
          total,
          nextToken,
          files: items,
        });
      } catch (e) {
        results.push({
          tool: "dir_scan",
          status: "error",
          detail: String(e.message || e),
        });
      }

      continue;
    }

    // Issue #419: an explicit, model-called tool -- not auto-triggered after
    // file_write. This loop is externally driven (see the finish tool's own
    // comment below); an automatic post-write hook would be the only
    // automatic-retry behavior in an otherwise fully model-driven system,
    // and would misfire mid-multi-file-edit (tests run after file 1 of 3,
    // before the code is even in a testable state).
    if (tool === "run_tests") {
      const command = args && args.command ? String(args.command) : null;
      if (!command) {
        results.push({
          tool: "run_tests",
          status: "error",
          detail: "missing_command_arg",
        });
        continue;
      }

      const requestedCwd = args && args.cwd ? String(args.cwd) : null;
      let resolvedCwd = REPO_ROOT;
      if (requestedCwd) {
        resolvedCwd = resolveWithinRepo(requestedCwd);
        if (!resolvedCwd) {
          results.push({
            tool: "run_tests",
            status: "error",
            detail: "path_outside_repo",
          });
          continue;
        }
      }

      const retryKey = String(sessionId || "default");
      const retriesSoFar = sessionTestRetryCounts.get(retryKey) || 0;
      if (retriesSoFar >= MAX_TEST_RETRY_ATTEMPTS) {
        console.error(
          `[Mana Agent Loop] 🛑 run_tests hit the per-session retry cap of ${MAX_TEST_RETRY_ATTEMPTS}; refusing further attempts this session.`,
        );
        results.push({
          tool: "run_tests",
          status: "retry_exhausted",
          cap: MAX_TEST_RETRY_ATTEMPTS,
        });
        continue;
      }

      // Issue #422: a fresh scratch copy every call, not reused across
      // calls within a session -- file_write edits made between run_tests
      // calls must be reflected, and a stale reused copy would silently
      // test old code instead of what the model just wrote.
      let scratchDir = null;
      try {
        scratchDir = makeScratchCopy(REPO_ROOT);
      } catch (err) {
        console.error(`  ❌ run_tests: failed to create scratch workspace copy: ${err.message}`);
        results.push({
          tool: "run_tests",
          status: "error",
          detail: "scratch_copy_failed",
        });
        continue;
      }
      const scratchCwd = path.join(scratchDir, path.relative(REPO_ROOT, resolvedCwd));

      try {
        const testResult = await testRunner.run(command, { cwd: scratchCwd });
        if (testResult.ok) {
          sessionTestRetryCounts.delete(retryKey);
          console.error(
            `  ✅ run_tests: "${command}" passed (exit ${testResult.exitCode})`,
          );
          results.push({
            tool: "run_tests",
            status: "ok",
            command: testResult.command,
            exitCode: testResult.exitCode,
            injectedContext: `Tests passed: "${testResult.command}" exited 0.`,
          });
        } else {
          const nextCount = retriesSoFar + 1;
          sessionTestRetryCounts.set(retryKey, nextCount);
          const combinedOutput = `${testResult.stdout || ""}${testResult.stderr || ""}`;
          const tail =
            combinedOutput.length > TEST_OUTPUT_INJECT_CHARS
              ? combinedOutput.slice(-TEST_OUTPUT_INJECT_CHARS)
              : combinedOutput;
          console.error(
            `  ❌ run_tests: "${command}" failed (exit ${testResult.exitCode}), attempt ${nextCount}/${MAX_TEST_RETRY_ATTEMPTS}`,
          );
          results.push({
            tool: "run_tests",
            status: "fail",
            command: testResult.command,
            exitCode: testResult.exitCode,
            attempt: nextCount,
            retriesRemaining: Math.max(0, MAX_TEST_RETRY_ATTEMPTS - nextCount),
            injectedContext: `Tests failed: "${testResult.command}" exited ${testResult.exitCode}. Output (tail):\n${tail}`,
          });
        }
      } catch (err) {
        // acp-test-runner rejects (rather than resolving) on a disallowed
        // command or a timeout, distinguished only by message text -- a
        // disallowed command is the model's own mistake (pick a different,
        // allowed command instead), not a real test-iteration failure, so
        // it doesn't cost a retry attempt; a timeout would very likely time
        // out again identically, so it does.
        const isDisallowed = /not allowed/i.test(err.message || "");
        if (!isDisallowed) {
          sessionTestRetryCounts.set(retryKey, retriesSoFar + 1);
        }
        console.error(`  ❌ run_tests error: ${err.message}`);
        results.push({
          tool: "run_tests",
          status: "error",
          detail: err.message,
        });
      } finally {
        removeScratchCopy(scratchDir);
      }

      continue;
    }

    if (tool === "finish") {
      finishReason = (args && args.reason ? String(args.reason) : "").trim() || "goal achieved";
      results.push({ tool: "finish", status: "ok", reason: finishReason });
      continue;
    }

    // Unknown / unsupported tool
    console.error(`[Mana Tool] ⚠️ Unsupported tool: ${tool}`);
    results.push({ tool: tool || "unknown", status: "unsupported" });
  }

  if (finishReason) {
    console.error(`[Mana Agent Loop] 🏁 Model signaled finish: ${finishReason}`);
    return { status: "finished", reason: finishReason, results };
  }

  // Aggregate successful injected contexts
  const successful = results
    .filter((r) => r.status === "ok" && r.injectedContext)
    .map((r) => r.injectedContext);
  if (successful.length > 0) {
    const combinedContext = successful.join("\n\n---\n\n");
    return {
      status: "tools_executed",
      results,
      combinedInjectedContext: combinedContext,
    };
  }

  return { status: "idle", results };
}

async function createAcpAutonomousLoop(options = {}) {
  // Minimal autonomous loop factory used by the ACP agent in tests and runtime.
  // The full implementation may orchestrate multiple iterations, call the backend bridge,
  // run tests, and apply file edits. For unit tests we provide a simple noop loop
  // that accepts params and returns an idle result or proxies to a provided runner.
  const runner = options.runner || null;

  return {
    run: async (params = {}) => {
      if (runner && typeof runner === "function") {
        try {
          return await runner(params);
        } catch (e) {
          return { status: "error", error: String(e?.message || e) };
        }
      }
      // Default behavior: attempt to parse a provided 'modelReply' and execute a single step if present
      if (params && typeof params.modelReply === "string") {
        try {
          return await executeAutonomousStep(
            params.modelReply,
            params.sessionId,
            { testRunner: options.testRunner },
          );
        } catch (e) {
          return { status: "error", error: String(e?.message || e) };
        }
      }
      return { status: "idle", results: [] };
    },
  };
}

module.exports = {
  executeAutonomousStep,
  createAcpAutonomousLoop,
  resetSessionToolCounts,
  resetSessionTestRetryCounts,
  MAX_TOOL_CALLS_PER_SESSION,
  MAX_TEST_RETRY_ATTEMPTS,
};
