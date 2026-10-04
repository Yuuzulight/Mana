const { registerChatRoutes } = require('./routes/chat');
const { registerSpeechRoutes } = require('./routes/speech');
const fs = require("fs");
const path = require("path");
const {
  ValidationError,
  optionalString,
  requireFile,
  requireString,
  sendValidationError,
} = require("./request-validation");
const { ADMIN_KEY_REQUIRED_ERROR, hasAdminKey, isLocalRestartRequest } = require("./admin-key");
const { readGgufMetadata } = require("./tools/gguf-metadata");
const { createZedIntegration } = require("./zed-integration");
const Diff = require("diff");
const { pendingWritesDir } = require("./utils/live-dirs");

const RESTART_LOCAL_ONLY_ERROR = "restart is only available from this PC";

// #670: local is no longer enough for admin routes -- see admin-key.js.
function isLocalAdminRequest(req) {
  return isLocalRestartRequest(req) && hasAdminKey(req, { local: true });
}

function hasRestartController(restartController) {
  return (
    restartController &&
    typeof restartController.buildAcceptedPayload === "function" &&
    typeof restartController.scheduleRestart === "function"
  );
}

function scheduleRestartAfterFinish(res, restartController) {
  res.once("finish", () => restartController.scheduleRestart());
}

function registerCoreRoutes(app, upload, deps) {
  const {
    restartController, currentGame = () => null, characters = null,
    buildGroupReaction = null, moodStore = null, getScreenOcrWorker = null,
  } = deps;
  const context = {
    ...deps, app, upload, currentGame, characters, buildGroupReaction,
    moodStore, getScreenOcrWorker, hasRestartController, scheduleRestartAfterFinish,
  };
  const chatRoutes = registerChatRoutes(context);
  registerSpeechRoutes({ ...context, warnIfSessionless: chatRoutes.warnIfSessionless });

  app.post("/admin/restart", (req, res) => {
    if (!hasRestartController(restartController)) {
      return res.status(500).json({ error: "restart controller is not configured" });
    }
    if (!isLocalRestartRequest(req)) {
      return res.status(403).json({ error: RESTART_LOCAL_ONLY_ERROR });
    }
    if (!isLocalAdminRequest(req)) {
      return res.status(403).json({ error: ADMIN_KEY_REQUIRED_ERROR });
    }

    const payload = restartController.buildAcceptedPayload();
    scheduleRestartAfterFinish(res, restartController);
    return res.json(payload);
  });
}

