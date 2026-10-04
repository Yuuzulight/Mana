const { ValidationError, optionalString, requireFile, requireString, sendValidationError } = require('../request-validation');

function registerSpeechRoutes(context) {
context.app.post("/transcribe-only", context.upload.single("file"), async (req, res) => {
    try {
      requireFile(req.file, "file");

      const { tmpPath, audioPath } = context.normalizeUploadedAudio(req.file);
      const { heard, transcript, model, language } = await context.runWhisperHeard(audioPath);
      context.cleanupUploadedAudio(tmpPath, audioPath);

      // #925: heard (what whisper wrote) only when a mishearing fix
      // changed it, for the launcher's speech-debug.log. #1107: model and
      // language for a kept voice clip's sidecar.
      return res.json({ transcript, ...(heard !== transcript && { heard }), model, language });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

context.app.post("/transcribe-partial", context.upload.single("file"), async (req, res) => {
    let tmpPath, audioPath;
    try {
      requireFile(req.file, "file");

      ({ tmpPath, audioPath } = await context.normalizeUploadedAudioAsync(req.file));
      const transcript = await context.runWhisperPartial(audioPath);

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
        context.cleanupUploadedAudio(tmpPath, audioPath);
      }
    }
  });

context.app.post("/screen/read", async (req, res) => {
    try {
      const image = typeof req.body?.image === "string" ? req.body.image : "";
      if (!image) {
        return res.status(400).json({ error: "no screen image" });
      }

      const text = await context.readScreenText(image);
      return res.json({ text });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

context.app.post("/vision/describe", async (req, res) => {
    try {
      const image = requireString(req.body?.image, "image");
      const prompt = optionalString(req.body?.prompt, "prompt", "");
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      context.warnIfSessionless(sessionId);

      if (typeof context.getVisionStatus === "function") {
        const vision = context.getVisionStatus();
        if (!vision || !vision.available) {
          return res.status(503).json({
            error: "no local vision model available",
            detail: vision ? vision.reason : undefined,
          });
        }
      }

      const reply = await context.runVisionReply(prompt, [image]);
      if (sessionId && typeof context.recordChatTurn === "function") {
        context.recordChatTurn(sessionId, prompt || "(shared an image)", reply);
      }
      return res.json({
        reply,
        ttsConfigured: context.TTS_PROVIDER !== "none",
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

context.app.post("/vision/capture-result", (req, res) => {
    try {
      const requestId = requireString(req.body?.requestId, "requestId");
      // Issue #417 finding 3: the client posts either a captured image or,
      // when capture itself failed client-side (e.g. denied permission
      // prompt), an error -- never both, never neither. Either/or is
      // validated explicitly rather than just making both fields optional,
      // so a malformed body gets a clean 400 instead of silently resolving
      // the pending requestCapture() promise with an empty image.
      // #911: a desktop action's answer is a result object instead.
      const error = optionalString(req.body?.error, "error", "");
      const image = optionalString(req.body?.image, "image", "");
      const result = req.body?.result;
      const isResult = Boolean(result) && typeof result === "object" && !Array.isArray(result);
      if ([error, image, isResult].filter(Boolean).length > 1) {
        throw new ValidationError("provide only one of image, result or error");
      }
      if (error) {
        const rejected = context.rejectVisionCapture(requestId, error);
        return res.json({ ok: rejected });
      }
      if (!image && !isResult) {
        throw new ValidationError("image is required");
      }
      const resolved = context.resolveVisionCapture(requestId, isResult ? result : image);
      return res.json({ ok: resolved });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

context.app.post("/synthesize", async (req, res) => {
    try {
      const rawText = requireString(req.body?.text, "text");
      const text = rawText.replace(/\[\d+\](?:\([^)]*\))?/g, "").trim();
      if (context.TTS_PROVIDER === "none") {
        return res.status(400).json({ error: "TTS not configured" });
      }

      // #909: the sentence's emotion tag (from /reply/stream) styles her voice.
      const emotion = typeof req.body?.emotion === "string" ? req.body.emotion : undefined;
      // #914: a reply event's character speaks in her own voice (group
      // mode's partner isn't the active one); unknown or none: the active one.
      const character = typeof req.body?.character === "string" ? req.body.character : null;
      // Part of #700: an untagged sentence takes her mood's lean instead
      // (read inside speakAs, so it's the speaking character's mood).
      const synthesize = () => context.synthesizeReply(text, { emotion: emotion || context.moodStore?.get().emotion || undefined });
      const audio = await (character && context.characters ? context.characters.speakAs(character, synthesize) : synthesize());
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

module.exports = { registerSpeechRoutes };
