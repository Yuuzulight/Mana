const fs = require("fs");
const path = require("path");

const KEY = "backgroundMemory";

// Relocated from server.js (previously nested inside the GET /health handler,
// which meant these two routes got re-registered as duplicate Express
// middleware on every single health check -- this is now a normal top-level
// registration instead). Audit log storage + its index are only ever read by
// these routes, so both live entirely in this module.
const BACKGROUND_AUDIT_PATH = path.join(
  __dirname,
  "..",
  "data",
  "acp-memory",
  "background_audit.jsonl",
);
const BACKGROUND_AUDIT_INDEX_PATH = path.join(
  __dirname,
  "..",
  "data",
  "acp-memory",
  "background_audit_index.json",
);
let BACKGROUND_AUDIT_INDEX = { entries: [], lastSize: 0 };
let BACKGROUND_AUDIT_REBUILD_LOCK = false;
let BACKGROUND_AUDIT_LAST_REBUILD = null;

function loadAuditIndexSync() {
  try {
    if (fs.existsSync(BACKGROUND_AUDIT_INDEX_PATH)) {
      const txt = fs.readFileSync(BACKGROUND_AUDIT_INDEX_PATH, "utf8") || "";
      const parsed = JSON.parse(txt || "{}") || { entries: [], lastSize: 0 };
      if (parsed && Array.isArray(parsed.entries)) {
        BACKGROUND_AUDIT_INDEX = parsed;
        console.log(
          "Loaded audit index (entries=",
          BACKGROUND_AUDIT_INDEX.entries.length,
          ", lastSize=",
          BACKGROUND_AUDIT_INDEX.lastSize || 0,
          ")",
        );
      }
    }
  } catch (e) {
    console.warn("Failed to load audit index:", e && e.message ? e.message : e);
  }
}

async function persistAuditIndex() {
  try {
    const dir = path.dirname(BACKGROUND_AUDIT_INDEX_PATH);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = BACKGROUND_AUDIT_INDEX_PATH + ".tmp";
    await fs.promises.writeFile(
      tmp,
      JSON.stringify(
        BACKGROUND_AUDIT_INDEX || { entries: [], lastSize: 0 },
        null,
        2,
      ),
      "utf8",
    );
    await fs.promises.rename(tmp, BACKGROUND_AUDIT_INDEX_PATH);
  } catch (e) {
    console.warn(
      "Failed to persist audit index:",
      e && e.message ? e.message : e,
    );
  }
}

async function buildIndexFromAuditFile() {
  try {
    if (!fs.existsSync(BACKGROUND_AUDIT_PATH)) {
      BACKGROUND_AUDIT_INDEX = { entries: [], lastSize: 0 };
      await persistAuditIndex();
      return { entries: [], lastSize: 0 };
    }
    const txt = await fs.promises.readFile(BACKGROUND_AUDIT_PATH, "utf8");
    const lines = (txt || "").split(/\r?\n/).filter(Boolean);
    const entries = [];
    let offset = 0;
    for (const line of lines) {
      const len = Buffer.byteLength(line + "\n", "utf8");
      let meta = { raw: line };
      try {
        meta = JSON.parse(line);
      } catch (e) {}
      entries.push({
        at: meta.at || null,
        approver: meta.approver || null,
        action: meta.action || null,
        offset,
        length: len,
      });
      offset += len;
    }
    // store oldest-first in index (matches file order)
    BACKGROUND_AUDIT_INDEX = { entries, lastSize: offset };
    await persistAuditIndex();
    console.log(
      "Rebuilt audit index (entries=",
      entries.length,
      ", lastSize=",
      offset,
      ")",
    );
    return { entries, lastSize: offset };
  } catch (e) {
    console.warn(
      "Failed to build audit index:",
      e && e.message ? e.message : e,
    );
    return { entries: [], lastSize: 0 };
  }
}

