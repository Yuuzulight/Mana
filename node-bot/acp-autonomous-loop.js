const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { safeJsonParse } = require("./utils/json-extract");

const RETRIEVER_URL = process.env.RETRIEVER_URL || "http://127.0.0.1:9000";
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(__dirname, "..");
const MAX_FILE_READ_BYTES = Number(
  process.env.MAX_FILE_READ_BYTES || 200 * 1024,
); // 200 KB

// File-write approval settings
const FILE_WRITE_REQUIRE_APPROVAL =
  (process.env.FILE_WRITE_REQUIRE_APPROVAL || "1") !== "0";
const FILE_WRITE_APPROVAL_DIR = path.join(__dirname, "data", "pending_writes");
const FILE_WRITE_APPROVAL_TIMEOUT_MS = Number(
  process.env.FILE_WRITE_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000,
); // 5 minutes

async function ensureApprovalDir() {
  try {
    await fs.promises.mkdir(FILE_WRITE_APPROVAL_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

function makeApprovalId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function createPendingRequest(id, payload) {
  await ensureApprovalDir();
  const filePath = path.join(FILE_WRITE_APPROVAL_DIR, `${id}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
  });
  return filePath;
}

function approvalPaths(id) {
  const base = path.join(FILE_WRITE_APPROVAL_DIR, id);
  return {
    pending: `${base}.json`,
    approved: `${base}.approved.json`,
    rejected: `${base}.rejected.json`,
  };
}

async function waitForApprovalResult(
  id,
  timeoutMs = FILE_WRITE_APPROVAL_TIMEOUT_MS,
) {
  const paths = approvalPaths(id);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
    const ARCHIVE_DIR = path.join(FILE_WRITE_APPROVAL_DIR, "archive");
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
    const ARCHIVE_DIR = path.join(FILE_WRITE_APPROVAL_DIR, "archive");
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
async function executeAutonomousStep(rawModelReply, sessionId) {
  // 1. Leverage your centralized safe extraction utility
  const actions = safeJsonParse(rawModelReply);

  // If it's a standard text string with no JSON tool markers, return conversation directly
  if (!actions || !Array.isArray(actions)) {
    return { status: "conversational", data: rawModelReply };
  }

  console.log(
    `[Mana Agent Loop] ⚙️ Processing ${actions.length} autonomous action(s)...`,
  );

  const results = [];

  for (const action of actions) {
    const { tool, args } = action;

    if (tool === "local_retrieve") {
      const query = args && args.query ? String(args.query) : "";
      console.log(
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

        console.log(
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
        let resolvedPath;
        if (path.isAbsolute(requestedPath)) {
          resolvedPath = path.resolve(requestedPath);
        } else {
          resolvedPath = path.resolve(REPO_ROOT, requestedPath);
        }

        // Ensure the resolved path is inside REPO_ROOT
        const rel = path.relative(REPO_ROOT, resolvedPath);
        if (rel.startsWith("..") || (path.isAbsolute(rel) && !rel)) {
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
        results.push({
          tool: "file_read",
          status: "ok",
          path: path.relative(REPO_ROOT, resolvedPath),
          size,
          truncated,
          injectedContext: injected,
        });
        console.log(
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
        let resolvedPath = path.isAbsolute(requestedPath)
          ? path.resolve(requestedPath)
          : path.resolve(REPO_ROOT, requestedPath);

        // Ensure inside repo
        const rel = path.relative(REPO_ROOT, resolvedPath);
        if (rel.startsWith("..") || (path.isAbsolute(rel) && !rel)) {
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
        if (FILE_WRITE_REQUIRE_APPROVAL && !(args && args.approved === true)) {
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
            console.log(
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
            console.log(
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
          console.log(
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
          // Overwrite mode: backup if exists
          try {
            const st = await fs.promises.stat(resolvedPath);
            if (st && st.isFile()) {
              const bak = `${resolvedPath}.bak.${Date.now()}`;
              await fs.promises.copyFile(resolvedPath, bak);
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
          console.log(
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

    // Unknown / unsupported tool
    console.warn(`[Mana Tool] ⚠️ Unsupported tool: ${tool}`);
    results.push({ tool: tool || "unknown", status: "unsupported" });
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

module.exports = { executeAutonomousStep };
