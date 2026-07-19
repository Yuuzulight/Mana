const fs = require("fs");
const path = require("path");

const KEY = "retrieverAdmin";

// Relocated from server.js's registerRoutes(). Every handler here already
// did its own inline MANA_ADMIN_SECRET bearer-token check rather than using
// server.js's shared checkAdminAuth, so that's preserved as-is -- no new
// shared context needed beyond app itself.
let VECTOR_STORE_REBUILD_LOCK = false;

const VECTOR_REBUILD_AUDIT_PATH = path.join(
  __dirname,
  "..",
  "data",
  "vector_rebuild_audit.jsonl",
);

async function appendVectorRebuildAudit(entry) {
  try {
    const dir = path.dirname(VECTOR_REBUILD_AUDIT_PATH);
    await fs.promises.mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.promises.appendFile(VECTOR_REBUILD_AUDIT_PATH, line, "utf8");
  } catch (e) {
    console.warn(
      "Failed to write vector rebuild audit:",
      e && e.message ? e.message : e,
    );
  }
}

function checkRetrieverAdminAuth(req, res) {
  const ADMIN_SECRET_ENV = process.env.MANA_ADMIN_SECRET || "";
  if (!ADMIN_SECRET_ENV) return true;
  const header = req.get("authorization") || req.get("Authorization") || "";
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  const token = header.slice(7).trim();
  if (token !== ADMIN_SECRET_ENV) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function registerRetrieverAdminRoutes(app, context = {}) {
  // Admin endpoints for retriever index: rebuild and search
  app.post("/admin/retriever/rebuild", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      const retrieverIndex = require("../tools/retriever-index");
      const roots =
        Array.isArray(req.body?.roots) && req.body.roots.length
          ? req.body.roots
          : [
              process.env.RETRIEVER_INDEX_ROOT ||
                path.resolve(__dirname, "..", ".."),
            ];
      const exts =
        Array.isArray(req.body?.exts) && req.body.exts.length
          ? req.body.exts
          : undefined;
      const maxFiles = req.body?.maxFiles || undefined;
      const result = await retrieverIndex.buildIndex({ roots, exts, maxFiles });
      return res.json({
        ok: true,
        builtAt: result.builtAt,
        count: Array.isArray(result.entries) ? result.entries.length : 0,
      });
    } catch (e) {
      console.warn(
        "/admin/retriever/rebuild failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get("/admin/retriever/search", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const k = Math.max(1, Math.min(50, Number(req.query.k || 5)));
      if (!q)
        return res.status(400).json({ ok: false, error: "q is required" });
      const retrieverIndex = require("../tools/retriever-index");
      // Prefer vector-store search when available (faster for large corpora)
      try {
        const vsModule = require("../tools/vector-store");
        const createStore =
          vsModule && vsModule.createStore ? vsModule.createStore : null;
        if (createStore) {
          const store = createStore({
            dir:
              process.env.VECTOR_STORE_DIR ||
              path.join(__dirname, "..", "..", "tools", "vector_store"),
          });
          await store.init();
          await store.load();
          const cnt = (await store.count().catch(() => 0)) || 0;
          if (cnt > 0) {
            // try to compute embedding for query
            let qembed = null;
            try {
              if (typeof retrieverIndex.computeEmbedding === "function") {
                qembed = await retrieverIndex.computeEmbedding(q);
              }
            } catch (e) {
              qembed = null;
            }
            if (qembed) {
              try {
                const hits = await store.search(qembed, k);
                const out = [];
                for (const h of hits) {
                  const p = h.path || h.id;
                  let snippet = "";
                  try {
                    snippet = String(
                      await fs.promises.readFile(p, "utf8"),
                    ).slice(0, 800);
                  } catch (e) {
                    snippet = "";
                  }
                  out.push({ id: h.id, path: p, score: h.score, snippet });
                }
                return res.json({ ok: true, results: out, vectorStore: true });
              } catch (e) {
                // continue to fallback
              }
            }
          }
        }
      } catch (e) {
        // ignore vector store errors and fall back to retriever-index
      }

      const results = await retrieverIndex.search(q, k);
      return res.json({ ok: true, results });
    } catch (e) {
      console.warn(
        "/admin/retriever/search failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // Incremental scan endpoint: performs an incremental update of the retriever index
  app.post("/admin/retriever/scan-incremental", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;

    try {
      const retrieverIndex = require("../tools/retriever-index");
      const roots =
        Array.isArray(req.body?.roots) && req.body.roots.length
          ? req.body.roots
          : [
              process.env.RETRIEVER_INDEX_ROOT ||
                path.resolve(__dirname, "..", ".."),
            ];
      const exts =
        Array.isArray(req.body?.exts) && req.body.exts.length
          ? req.body.exts
          : undefined;
      const maxFiles = req.body?.maxFiles || undefined;
      const result = await retrieverIndex.incrementalScan({
        roots,
        exts,
        maxFiles,
      });
      return res.json({ ok: true, result });
    } catch (e) {
      console.warn(
        "/admin/retriever/scan-incremental failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // Retriever status endpoint
  app.get("/admin/retriever/status", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      const retrieverIndex = require("../tools/retriever-index");
      const idx = retrieverIndex.loadIndexSync();
      return res.json({
        ok: true,
        meta: idx.meta || {},
        builtAt: idx.builtAt || null,
        count: Array.isArray(idx.entries) ? idx.entries.length : 0,
      });
    } catch (e) {
      console.warn(
        "/admin/retriever/status failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // Embedding worker endpoints
  app.post("/admin/retriever/embeddings/rebuild", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      const embWorker = require("../tools/embedding-worker");
      const result = await embWorker.enqueueAll({});
      return res.json({ ok: true, queued: result.queued, total: result.total });
    } catch (e) {
      console.warn(
        "/admin/retriever/embeddings/rebuild failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get("/admin/retriever/embeddings/status", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      const embWorker = require("../tools/embedding-worker");
      const st = embWorker.status();
      return res.json({ ok: true, status: st });
    } catch (e) {
      console.warn(
        "/admin/retriever/embeddings/status failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // Admin endpoints: vector store rebuild & status
  app.post("/admin/retriever/vector/rebuild", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      const retrieverIndex = require("../tools/retriever-index");
      const dir = req.body?.dir || process.env.VECTOR_STORE_DIR;
      // record audit start
      try {
        const header =
          req.get("authorization") || req.get("Authorization") || "";
        const approver =
          header && header.startsWith("Bearer ") ? "admin" : "system";
        await appendVectorRebuildAudit({
          at: new Date().toISOString(),
          approver,
          action: "vector_rebuild",
          status: "started",
          dir: dir || null,
        });
      } catch (e) {}

      const result = await retrieverIndex.buildVectorStore({ dir });

      // record audit done
      try {
        const header =
          req.get("authorization") || req.get("Authorization") || "";
        const approver =
          header && header.startsWith("Bearer ") ? "admin" : "system";
        await appendVectorRebuildAudit({
          at: new Date().toISOString(),
          approver,
          action: "vector_rebuild",
          status: result && result.ok ? "done" : "failed",
          dir: dir || null,
          added:
            result && typeof result.added !== "undefined" ? result.added : null,
          count:
            result && typeof result.count !== "undefined" ? result.count : null,
        });
      } catch (e) {}

      return res.json(Object.assign({ ok: true }, result || {}));
    } catch (e) {
      console.warn(
        "/admin/retriever/vector/rebuild failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get("/admin/retriever/vector/status", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      const vsModule = require("../tools/vector-store");
      const createStore =
        vsModule && vsModule.createStore ? vsModule.createStore : null;
      if (!createStore)
        return res.json({ ok: true, available: false, count: 0 });
      const store = createStore({
        dir:
          process.env.VECTOR_STORE_DIR ||
          path.join(__dirname, "..", "..", "tools", "vector_store"),
      });
      await store.init();
      await store.load();
      const cnt = (await store.count().catch(() => 0)) || 0;
      return res.json({ ok: true, available: true, count: cnt });
    } catch (e) {
      console.warn(
        "/admin/retriever/vector/status failed:",
        e && e.message ? e.message : e,
      );
      return res
        .status(500)
        .json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // Vector rebuild audit endpoints
  app.get("/admin/retriever/vector/rebuild/audit", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      if (!fs.existsSync(VECTOR_REBUILD_AUDIT_PATH))
        return res.json({ ok: true, total: 0, entries: [] });
      const txt = await fs.promises.readFile(VECTOR_REBUILD_AUDIT_PATH, "utf8");
      const lines = (txt || "").split(/\r?\n/).filter(Boolean);
      let parsed = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return { raw: l };
        }
      });
      parsed.reverse(); // newest first

      const offset = Math.max(0, Number(req.query.offset || 0));
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 50)));
      const q =
        typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const fromTs = req.query.from ? Date.parse(String(req.query.from)) : null;
      const toTs = req.query.to ? Date.parse(String(req.query.to)) : null;

      const filtered = parsed.filter((e) => {
        try {
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
      return res.json({ ok: true, total, offset, limit, entries: page });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.get("/admin/retriever/vector/rebuild/audit.csv", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;
    try {
      if (!fs.existsSync(VECTOR_REBUILD_AUDIT_PATH))
        return res.status(200).send("");
      const txt = await fs.promises.readFile(VECTOR_REBUILD_AUDIT_PATH, "utf8");
      const lines = (txt || "").split(/\r?\n/).filter(Boolean);
      const parsed = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (e) {
            return { raw: l };
          }
        })
        .reverse();

      const hdr = [
        "at",
        "approver",
        "action",
        "status",
        "dir",
        "added",
        "count",
        "durationMs",
        "error",
        "raw",
      ];
      function esc(v) {
        if (v === null || v === undefined) return "";
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return '"' + s.replace(/"/g, '""') + '"';
      }
      const rows = [hdr.join(",")];
      for (const e of parsed) {
        const row = [
          esc(e.at || ""),
          esc(e.approver || ""),
          esc(e.action || ""),
          esc(e.status || ""),
          esc(e.dir || ""),
          esc(e.added || ""),
          esc(e.count || ""),
          esc(e.durationMs || ""),
          esc(e.error || ""),
          esc(e.raw || ""),
        ].join(",");
        rows.push(row);
      }
      const csv = rows.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="vector_rebuild_audit.csv"`,
      );
      return res.send(csv);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Streamed vector rebuild with NDJSON progress (admin-protected)
  app.get("/admin/retriever/vector/rebuild/stream", async (req, res) => {
    if (!checkRetrieverAdminAuth(req, res)) return;

    if (VECTOR_STORE_REBUILD_LOCK) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.write(JSON.stringify({ error: "rebuild_in_progress" }) + "\n");
      return res.end();
    }

    VECTOR_STORE_REBUILD_LOCK = true;
    const startMs = Date.now();
    // audit: started
    try {
      const header = req.get("authorization") || req.get("Authorization") || "";
      const approver =
        header && header.startsWith("Bearer ") ? "admin" : "system";
      await appendVectorRebuildAudit({
        at: new Date().toISOString(),
        approver,
        action: "vector_rebuild",
        status: "started",
        dir:
          process.env.VECTOR_STORE_DIR ||
          path.join(__dirname, "..", "..", "tools", "vector_store"),
      });
    } catch (e) {}

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const retrieverIndex = require("../tools/retriever-index");
      const vsModule = require("../tools/vector-store");
      const createStore =
        vsModule && vsModule.createStore ? vsModule.createStore : null;
      if (!createStore) {
        res.write(JSON.stringify({ error: "no_vector_store_adapter" }) + "\n");
        VECTOR_STORE_REBUILD_LOCK = false;
        return res.end();
      }

      const storeDir =
        process.env.VECTOR_STORE_DIR ||
        path.join(__dirname, "..", "..", "tools", "vector_store");
      const store = createStore({ dir: storeDir });
      await store.init();
      await store.load();

      const idx = retrieverIndex.loadIndexSync();
      const entries = Array.isArray(idx.entries) ? idx.entries : [];
      const total = entries.length;
      let processed = 0;
      let added = 0;
      const reportEvery = Number(
        process.env.VECTOR_REBUILD_REPORT_EVERY || 100,
      );

      // stream initial status
      res.write(JSON.stringify({ progress: { total } }) + "\n");

      for (const e of entries) {
        if (!e || !Array.isArray(e.embedding) || !e.embedding.length) {
          processed += 1;
          if (processed % reportEvery === 0) {
            res.write(
              JSON.stringify({ progress: { processed, added } }) + "\n",
            );
          }
          continue;
        }
        try {
          await store.add(e.id, e.embedding, { path: e.path });
          added += 1;
        } catch (err) {
          // ignore individual add failures but report
          res.write(JSON.stringify({ warn: String(err) }) + "\n");
        }
        processed += 1;
        if (processed % reportEvery === 0) {
          res.write(JSON.stringify({ progress: { processed, added } }) + "\n");
        }
      }

      // attempt to build index and save
      try {
        if (typeof store.buildIndex === "function") await store.buildIndex();
      } catch (e) {
        res.write(
          JSON.stringify({
            warn: "build_index_failed",
            error: (e && e.message) || String(e),
          }) + "\n",
        );
      }
      try {
        if (typeof store.save === "function") await store.save();
      } catch (e) {
        res.write(
          JSON.stringify({
            warn: "save_failed",
            error: (e && e.message) || String(e),
          }) + "\n",
        );
      }

      const cnt = (await store.count().catch(() => 0)) || 0;
      const metaFile = path.join(storeDir, "vector_store_meta.json");
      try {
        await fs.promises.mkdir(storeDir, { recursive: true });
      } catch (e) {}
      try {
        const metaObj = {
          lastBuilt: new Date().toISOString(),
          added,
          count: cnt,
        };
        await fs.promises.writeFile(
          metaFile,
          JSON.stringify(metaObj, null, 2),
          "utf8",
        );
        res.write(
          JSON.stringify({
            done: true,
            entries: cnt,
            added,
            lastBuilt: metaObj.lastBuilt,
          }) + "\n",
        );
      } catch (e) {
        res.write(
          JSON.stringify({
            done: true,
            entries: cnt,
            added,
            error: (e && e.message) || String(e),
          }) + "\n",
        );
      }

      // final flush
      const duration = Date.now() - startMs;
      res.write(
        JSON.stringify({
          summary: { durationMs: duration, added, count: cnt },
        }) + "\n",
      );

      // audit: done
      try {
        const header =
          req.get("authorization") || req.get("Authorization") || "";
        const approver =
          header && header.startsWith("Bearer ") ? "admin" : "system";
        await appendVectorRebuildAudit({
          at: new Date().toISOString(),
          approver,
          action: "vector_rebuild",
          status: "done",
          dir: storeDir,
          added,
          count: cnt,
          durationMs: duration,
        });
      } catch (e) {}

      return res.end();
    } catch (e) {
      try {
        res.write(
          JSON.stringify({ error: (e && e.message) || String(e) }) + "\n",
        );
      } catch (er) {}
      try {
        res.end();
      } catch (er) {}

      // audit: failed
      try {
        const header =
          req.get("authorization") || req.get("Authorization") || "";
        const approver =
          header && header.startsWith("Bearer ") ? "admin" : "system";
        await appendVectorRebuildAudit({
          at: new Date().toISOString(),
          approver,
          action: "vector_rebuild",
          status: "failed",
          dir:
            process.env.VECTOR_STORE_DIR ||
            path.join(__dirname, "..", "..", "tools", "vector_store"),
          error: (e && e.message) || String(e),
        });
      } catch (er) {}
    } finally {
      VECTOR_STORE_REBUILD_LOCK = false;
    }
  });
}

const retrieverAdminCapability = {
  key: KEY,
  registerRoutes: registerRetrieverAdminRoutes,
  getHealth: (context = {}) => {
    return {
      status: "configured",
      configured: true,
      message:
        "Retriever admin routes are available (rebuild, search, embeddings, vector store).",
    };
  },
};

module.exports = {
  registerRetrieverAdminRoutes,
  retrieverAdminCapability,
};