async function appendBackgroundAudit(app, entry) {
  try {
    const dir = path.dirname(BACKGROUND_AUDIT_PATH);
    await fs.promises.mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    // determine current file size to get offset
    let offset = 0;
    try {
      const st = await fs.promises
        .stat(BACKGROUND_AUDIT_PATH)
        .catch(() => ({ size: 0 }));
      offset = st.size || 0;
    } catch (e) {
      offset = 0;
    }
    await fs.promises.appendFile(BACKGROUND_AUDIT_PATH, line, "utf8");
    const length = Buffer.byteLength(line, "utf8");
    // update index (append)
    try {
      const meta = {
        at: entry.at || new Date().toISOString(),
        approver: entry.approver || null,
        action: entry.action || null,
        offset,
        length,
      };
      BACKGROUND_AUDIT_INDEX.entries = BACKGROUND_AUDIT_INDEX.entries || [];
      BACKGROUND_AUDIT_INDEX.entries.push(meta);
      // update lastSize
      BACKGROUND_AUDIT_INDEX.lastSize =
        (BACKGROUND_AUDIT_INDEX.lastSize || 0) + length;
      // persist index asynchronously (don't await to avoid blocking)
      persistAuditIndex().catch((err) =>
        console.warn("persistAuditIndex failed:", err),
      );
    } catch (e) {
      console.warn(
        "Failed to update audit index:",
        e && e.message ? e.message : e,
      );
    }

    // send a live tray ping via internal notifier if available
    try {
      const trayNotifier = require("../tray-notifier");
      // use convenience sendAuditTray which debounces/aggregates
      const sent = await (trayNotifier.sendAuditTray
        ? trayNotifier.sendAuditTray(entry)
        : trayNotifier.notifyTray({
            type: "audit",
            title: "Background Audit",
            text: `${entry.action || "audit"} by ${entry.approver || "unknown"}`,
            at: entry.at || new Date().toISOString(),
          }));
      if (!sent) {
        const bt = app && app.locals && app.locals.broadcastTrayNotification;
        if (typeof bt === "function") {
          try {
            bt({
              type: "audit",
              title: "Background Audit",
              text: `${entry.action || "audit"} by ${entry.approver || "unknown"}`,
              at: entry.at || new Date().toISOString(),
            });
          } catch (e) {}
        }
      }
    } catch (e) {
      // don't block on notifications
    }
  } catch (e) {
    console.warn(
      "Failed to write background memory audit entry:",
      e && e.message ? e.message : e,
    );
  }
}

// load index at startup if present
try {
  loadAuditIndexSync();
} catch (e) {}
// if no index present, build in background
if (
  !BACKGROUND_AUDIT_INDEX ||
  !Array.isArray(BACKGROUND_AUDIT_INDEX.entries) ||
  BACKGROUND_AUDIT_INDEX.entries.length === 0
) {
  // don't await
  buildIndexFromAuditFile().catch((err) =>
    console.warn("Initial audit index build failed:", err),
  );
}