// Issue #500: the 9 /models/* routes moved verbatim out of server.js's
// registerRoutes() (skipping /browser-automation/activity and
// /persona/override* -- unrelated features that just happened to sit
// physically between these in the original file). modelManagement is a
// single stateful instance created once back in server.js
// (deps.modelManagement || createModelManagement(...)) and passed through
// by reference, not recreated -- routes here read/write the same object
// server.js itself holds. readGgufMetadata's own deps-override
// (deps.readGgufMetadata || readGgufMetadata) is resolved once and passed
// through the same way, mirroring the original's activeReadGgufMetadata.
// isLocalRestartRequest doesn't need to be a dependency -- it's already
// defined earlier in this same file.
function registerModelRoutes(app, deps) {
  const { modelManagement, readGgufMetadata: activeReadGgufMetadata, llamaBuilds, checkAdminAuth } = deps;

  // #693: llama.cpp build status/check/update/rollback. Admin-gated
  // (checkAdminAuth) and local-only like /models/brain-provider/test:
  // check and update make outbound requests, and update runs the
  // executable it downloaded.
  function allowLlamaBuildRequest(req, res) {
    if (!checkAdminAuth(req, res)) return false;
    if (!isLocalRestartRequest(req)) {
      res.status(403).json({ error: "this endpoint is only available from this PC" });
      return false;
    }
    if (!isLocalAdminRequest(req)) {
      res.status(403).json({ error: ADMIN_KEY_REQUIRED_ERROR });
      return false;
    }
    return true;
  }

  function sendLlamaBuildError(res, error) {
    const status = ["busy", "digest_missing", "exists", "up_to_date"].includes(error.code) ? 409 : 400;
    return res.status(status).json({ error: error.message, code: error.code || null });
  }

  app.get("/models/llama-build", (req, res) => {
    if (!allowLlamaBuildRequest(req, res)) return;
    return res.json(llamaBuilds.getStatus());
  });

  app.post("/models/llama-build/check", async (req, res) => {
    if (!allowLlamaBuildRequest(req, res)) return;
    try {
      return res.json(await llamaBuilds.check());
    } catch (error) {
      return sendLlamaBuildError(res, error);
    }
  });

  // 202: the download/extract/smoke test runs in the background (hundreds
  // of MB); GET /models/llama-build's `job` reports progress. A release
  // without a published SHA-256 is refused (409 digest_missing) unless the
  // user explicitly confirmed with allowMissingDigest: true.
  app.post("/models/llama-build/update", async (req, res) => {
    if (!allowLlamaBuildRequest(req, res)) return;
    try {
      return res.status(202).json(
        await llamaBuilds.startUpdate({ allowMissingDigest: req.body?.allowMissingDigest === true }),
      );
    } catch (error) {
      return sendLlamaBuildError(res, error);
    }
  });

  app.post("/models/llama-build/rollback", (req, res) => {
    if (!allowLlamaBuildRequest(req, res)) return;
    try {
      return res.json(llamaBuilds.rollback());
    } catch (error) {
      return sendLlamaBuildError(res, error);
    }
  });

  app.get("/models/status", (req, res) => {
    return res.json(modelManagement.getModelStatus());
  });

  // Issue #196: separate from /models/status (polled frequently) on
  // purpose -- real GGUF header parsing is real file I/O, not something to
  // add to a hot poll path. Called on-demand when a user actually wants to
  // see a model's real metadata instead of just its filename. Reuses the
  // same magic-byte gate setModelPath()/setVisionSettings() already use
  // before ever trusting a path is a real GGUF file.
  app.get("/models/gguf-metadata", async (req, res) => {
    const filePath = String(req.query?.path || "");
    if (!filePath || !modelManagement.isValidGgufFile(filePath)) {
      return res.status(400).json({ error: "path must point to a valid GGUF file" });
    }
    const metadata = await activeReadGgufMetadata(filePath);
    if (!metadata) {
      return res.status(422).json({ error: "could not parse GGUF metadata for this file" });
    }
    return res.json(metadata);
  });

  app.post("/models/active-profile", (req, res) => {
    try {
      return res.json(modelManagement.setActiveProfile(req.body?.profile));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Full-storage scan for .gguf files (issue #123 install flow): best-effort,
  // time/dir-capped -- see scanForGgufFiles in model-management.js. Optional
  // body.roots lets the desktop client scope it (e.g. just a chosen drive)
  // instead of the default home-dir + every drive letter.
  app.post("/models/scan", (req, res) => {
    try {
      const roots = Array.isArray(req.body?.roots) ? req.body.roots : undefined;
      return res.json(modelManagement.scanForModels(roots));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Explicitly select (or clear, with modelPath: null/"") which local .gguf
  // file to use, from either a scan result or a manual file browse.
  app.post("/models/path", (req, res) => {
    try {
      return res.json(modelManagement.setModelPath(req.body?.modelPath));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Switch Mana's brain between local (llama-server + a GGUF) and any
  // OpenAI-compatible endpoint. apiKey is write-only from here on out --
  // /models/status never echoes it back (see model-management.js).
  app.post("/models/brain-provider", (req, res) => {
    try {
      return res.json(
        modelManagement.setBrainSettings({
          type: req.body?.type,
          baseUrl: req.body?.baseUrl,
          apiKey: req.body?.apiKey,
          model: req.body?.model,
        }),
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Presets for the brain-provider dropdown (Settings' "Use Remote AI" UI).
  app.get("/models/brain-providers", (req, res) => {
    return res.json(modelManagement.getKnownBrainProviders());
  });

  // "Connect" button: tests reachability/auth against baseUrl before saving.
  // Local-only (same isLocalRestartRequest check as /admin/restart): this is
  // the one /models/* route that makes node-bot issue an outbound request to
  // a user-supplied URL, and node-bot listens on all interfaces with CORS
  // wide open, so an unrestricted version of this route would let anyone who
  // can reach this machine's port make it probe arbitrary hosts (SSRF). The
  // fix is restricting *who can call it*, not the destination -- the whole
  // point of this button is testing local/LAN endpoints (Ollama, LM
  // Studio), so blocking private addresses would defeat the feature.
  app.post("/models/brain-provider/test", async (req, res) => {
    if (!isLocalRestartRequest(req)) {
      return res.status(403).json({ error: "this endpoint is only available from this PC" });
    }
    if (!isLocalAdminRequest(req)) {
      return res.status(403).json({ error: ADMIN_KEY_REQUIRED_ERROR });
    }
    const result = await modelManagement.testBrainConnection({
      baseUrl: req.body?.baseUrl,
      apiKey: req.body?.apiKey,
    });
    return res.json(result);
  });

  // Vision GGUF + mmproj override ("" clears back to auto-detection).
  app.post("/models/vision-path", (req, res) => {
    try {
      return res.json(
        modelManagement.setVisionSettings({
          modelPath: req.body?.modelPath,
          mmprojPath: req.body?.mmprojPath,
        }),
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Saves whether llama-server loads the model straight into VRAM (read back as
  // /models/status's loadIntoVram). Admin-gated: it changes launch args.
  app.post("/models/load-into-vram", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      return res.json(modelManagement.setLoadIntoVram(req.body?.loadIntoVram));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
}

// Issue #500: each of these just serves a static admin HTML file from
// ./admin/ -- collapsed from 5 copy-pasted try/fs.existsSync/sendFile
// blocks in server.js into one shared handler plus a route/file/label
// table, rather than moved over unchanged.
const ADMIN_STATIC_FILES = [
  { route: "/admin/token-cache-ui", file: "token_cache_ui.html", label: "admin UI" },
  { route: "/admin/background-memory-ui", file: "background_memory_ui.html", label: "admin UI" },
  { route: "/admin/accounts-ui", file: "accounts_ui.html", label: "admin UI" },
  { route: "/admin/plugins-ui", file: "plugins_ui.html", label: "plugin UI" },
  { route: "/admin/plugins/install", file: "plugins_install.html", label: "plugin install UI" },
];

function registerAdminStaticRoutes(app) {
  for (const { route, file, label } of ADMIN_STATIC_FILES) {
    app.get(route, (req, res) => {
      try {
        const f = path.join(__dirname, "admin", file);
        if (!fs.existsSync(f)) return res.status(404).send("not found");
        return res.sendFile(f);
      } catch (e) {
        console.error(`Failed to serve ${label} file:`, e);
        return res.status(500).send("internal error");
      }
    });
  }
}

// Issue #500: moved verbatim out of server.js's registerRoutes(). Takes
// checkAdminAuth and getEditorIntegrations as dependencies rather than
// redefining them here -- getEditorIntegrations in particular is a
// memoizing closure back in server.js (over its own `editorIntegrations`
// let and deps.editors override); passing the same function reference
// through preserves that memoization exactly instead of creating a second,
// independent instance. deps.zed (an optional override, same as the
// original inline `deps.zed || createZedIntegration()`) is passed as a
// plain value since the original never memoized it either.
function registerEditorRoutes(app, deps) {
  const { checkAdminAuth, getEditorIntegrations, zed: zedOverride, reviewEdit } = deps;

  app.get("/zed/status", (req, res) => {
    const zed = zedOverride || createZedIntegration();
    return res.json(zed.getStatus());
  });

  app.post("/zed/open", async (req, res) => {
    // Opens an arbitrary local path in an editor -- CORS is wide open
    // app-wide, so without this any site the user has loaded in a browser
    // tab could otherwise trigger it via a background fetch().
    if (!checkAdminAuth(req, res)) return;
    try {
      const zed = zedOverride || createZedIntegration();
      const result = await zed.open({
        targetPath: req.body?.path,
        line: req.body?.line,
        column: req.body?.column,
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({
        opened: false,
        error: error.message,
      });
    }
  });

  app.get("/editors/status", (req, res) => {
    const editors = getEditorIntegrations();
    return res.json(editors.getStatus());
  });

  app.post("/editors/open", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      const result = await editors.open({
        editor: req.body?.editor,
        targetPath: req.body?.path,
        line: req.body?.line,
        column: req.body?.column,
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({
        opened: false,
        error: error.message,
      });
    }
  });

  app.get("/editors/workspace", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const editors = getEditorIntegrations();
    return res.json({ workspace: editors.getWorkspace() });
  });

  app.post("/editors/workspace", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      const workspace = editors.setWorkspace(req.body?.path, {
        editor: req.body?.editor,
        reason: "manual",
      });
      return res.json({ workspace });
    } catch (error) {
      return res.status(400).json({
        workspace: null,
        error: error.message,
      });
    }
  });

  app.get("/editors/workspace/files", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      return res.json(editors.listWorkspaceFiles());
    } catch (error) {
      return res.status(400).json({
        files: [],
        error: error.message,
      });
    }
  });

  app.get("/editors/workspace/file", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      const filePath = typeof req.query.path === "string" ? req.query.path : "";
      return res.json(editors.readWorkspaceFile(filePath));
    } catch (error) {
      return res.status(400).json({
        content: "",
        error: error.message,
      });
    }
  });

  // #838: review only, for the ACP agent's file_write (Pipeline B writes
  // straight to disk, not through a proposal). That process has no model,
  // so it asks here; the review runs on whatever model is already loaded.
  // {review: null} when it didn't run (off, not a source file, no model).
  app.post("/editors/review", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const relativePath = requireString(req.body?.path, "path");
      const before = typeof req.body?.before === "string" ? req.body.before : "";
      const after = requireString(req.body?.after, "after");
      const diff = Diff.createTwoFilesPatch(relativePath, relativePath, before, after);
      const review = reviewEdit
        ? await reviewEdit({ relativePath, diff, summary: optionalString(req.body?.summary, "summary", "") })
        : null;
      return res.json({ review });
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      return res.status(500).json({ review: null, error: String(e) });
    }
  });

  app.get("/editors/workspace/proposals", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const editors = getEditorIntegrations();
    return res.json({ proposals: editors.listEditProposals() });
  });

  app.post("/editors/workspace/proposals", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      const proposal = editors.createEditProposal({
        path: req.body?.path,
        proposedContent: req.body?.proposedContent,
        summary: req.body?.summary,
      });
      // Issue #622: the ACP agent's proposals come in here -- review them
      // before they sit waiting for approval.
      if (reviewEdit) proposal.adversarialReview = await reviewEdit(proposal);
      return res.json({ proposal });
    } catch (error) {
      return res.status(400).json({
        proposal: null,
        error: error.message,
      });
    }
  });

  app.get("/editors/workspace/proposals/:id", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      return res.json({ proposal: editors.getEditProposal(req.params.id) });
    } catch (error) {
      return res.status(404).json({
        proposal: null,
        error: error.message,
      });
    }
  });

  app.post("/editors/workspace/proposals/:id/approve", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      // Issue #427: omitted acceptedHunkIds approves every hunk, unchanged
      // from before hunk-level review existed.
      return res.json({
        proposal: editors.approveEditProposal(req.params.id, {
          acceptedHunkIds: req.body?.acceptedHunkIds,
          // Q16: required to apply an edit the adversarial review refuted.
          confirmRefuted: req.body?.confirmRefuted === true,
        }),
      });
    } catch (error) {
      return res.status(400).json({
        proposal: null,
        error: error.message,
      });
    }
  });

  // Issue #428: restorable snapshots of applied edits, independent of git.
  app.get("/editors/workspace/snapshots", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const editors = getEditorIntegrations();
    return res.json({ snapshots: editors.listEditSnapshots() });
  });

  app.post("/editors/workspace/snapshots/:id/restore", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      const confirmStale = Boolean(req.body && req.body.confirmStale);
      const restored = await editors.restoreEditSnapshot(req.params.id, { confirmStale });
      // #475 whole-branch review fix: {stale: true, ...} is truthy, so a
      // plain 200 here made both renderer UIs' `if (!result.restored) throw`
      // check read a stale, unconfirmed restore as a success -- nothing was
      // actually restored, but the UI reported it worked. 409 (plus a null
      // `restored`) routes into that same existing error branch instead of
      // requiring any renderer change.
      if (restored && restored.stale) {
        return res.status(409).json({
          restored: null,
          stale: restored,
          error: "snapshot is stale: target has been written to again since it was recorded",
        });
      }
      return res.json({ restored });
    } catch (error) {
      return res.status(400).json({
        restored: null,
        error: error.message,
      });
    }
  });
}

// Issue #500: moved verbatim out of server.js's registerRoutes(). Takes
// checkAdminAuth as a dependency (deps.checkAdminAuth) rather than
// redefining it here -- it closes over ADMIN_SECRET back in server.js and
// duplicating that closure would risk the two copies drifting apart.
function registerPendingWritesRoutes(app, deps) {
  const { checkAdminAuth } = deps;

  // Pending-write ids come straight from the URL (:id) into path.join()
  // below; without this check "../../whatever" would let an admin-auth'd
  // request read/write/delete files outside the pending-writes dir.
  function isSafePendingWriteId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
  }

  app.get("/admin/pending-writes", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      await fs.promises.mkdir(pendingWritesDir(), { recursive: true });
      const files = await fs.promises.readdir(pendingWritesDir());
      const pending = [];
      for (const f of files) {
        if (
          f.endsWith(".json") &&
          !f.endsWith(".approved.json") &&
          !f.endsWith(".rejected.json")
        ) {
          const id = f.replace(/\.json$/i, "");
          const base = path.join(pendingWritesDir(), id);
          const pendingPath = `${base}.json`;
          let payload = null;
          try {
            payload = JSON.parse(
              await fs.promises.readFile(pendingPath, "utf8"),
            );
          } catch (e) {
            payload = null;
          }
          const approved = fs.existsSync(`${base}.approved.json`);
          const rejected = fs.existsSync(`${base}.rejected.json`);
          pending.push({ id, payload, approved, rejected });
        }
      }
      return res.json({ ok: true, pending });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/pending-writes/:id/approve", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const id = req.params.id;
      if (!isSafePendingWriteId(id)) {
        return res.status(400).json({ ok: false, error: "invalid id" });
      }
      const base = path.join(pendingWritesDir(), id);
      const approvedPath = `${base}.approved.json`;
      const data = {
        approver: req.body?.approver || "local-user",
        at: new Date().toISOString(),
        note: req.body?.note || null,
      };
      await fs.promises.mkdir(pendingWritesDir(), { recursive: true });
      await fs.promises.writeFile(
        approvedPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
      // #838: the marker is all this route writes. The waiting loop
      // (acp-autonomous-loop.js's waitForApprovalResult) polls for it and
      // archives the request itself once it has read the decision --
      // archiving here deleted the marker before the loop could see it,
      // so every approval from outside timed out.

      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/pending-writes/:id/reject", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const id = req.params.id;
      if (!isSafePendingWriteId(id)) {
        return res.status(400).json({ ok: false, error: "invalid id" });
      }
      const base = path.join(pendingWritesDir(), id);
      const rejectedPath = `${base}.rejected.json`;
      const data = {
        approver: req.body?.approver || "local-user",
        at: new Date().toISOString(),
        reason: req.body?.reason || null,
      };
      await fs.promises.mkdir(pendingWritesDir(), { recursive: true });
      await fs.promises.writeFile(
        rejectedPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
      // #838: the marker is all this route writes. The waiting loop
      // (acp-autonomous-loop.js's waitForApprovalResult) polls for it and
      // archives the request itself once it has read the decision --
      // archiving here deleted the marker before the loop could see it,
      // so every approval from outside timed out.

      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  registerCoreRoutes,
  isLocalRestartRequest,
  isLocalAdminRequest,
  registerModelRoutes,
  registerEditorRoutes,
  registerAdminStaticRoutes,
  registerPendingWritesRoutes,
};
