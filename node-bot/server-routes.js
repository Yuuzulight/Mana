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
const { readGgufMetadata } = require("./tools/gguf-metadata");

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
  const { modelManagement, readGgufMetadata: activeReadGgufMetadata } = deps;

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
}

module.exports = {
  registerCoreRoutes,
  isLocalRestartRequest,
  registerModelRoutes,
};