function registerBackgroundMemoryRoutes(app, context = {}) {
  const checkAdminAuth = context.checkAdminAuth;
  const runBackgroundReviewerPublic = context.runBackgroundReviewerPublic;
  const asyncLoadBackgroundMemory = context.asyncLoadBackgroundMemory;
  const persistBackgroundMeta = context.persistBackgroundMeta;
  const getBackgroundMemoryMeta = context.getBackgroundMemoryMeta;
  const setBackgroundMemoryBlock = context.setBackgroundMemoryBlock;

  // Admin endpoints: background memory preview & apply (preview returns a dry-run of reviewer)
  app.get("/admin/background-memory/preview", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      if (typeof runBackgroundReviewerPublic !== "function") {
        return res
          .status(500)
          .json({ ok: false, error: "reviewer_unavailable" });
      }
      const preview = await runBackgroundReviewerPublic(false);
      return res.json({ ok: true, preview });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.post("/admin/background-memory/apply", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      // If body contains explicit changes, apply them; otherwise run reviewer and apply its result
      const body = req.body || {};
      if (
        body &&
        (Array.isArray(body.remove_indices) ||
          body.compacted ||
          Array.isArray(body.important_facts))
      ) {
        // manual apply
        const payloadRemove = Array.isArray(body.remove_indices)
          ? body.remove_indices
          : [];
        const payloadImportant = Array.isArray(body.important_facts)
          ? body.important_facts
          : [];
        const payloadCompacted =
          typeof body.compacted === "string"
            ? String(body.compacted).trim()
            : null;

        const resLoad = await asyncLoadBackgroundMemory();
        const processedFiles =
          resLoad && resLoad.processedFiles ? resLoad.processedFiles : [];
        const applied = { removed: [], important: [], compacted: null };
        const BACKGROUND_MEMORY_META = getBackgroundMemoryMeta();

        // apply removals
        for (const idx of payloadRemove) {
          if (!Number.isInteger(idx)) continue;
          const i = Number(idx) - 1;
          const pf = processedFiles[i];
          if (
            pf &&
            pf.file &&
            BACKGROUND_MEMORY_META.files &&
            BACKGROUND_MEMORY_META.files[pf.file]
          ) {
            BACKGROUND_MEMORY_META.files[pf.file].pruned = true;
            BACKGROUND_MEMORY_META.files[pf.file].summary = "";
            applied.removed.push(pf.file);
          }
        }

        // important facts
        if (payloadImportant && payloadImportant.length) {
          BACKGROUND_MEMORY_META.important_facts = payloadImportant.slice(
            0,
            200,
          );
          applied.important = BACKGROUND_MEMORY_META.important_facts;
        }

        // compacted
        if (payloadCompacted) {
          const maxChars = Number(
            process.env.MANA_BACKGROUND_MEMORY_MAX_CHARS || 2000,
          );
          let compactText = payloadCompacted.replace(/\s+/g, " ").trim();
          if (compactText.length > maxChars)
            compactText = compactText.slice(0, maxChars).trim() + "...";
          setBackgroundMemoryBlock(
            `[BACKGROUND MEMORY]\n${compactText}\n[END BACKGROUND MEMORY]`,
          );
          applied.compacted = compactText;
        }

        try {
          await persistBackgroundMeta();
        } catch (e) {
          // ignore
        }

        // Audit entry
        try {
          const header = req.get("authorization") || "";
          const approver =
            (body && body.approver) || (header ? "admin" : "local-user");
          const audit = {
            at: new Date().toISOString(),
            approver,
            action: "manual_apply",
            removed: applied.removed || [],
            important_facts: applied.important || [],
            compacted: (applied.compacted || "").slice(0, 2000),
          };
          await appendBackgroundAudit(app, audit);
        } catch (e) {
          console.warn(
            "Failed to write background audit (manual):",
            e && e.message ? e.message : e,
          );
        }

        return res.json({ ok: true, applied });
      }

      // otherwise run the reviewer and apply its recommendations
      if (typeof runBackgroundReviewerPublic !== "function") {
        return res
          .status(500)
          .json({ ok: false, error: "reviewer_unavailable" });
      }
      const result = await runBackgroundReviewerPublic(true);

      // Audit reviewer application
      try {
        const header = req.get("authorization") || "";
        const approver = header ? "admin" : "system";
        const audit = {
          at: new Date().toISOString(),
          approver,
          action: "reviewer_apply",
          result: result && result.parsed ? result.parsed : null,
          processedFilesCount:
            result && result.processedFiles
              ? result.processedFiles.length
              : 0,
        };
        await appendBackgroundAudit(app, audit);
      } catch (e) {
        console.warn(
          "Failed to write background audit (reviewer):",
          e && e.message ? e.message : e,
        );
      }

      return res.json({ ok: true, result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Admin endpoint: read audit entries (supports pagination, free-text search, and structured filters)
  app.get("/admin/background-memory/audit", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const offset = Math.max(0, Number(req.query.offset || 0));
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 50)));
      const q =
        typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

      // structured filters
      const approverFilter =
        typeof req.query.approver === "string"
          ? req.query.approver.trim().toLowerCase()
          : null;
      const actionFilter =
        typeof req.query.action === "string"
          ? req.query.action.trim().toLowerCase()
          : null;
      const fromTs = req.query.from ? Date.parse(String(req.query.from)) : null;
      const toTs = req.query.to ? Date.parse(String(req.query.to)) : null;

      if (!fs.existsSync(BACKGROUND_AUDIT_PATH))
        return res.json({ ok: true, total: 0, entries: [] });

      const txt = await fs.promises.readFile(BACKGROUND_AUDIT_PATH, "utf8");
      const lines = (txt || "").trim().split(/\r?\n/).filter(Boolean);
      const parsed = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return { raw: l };
        }
      });
      parsed.reverse(); // newest first

      const filtered = parsed.filter((e) => {
        try {
          if (approverFilter) {
            const a = (e.approver || "").toString().toLowerCase();
            if (!a.includes(approverFilter)) return false;
          }
          if (actionFilter) {
            const a = (e.action || "").toString().toLowerCase();
            if (!a.includes(actionFilter)) return false;
          }
          if (fromTs || toTs) {
            const at = e.at ? Date.parse(String(e.at)) : NaN;
            if (fromTs && (!at || at < fromTs)) return false;
            if (toTs && (!at || at > toTs)) return false;
          }
          if (q) {
            if (!JSON.stringify(e).toLowerCase().includes(q)) return false;
          }
          return true;
        } catch (ex) {
          return false;
        }
      });

      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);

      // determine index freshness
      let indexUpToDate = false;
      try {
        const st = await fs.promises
          .stat(BACKGROUND_AUDIT_PATH)
          .catch(() => ({ size: 0 }));
        const currentSize = st.size || 0;
        indexUpToDate =
          BACKGROUND_AUDIT_INDEX &&
          Number(BACKGROUND_AUDIT_INDEX.lastSize || 0) === Number(currentSize);
      } catch (e) {
        indexUpToDate = false;
      }

      return res.json({
        ok: true,
        total,
        offset,
        limit,
        entries: page,
        indexUpToDate,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Admin endpoint: rebuild audit index on-demand (synchronous)
  app.post("/admin/background-memory/audit/rebuild", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      if (BACKGROUND_AUDIT_REBUILD_LOCK) {
        return res
          .status(409)
          .json({ ok: false, error: "rebuild_in_progress" });
      }
      BACKGROUND_AUDIT_REBUILD_LOCK = true;
      try {
        const result = await buildIndexFromAuditFile();
        BACKGROUND_AUDIT_LAST_REBUILD = new Date().toISOString();
        return res.json({
          ok: true,
          entries:
            result && result.entries
              ? result.entries.length
              : (BACKGROUND_AUDIT_INDEX.entries || []).length,
          lastSize:
            (result && result.lastSize) || BACKGROUND_AUDIT_INDEX.lastSize || 0,
        });
      } finally {
        BACKGROUND_AUDIT_REBUILD_LOCK = false;
      }
    } catch (e) {
      BACKGROUND_AUDIT_REBUILD_LOCK = false;
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Admin endpoint: rebuild audit index with streaming progress (NDJSON)
  app.get("/admin/background-memory/audit/rebuild/stream", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      if (BACKGROUND_AUDIT_REBUILD_LOCK) {
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.write(JSON.stringify({ error: "rebuild_in_progress" }) + "\n");
        return res.end();
      }
      BACKGROUND_AUDIT_REBUILD_LOCK = true;
      BACKGROUND_AUDIT_LAST_REBUILD = new Date().toISOString();

      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // if no file, emit done
      if (!fs.existsSync(BACKGROUND_AUDIT_PATH)) {
        const doneObj = { done: true, entries: 0, lastSize: 0 };
        res.write(JSON.stringify(doneObj) + "\n");
        BACKGROUND_AUDIT_REBUILD_LOCK = false;
        return res.end();
      }

      const st = await fs.promises
        .stat(BACKGROUND_AUDIT_PATH)
        .catch(() => ({ size: 0 }));
      const totalBytes = st.size || 0;

      const stream = fs.createReadStream(BACKGROUND_AUDIT_PATH, {
        encoding: "utf8",
      });
      const readline = require("readline");
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      let offset = 0;
      let count = 0;
      const entries = [];
      const reportEvery = Number(process.env.AUDIT_INDEX_REPORT_EVERY || 200);

      let aborted = false;
      req.on("close", () => {
        aborted = true;
        try {
          rl.close();
        } catch (e) {}
        try {
          stream.destroy();
        } catch (e) {}
      });

      for await (const line of rl) {
        if (aborted) break;
        const len = Buffer.byteLength(line + "\n", "utf8");
        let meta = { raw: line };
        try {
          meta = JSON.parse(line);
        } catch (e) {}
        entries.push({
          at: meta.at || null,
          approver: meta.approver || null,
          action: meta.action || null,
          offset,
          length: len,
        });
        offset += len;
        count += 1;
        if (count % reportEvery === 0) {
          const progress = {
            processedLines: count,
            bytesProcessed: offset,
            totalBytes,
            percent: totalBytes
              ? Math.round((offset / totalBytes) * 100)
              : null,
          };
          res.write(JSON.stringify({ progress }) + "\n");
          // flush
        }
      }

      // finalize index
      BACKGROUND_AUDIT_INDEX = { entries, lastSize: offset };
      await persistAuditIndex();

      const doneObj = { done: true, entries: entries.length, lastSize: offset };
      res.write(
        JSON.stringify({
          progress: {
            processedLines: count,
            bytesProcessed: offset,
            totalBytes,
            percent: totalBytes
              ? Math.round((offset / totalBytes) * 100)
              : null,
          },
        }) + "\n",
      );
      res.write(JSON.stringify(doneObj) + "\n");
      BACKGROUND_AUDIT_REBUILD_LOCK = false;
      return res.end();
    } catch (e) {
      BACKGROUND_AUDIT_REBUILD_LOCK = false;
      try {
        res.write(JSON.stringify({ error: String(e) }) + "\n");
      } catch (er) {}
      try {
        res.end();
      } catch (er) {}
    }
  });

  // CSV export endpoint (supports same filters)
  app.get("/admin/background-memory/audit.csv", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const offset = Math.max(0, Number(req.query.offset || 0));
      const limit = Math.max(
        1,
        Math.min(10000, Number(req.query.limit || 1000)),
      );
      const q =
        typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const approverFilter =
        typeof req.query.approver === "string"
          ? req.query.approver.trim().toLowerCase()
          : null;
      const actionFilter =
        typeof req.query.action === "string"
          ? req.query.action.trim().toLowerCase()
          : null;
      const fromTs = req.query.from ? Date.parse(String(req.query.from)) : null;
      const toTs = req.query.to ? Date.parse(String(req.query.to)) : null;

      if (!fs.existsSync(BACKGROUND_AUDIT_PATH))
        return res.status(200).send("");

      const txt = await fs.promises.readFile(BACKGROUND_AUDIT_PATH, "utf8");
      const lines = (txt || "").trim().split(/\r?\n/).filter(Boolean);
      const parsed = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (e) {
            return { raw: l };
          }
        })
        .reverse();

      const filtered = parsed.filter((e) => {
        try {
          if (approverFilter) {
            const a = (e.approver || "").toString().toLowerCase();
            if (!a.includes(approverFilter)) return false;
          }
          if (actionFilter) {
            const a = (e.action || "").toString().toLowerCase();
            if (!a.includes(actionFilter)) return false;
          }
          if (fromTs || toTs) {
            const at = e.at ? Date.parse(String(e.at)) : NaN;
            if (fromTs && (!at || at < fromTs)) return false;
            if (toTs && (!at || at > toTs)) return false;
          }
          if (q) {
            if (!JSON.stringify(e).toLowerCase().includes(q)) return false;
          }
          return true;
        } catch (ex) {
          return false;
        }
      });

      const page = filtered.slice(offset, offset + limit);

      // Build CSV
      const hdr = [
        "at",
        "approver",
        "action",
        "removed_count",
        "important_facts",
        "compacted",
        "raw",
      ];
      function esc(v) {
        if (v === null || v === undefined) return "";
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return '"' + s.replace(/"/g, '""') + '"';
      }

      const rows = [hdr.join(",")];
      for (const e of page) {
        const removedCount = Array.isArray(e.removed)
          ? e.removed.length
          : e.result && e.result.removeIndices
            ? e.result.removeIndices.length
            : 0;
        const important = Array.isArray(e.important_facts)
          ? e.important_facts.join("; ")
          : Array.isArray(e.importantFacts)
            ? e.importantFacts.join("; ")
            : "";
        const compacted = (
          e.compacted ||
          (e.result && e.result.compacted) ||
          ""
        )
          .toString()
          .slice(0, 2000);
        const raw = JSON.stringify(e);
        const row = [
          e.at || "",
          e.approver || "",
          e.action || "",
          String(removedCount),
          important,
          compacted,
          raw,
        ]
          .map(esc)
          .join(",");
        rows.push(row);
      }

      const csv = rows.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="background_audit.csv"`,
      );
      return res.send(csv);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });
}

const backgroundMemoryCapability = {
  key: KEY,
  registerRoutes: registerBackgroundMemoryRoutes,
  getHealth: (context = {}) => {
    return {
      status: "configured",
      configured: true,
      message:
        "Background memory admin routes are available (preview, apply, audit log + index).",
    };
  },
};

module.exports = {
  registerBackgroundMemoryRoutes,
  backgroundMemoryCapability,
};
