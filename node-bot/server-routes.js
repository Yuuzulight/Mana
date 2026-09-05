const fs = require("fs");
const path = require("path");
const {
  ValidationError,
  optionalString,
  requireFile,
  requireString,
  sendValidationError,
} = require("./request-validation");
const {
  getRequestAddress,
  isLoopbackAddress,
  isRestartCommand,
} = require("./admin-restart");
const { createZedIntegration } = require("./zed-integration");

const RESTART_LOCAL_ONLY_ERROR = "restart is only available from this PC";

function getSocketAddress(req) {
  return req?.socket?.remoteAddress || "";
}

function getFirstForwardedAddress(req) {
  const forwardedFor =
    typeof req.get === "function"
      ? req.get("x-forwarded-for")
      : req?.headers?.["x-forwarded-for"];
  const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return String(value || "")
    .split(",")[0]
    .trim();
}

// Loopback-only, and if a proxy claims the socket is loopback (e.g. a
// LAN tunnel terminating on the same box), an X-Forwarded-For header
// pointing elsewhere still disqualifies the request.
function isLocalRestartRequest(req) {
  const socketAddress = getSocketAddress(req);
  const requestAddress = getRequestAddress(req);
  const forwardedAddress = getFirstForwardedAddress(req);
  return (
    isLoopbackAddress(socketAddress || requestAddress) &&
    (!forwardedAddress || isLoopbackAddress(forwardedAddress))
  );
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
    UNIVERSALIS_DEFAULT_WORLD,
    TTS_PROVIDER,
    buildAssistantReply,
    capabilities,
    contributePluginPromptContext,
    cleanupUploadedAudio,
    clampInteger,
    fs,
    getActiveModelProfile,
    marketDataClient,
    jobApplicationsStore,
    pluginSettingsStore,
    normalizeLlamaModelProfile,
    normalizeUploadedAudio,
    readScreenText,
    recordChatTurn,
    restartController,
    runVisionReply,
    getVisionStatus,
    resolveVisionCapture,
    rejectVisionCapture,
    runWhisper,
    runWhisperPartial,
    normalizeUploadedAudioAsync,
    synthesizeReply,
    clampText,
    SCREEN_CONTEXT_MAX_CHARS,
  } = deps;

  app.post("/admin/restart", (req, res) => {
    if (!hasRestartController(restartController)) {
      return res.status(500).json({ error: "restart controller is not configured" });
    }
    if (!isLocalRestartRequest(req)) {
      return res.status(403).json({ error: RESTART_LOCAL_ONLY_ERROR });
    }

    const payload = restartController.buildAcceptedPayload();
    scheduleRestartAfterFinish(res, restartController);
    return res.json(payload);
  });

  app.post("/transcribe-only", upload.single("file"), async (req, res) => {
    try {
      requireFile(req.file, "file");

      const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);
      const transcript = runWhisper(audioPath);
      cleanupUploadedAudio(tmpPath, audioPath);

      return res.json({ transcript });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/transcribe-partial", upload.single("file"), async (req, res) => {
    let tmpPath, audioPath;
    try {
      requireFile(req.file, "file");

      ({ tmpPath, audioPath } = await normalizeUploadedAudioAsync(req.file));
      const transcript = await runWhisperPartial(audioPath);

      return res.json({ transcript });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    } finally {
      // Cleanup must run whether runWhisperPartial succeeded or threw --
      // this endpoint is polled repeatedly per recording, so a leaked
      // upload on every failed poll compounds far faster than
      // /transcribe-only's one-shot equivalent.
      if (tmpPath || audioPath) {
        cleanupUploadedAudio(tmpPath, audioPath);
      }
    }
  });

  app.post("/screen/read", async (req, res) => {
    try {
      const image = typeof req.body?.image === "string" ? req.body.image : "";
      if (!image) {
        return res.status(400).json({ error: "no screen image" });
      }

      const text = await readScreenText(image);
      return res.json({ text });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // /market/stock/* and /market/watchlist now live in
  // plugins/stock-market/index.js, registered via the capabilities array
  // (see server.js). marketDataClient stays in this file's deps because
  // /reply and /transcribe below pass it through to
  // contributePluginPromptContext (issue #108) for stock market prompt
  // context.

  app.post("/vision/describe", async (req, res) => {
    try {
      const image = requireString(req.body?.image, "image");
      const prompt = optionalString(req.body?.prompt, "prompt", "");
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);

      if (typeof getVisionStatus === "function") {
        const vision = getVisionStatus();
        if (!vision || !vision.available) {
          return res.status(503).json({
            error: "no local vision model available",
            detail: vision ? vision.reason : undefined,
          });
        }
      }

      const reply = await runVisionReply(prompt, [image]);
      if (sessionId && typeof recordChatTurn === "function") {
        recordChatTurn(sessionId, prompt || "(shared an image)", reply);
      }
      return res.json({
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/vision/capture-result", (req, res) => {
    try {
      const requestId = requireString(req.body?.requestId, "requestId");
      // Issue #417 finding 3: the client posts either a captured image or,
      // when capture itself failed client-side (e.g. denied permission
      // prompt), an error -- never both, never neither. Either/or is
      // validated explicitly rather than just making both fields optional,
      // so a malformed body gets a clean 400 instead of silently resolving
      // the pending requestCapture() promise with an empty image.
      const error = optionalString(req.body?.error, "error", "");
      const image = optionalString(req.body?.image, "image", "");
      if (error && image) {
        throw new ValidationError("provide either image or error, not both");
      }
      if (error) {
        const rejected = rejectVisionCapture(requestId, error);
        return res.json({ ok: rejected });
      }
      if (!image) {
        throw new ValidationError("image is required");
      }
      const resolved = resolveVisionCapture(requestId, image);
      return res.json({ ok: resolved });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/reply", async (req, res) => {
    try {
      // An attached image routes the reply through the local vision model;
      // text becomes optional because the image can carry the question.
      const image =
        typeof req.body?.image === "string" && req.body.image.trim()
          ? req.body.image.trim()
          : null;
      const transcript = image
        ? optionalString(req.body?.text, "text", "")
        : requireString(req.body?.text, "text");

      if (isRestartCommand(transcript)) {
        if (!hasRestartController(restartController)) {
          return res.status(500).json({ error: "restart controller is not configured" });
        }

        const payload = restartController.buildAcceptedPayload();
        scheduleRestartAfterFinish(res, restartController);
        return res.json({
          reply: payload.message,
          restart: payload,
          ttsConfigured: false,
        });
      }

      if (image) {
        const sessionId = optionalString(
          req.body?.sessionId,
          "sessionId",
          null,
        );
        if (typeof getVisionStatus === "function") {
          const vision = getVisionStatus();
          if (!vision || !vision.available) {
            return res.status(503).json({
              error: "no local vision model available",
              detail: vision ? vision.reason : undefined,
            });
          }
        }
        const reply = await runVisionReply(transcript, [image]);
        if (sessionId && typeof recordChatTurn === "function") {
          recordChatTurn(sessionId, transcript || "(shared an image)", reply);
        }
        return res.json({
          reply,
          ttsConfigured: TTS_PROVIDER !== "none",
        });
      }
      const screenText = clampText(
        optionalString(req.body?.screenText, "screenText", ""),
        SCREEN_CONTEXT_MAX_CHARS,
      );
      const hasModelProfile = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "modelProfile",
      );
      const modelProfile = hasModelProfile
        ? normalizeLlamaModelProfile(req.body?.modelProfile)
        : normalizeLlamaModelProfile(
            typeof getActiveModelProfile === "function"
              ? getActiveModelProfile()
              : "default",
          );
      const includeContext = req.body?.includeContext !== false;
      const world = optionalString(
        req.body?.ffxivWorld,
        "ffxivWorld",
        UNIVERSALIS_DEFAULT_WORLD,
      );
      // Tries each plugin's contributePromptContext in capabilities-array
      // order, first non-empty result wins (issue #108) -- each plugin's own
      // builder decides relevance, this just picks the first that answers.
      const marketText = includeContext
        ? await contributePluginPromptContext(capabilities, transcript, {
            marketDataClient,
            jobApplicationsStore,
            pluginSettingsStore,
            world,
            screenText,
          })
        : "";
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const assistantMode = optionalString(
        req.body?.assistantMode,
        "assistantMode",
        null,
      );
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      const replyMeta = {};
      const reply = await buildAssistantReply(
        transcript,
        screenText,
        marketText,
        modelProfile,
        sessionId,
        assistantMode,
        presetId,
        replyMeta,
      );
      return res.json({
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
        ...(replyMeta.expression ? { expression: replyMeta.expression } : {}),
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/reply/stream", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const writeEvent = (event) => res.write(JSON.stringify(event) + "\n");

    try {
      const image =
        typeof req.body?.image === "string" && req.body.image.trim()
          ? req.body.image.trim()
          : null;
      // Issue #450: the clip-review hotkey sends several frames at once
      // instead of one -- runVisionReply already accepts an array, so this
      // is just accepting the plural shape too. Falls back to the single
      // `image` as a 1-item array when `images` isn't sent.
      const images = Array.isArray(req.body?.images)
        ? req.body.images
            .filter((img) => typeof img === "string" && img.trim())
            .map((img) => img.trim())
        : image
          ? [image]
          : [];
      const transcript = images.length
        ? optionalString(req.body?.text, "text", "")
        : requireString(req.body?.text, "text");

      if (isRestartCommand(transcript)) {
        if (!hasRestartController(restartController)) {
          writeEvent({ type: "final", error: "restart controller is not configured" });
          return res.end();
        }
        const payload = restartController.buildAcceptedPayload();
        scheduleRestartAfterFinish(res, restartController);
        writeEvent({
          type: "final",
          reply: payload.message,
          restart: payload,
          ttsConfigured: false,
          changed: true,
        });
        return res.end();
      }

      if (images.length) {
        const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
        if (typeof getVisionStatus === "function") {
          const vision = getVisionStatus();
          if (!vision || !vision.available) {
            writeEvent({
              type: "final",
              error: "no local vision model available",
              detail: vision ? vision.reason : undefined,
            });
            return res.end();
          }
        }
        const reply = await runVisionReply(transcript, images);
        if (sessionId && typeof recordChatTurn === "function") {
          recordChatTurn(sessionId, transcript || "(shared an image)", reply);
        }
        writeEvent({
          type: "final",
          reply,
          ttsConfigured: TTS_PROVIDER !== "none",
          changed: true,
        });
        return res.end();
      }

      const screenText = clampText(
        optionalString(req.body?.screenText, "screenText", ""),
        SCREEN_CONTEXT_MAX_CHARS,
      );
      const hasModelProfile = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "modelProfile",
      );
      const modelProfile = hasModelProfile
        ? normalizeLlamaModelProfile(req.body?.modelProfile)
        : normalizeLlamaModelProfile(
            typeof getActiveModelProfile === "function"
              ? getActiveModelProfile()
              : "default",
          );
      const includeContext = req.body?.includeContext !== false;
      const world = optionalString(
        req.body?.ffxivWorld,
        "ffxivWorld",
        UNIVERSALIS_DEFAULT_WORLD,
      );
      const marketText = includeContext
        ? await contributePluginPromptContext(capabilities, transcript, {
            marketDataClient,
            jobApplicationsStore,
            pluginSettingsStore,
            world,
            screenText,
          })
        : "";
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const assistantMode = optionalString(req.body?.assistantMode, "assistantMode", null);
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      const replyMeta = {};

      const reply = await buildAssistantReply(
        transcript,
        screenText,
        marketText,
        modelProfile,
        sessionId,
        assistantMode,
        presetId,
        replyMeta,
        (sentence) => writeEvent({ type: "sentence", text: sentence }),
      );

      writeEvent({
        type: "final",
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
        changed: !replyMeta.streamedMatchesFinal,
        ...(replyMeta.expression ? { expression: replyMeta.expression } : {}),
      });
      return res.end();
    } catch (e) {
      if (e instanceof ValidationError) {
        writeEvent({ type: "final", error: e.message });
        return res.end();
      }
      console.error(e);
      writeEvent({ type: "final", error: String(e) });
      return res.end();
    }
  });

  app.post("/transcribe", upload.single("file"), async (req, res) => {
    try {
      requireFile(req.file, "file");
      console.log("Got file upload:", req.file);
      const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);

      console.log(
        "audioPath ->",
        audioPath,
        "exists=",
        fs.existsSync(audioPath),
        "size=",
        fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0,
      );
      const transcript = runWhisper(audioPath);

      // Same generic plugin prompt-context chain /reply uses (issue #108).
      // No screenText/ffxivWorld here since /transcribe has no OCR or
      // per-request world override -- UNIVERSALIS_DEFAULT_WORLD covers it.
      const marketText = await contributePluginPromptContext(
        capabilities,
        transcript,
        {
          marketDataClient,
          jobApplicationsStore,
          pluginSettingsStore,
          world: UNIVERSALIS_DEFAULT_WORLD,
          screenText: "",
        },
      );
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const assistantMode = optionalString(
        req.body?.assistantMode,
        "assistantMode",
        null,
      );
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      const replyMeta = {};
      const reply = await buildAssistantReply(
        transcript,
        "",
        marketText,
        "default",
        sessionId,
        assistantMode,
        presetId,
        replyMeta,
      );
      cleanupUploadedAudio(tmpPath, audioPath);

      return res.json({
        transcript,
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
        ...(replyMeta.expression ? { expression: replyMeta.expression } : {}),
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/synthesize", async (req, res) => {
    try {
      const text = requireString(req.body?.text, "text");
      if (TTS_PROVIDER === "none") {
        return res.status(400).json({ error: "TTS not configured" });
      }

      const audio = await synthesizeReply(text);
      res.setHeader("Content-Type", "audio/wav");
      return res.send(audio);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
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
  const { checkAdminAuth, getEditorIntegrations, zed: zedOverride } = deps;

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

  app.get("/editors/workspace/proposals", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const editors = getEditorIntegrations();
    return res.json({ proposals: editors.listEditProposals() });
  });

  app.post("/editors/workspace/proposals", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      const proposal = editors.createEditProposal({
        path: req.body?.path,
        proposedContent: req.body?.proposedContent,
        summary: req.body?.summary,
      });
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
  const PENDING_DIR =
    process.env.MANA_PENDING_WRITES_DIR ||
    path.join(__dirname, "data", "pending_writes");

  // Pending-write ids come straight from the URL (:id) into path.join()
  // below; without this check "../../whatever" would let an admin-auth'd
  // request read/write/delete files outside PENDING_DIR.
  function isSafePendingWriteId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
  }

  app.get("/admin/pending-writes", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      await fs.promises.mkdir(PENDING_DIR, { recursive: true });
      const files = await fs.promises.readdir(PENDING_DIR);
      const pending = [];
      for (const f of files) {
        if (
          f.endsWith(".json") &&
          !f.endsWith(".approved.json") &&
          !f.endsWith(".rejected.json")
        ) {
          const id = f.replace(/\.json$/i, "");
          const base = path.join(PENDING_DIR, id);
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
      const base = path.join(PENDING_DIR, id);
      const approvedPath = `${base}.approved.json`;
      const data = {
        approver: req.body?.approver || "local-user",
        at: new Date().toISOString(),
        note: req.body?.note || null,
      };
      await fs.promises.mkdir(PENDING_DIR, { recursive: true });
      await fs.promises.writeFile(
        approvedPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
      // Optionally archive immediately
      try {
        const archiveDir = path.join(PENDING_DIR, "archive");
        await fs.promises.mkdir(archiveDir, { recursive: true });
        const pendingPath = `${base}.json`;
        let pendingPayload = null;
        try {
          pendingPayload = JSON.parse(
            await fs.promises.readFile(pendingPath, "utf8"),
          );
        } catch (e) {
          pendingPayload = null;
        }
        const outPath = path.join(archiveDir, `${id}.approved.json`);
        const archiveObj = {
          id,
          status: "approved",
          pending: pendingPayload,
          action: data,
          archivedAt: new Date().toISOString(),
        };
        await fs.promises.writeFile(
          outPath,
          JSON.stringify(archiveObj, null, 2),
          "utf8",
        );
        // remove originals
        try {
          if (fs.existsSync(pendingPath))
            await fs.promises.unlink(pendingPath);
        } catch (e) {}
        try {
          if (fs.existsSync(approvedPath))
            await fs.promises.unlink(approvedPath);
        } catch (e) {}
      } catch (e) {
        // ignore archive errors
      }

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
      const base = path.join(PENDING_DIR, id);
      const rejectedPath = `${base}.rejected.json`;
      const data = {
        approver: req.body?.approver || "local-user",
        at: new Date().toISOString(),
        reason: req.body?.reason || null,
      };
      await fs.promises.mkdir(PENDING_DIR, { recursive: true });
      await fs.promises.writeFile(
        rejectedPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
      // Optionally archive immediately
      try {
        const archiveDir = path.join(PENDING_DIR, "archive");
        await fs.promises.mkdir(archiveDir, { recursive: true });
        const pendingPath = `${base}.json`;
        let pendingPayload = null;
        try {
          pendingPayload = JSON.parse(
            await fs.promises.readFile(pendingPath, "utf8"),
          );
        } catch (e) {
          pendingPayload = null;
        }
        const outPath = path.join(archiveDir, `${id}.rejected.json`);
        const archiveObj = {
          id,
          status: "rejected",
          pending: pendingPayload,
          action: data,
          archivedAt: new Date().toISOString(),
        };
        await fs.promises.writeFile(
          outPath,
          JSON.stringify(archiveObj, null, 2),
          "utf8",
        );
        // remove originals
        try {
          if (fs.existsSync(pendingPath))
            await fs.promises.unlink(pendingPath);
        } catch (e) {}
        try {
          if (fs.existsSync(rejectedPath))
            await fs.promises.unlink(rejectedPath);
        } catch (e) {}
      } catch (e) {
        // ignore archive errors
      }

      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  registerCoreRoutes,
  isLocalRestartRequest,
  registerEditorRoutes,
  registerAdminStaticRoutes,
  registerPendingWritesRoutes,
};
