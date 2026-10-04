const { ValidationError, optionalString, requireFile, requireString, sendValidationError } = require('../request-validation');
const { isRestartCommand } = require('../admin-restart');
const { runPluginInputHooks } = require('../capabilities/registry');
const { verifyAndFilterCitations } = require('../utils/citation-check');
const joinPromptParts = (...parts) => parts.filter(Boolean).join("\n\n");
const IMAGE_DESCRIBE_SYSTEM_PROMPT =
  "You describe images for another assistant that cannot see them. Be factual and specific.";
const IMAGE_DESCRIBE_PROMPT =
  "Describe this image so someone who can't see it could answer questions about it. " +
  "Copy any visible text word for word (error messages, code, UI labels), then say what it shows " +
  "and anything that looks wrong or notable. If a message from the person who sent it follows, " +
  "focus on what it needs, but don't answer it.";

function registerChatRoutes(context) {
let messageNumber = 0;

let lastSpeakerId = null;

function pickGroupSpeakers(text) {
    const partner = context.characters?.groupPartner?.();
    if (!partner) return null;
    const active = context.characters.active();
    const named = context.characters.mentioned(text).filter((c) => c.id === active.id || c.id === partner.id);
    const first = named.length === 1 ? named[0] : lastSpeakerId === active.id ? partner : active;
    return { first, second: first.id === active.id ? partner : active };
  }

const GROUP_REACTION_MAX_FIRST_CHARS = 300;

const wantsGroupReaction = (replyMeta, usedTools, reply) =>
    (replyMeta.mode === "casual" || replyMeta.mode === "chat") &&
    replyMeta.streamedMatchesFinal === true &&
    !usedTools &&
    typeof reply === "string" &&
    reply.trim().length > 0 &&
    reply.length <= GROUP_REACTION_MAX_FIRST_CHARS;

let warnedSessionless = false;

function warnIfSessionless(sessionId) {
    if (sessionId || warnedSessionless) return;
    warnedSessionless = true;
    console.warn(
      "Chat turn received without a sessionId: it is not saved to memory (warning shown once).",
    );
  }

async function runInputHooks(text, source, sessionId, hasImages) {
    warnIfSessionless(sessionId);
    const input = await runPluginInputHooks(
      context.capabilities,
      { text, source, sessionId, hasImages },
      { pluginSettingsStore: context.pluginSettingsStore },
    );
    if (input.reply && sessionId && typeof context.recordChatTurn === "function") {
      context.recordChatTurn(sessionId, input.text || "(shared an image)", input.reply);
    }
    return input;
  }

async function prepareImageTurn(text, images, modelProfile) {
    if (typeof context.chatAcceptsImages === "function" && context.chatAcceptsImages(modelProfile)) {
      return { text: text || "(shared an image)", images };
    }
    let description;
    try {
      description = await context.runVisionReply(
        joinPromptParts(IMAGE_DESCRIBE_PROMPT, text && `Their message: ${text}`),
        images,
        512,
        IMAGE_DESCRIBE_SYSTEM_PROMPT,
      );
    } catch (e) {
      if (e.code !== "VISION_PAUSED_GAMING") throw e;
      // #889: the chat model still answers, and says why it can't see it.
      console.log("Image turn: vision is paused while gaming");
      const note = "[An image was attached, but vision is paused while a game is running, so you can't see it. Say so.]";
      return { text: joinPromptParts(note, text), images: [] };
    }
    console.log(`Image turn: text-only chat model, vision model described ${images.length} image(s)`);
    return { text: joinPromptParts(`[Image: ${description}]`, text), images: [] };
  }

async function prepareDocumentTurn(text, documents, sessionId) {
    if (!documents || documents.length === 0) {
      return text;
    }
    const documentReader = require("../../plugins/document-reader/document-reader");
    // Only scanned PDFs need OCR; text documents must not start a worker.
    const runOcr = typeof context.getScreenOcrWorker === "function" ? async (image) => {
      const worker = await context.getScreenOcrWorker();
      const result = await worker.recognize(image);
      return result?.data?.text || "";
    } : undefined;

    const notes = [];
    for (const docPath of documents) {
      if (!context.documentAccess) throw new Error('Document approval is unavailable');
      const access = await context.documentAccess.authorize(docPath, { sessionId: sessionId || '', purpose: 'chat' });
      if (access.status !== 'approved') {
        notes.push(`[Document access ${access.status}. No file content has been read. Approval request: ${access.requestId || 'none'}. Do not claim to have read this file.]`);
        continue;
      }
      const res = await documentReader.extractAndPrepareForChat(access.buffer, { runOcr, filename: access.filename, sourceLabel: access.sourceLabel });
      if (!res.ok) {
        notes.push(
          `[Attached document "${res.fileName}" could not be read: ${res.error}. Explain clearly to the user why you cannot read this file.]`,
        );
      } else if (res.chunked) {
        notes.push(
          `[Attached document "${res.fileName}" (${res.type.toUpperCase()}, ${res.chars} characters) is a large document. It has been chunked across ${res.chunksCount} parts and indexed into your local knowledge retriever so you can search and cite it.\n\nBeginning overview:\n${res.excerpt}\n...\nUse your retriever/memory search if you need more details from other sections.]`,
        );
      } else {
        notes.push(
          `[Attached document: ${res.fileName} (${res.type.toUpperCase()}, ${res.chars} characters)]\n\n${res.text}`,
        );
      }
    }

    const userPrompt = text ? text : "(shared attached document(s))";
    return joinPromptParts(...notes, userPrompt);
  }

context.app.post("/reply", async (req, res) => {
    messageNumber += 1; // #914: a new message ends any pending group reaction
    try {
      // An attached image or document joins the chat turn (#679, #1325);
      // text becomes optional because the attachment can carry the question.
      const image =
        typeof req.body?.image === "string" && req.body.image.trim()
          ? req.body.image.trim()
          : null;
      const rawDocuments = Array.isArray(req.body?.documents)
        ? req.body.documents
        : typeof req.body?.document === "string"
          ? [req.body.document]
          : [];
      const documents = rawDocuments
        .filter((d) => (typeof d === "string" && d.trim()) || (d && typeof d === "object" && d.path))
        .map((d) => (typeof d === "string" ? d.trim() : d.path.trim()));

      const transcript = image || documents.length > 0
        ? optionalString(req.body?.text, "text", "")
        : requireString(req.body?.text, "text");

      if (isRestartCommand(transcript)) {
        if (!context.hasRestartController(context.restartController)) {
          return res.status(500).json({ error: "restart controller is not configured" });
        }

        const payload = context.restartController.buildAcceptedPayload();
        context.scheduleRestartAfterFinish(res, context.restartController);
        return res.json({
          reply: payload.message,
          restart: payload,
          ttsConfigured: false,
        });
      }

      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const input = await runInputHooks(
        transcript,
        optionalString(req.body?.source, "source", "typed"),
        sessionId,
        Boolean(image),
      );
      if (input.reply) {
        return res.json({ reply: input.reply, ttsConfigured: context.TTS_PROVIDER !== "none" });
      }

      if (documents.length > 0) {
        input.text = await prepareDocumentTurn(input.text, documents, sessionId);
      }

      if (image) {
        if (typeof context.getVisionStatus === "function") {
          const vision = context.getVisionStatus();
          if (!vision || !vision.available) {
            return res.status(503).json({
              error: "no local vision model available",
              detail: vision ? vision.reason : undefined,
            });
          }
        }
      }
      const screenText = context.clampText(
        optionalString(req.body?.screenText, "screenText", ""),
        context.SCREEN_CONTEXT_MAX_CHARS,
      );
      const hasModelProfile = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "modelProfile",
      );
      const modelProfile = hasModelProfile
        ? context.normalizeLlamaModelProfile(req.body?.modelProfile)
        : context.normalizeLlamaModelProfile(
            typeof context.getActiveModelProfile === "function"
              ? context.getActiveModelProfile()
              : "default",
          );
      const includeContext = req.body?.includeContext !== false;
      const world = optionalString(
        req.body?.ffxivWorld,
        "ffxivWorld",
        context.UNIVERSALIS_DEFAULT_WORLD,
      );
      // Tries each plugin's contributePromptContext in capabilities-array
      // order, first non-empty result wins (issue #108) -- each plugin's own
      // builder decides relevance, this just picks the first that answers.
      const webSources = [];
      const marketText = includeContext
        ? await context.contributePluginPromptContext(context.capabilities, input.text, {
            marketDataClient: context.marketDataClient,
            jobApplicationsStore: context.jobApplicationsStore,
            pluginSettingsStore: context.pluginSettingsStore,
            world,
            screenText,
            game: context.currentGame(),
            // #963: only a turn that says it was typed gets the longer
            // mid-game wiki wait; a spoken or unlabelled one keeps 5 s.
            typed: req.body?.source === "typed",
            sources: webSources,
          })
        : "";
      const assistantMode = optionalString(
        req.body?.assistantMode,
        "assistantMode",
        null,
      );
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      // #675: the client's "think harder" (deep-thinking toggle): true thinks
      // this turn, false ends Mana's own deep thinking (Q12b).
      const replyMeta = {
        systemPatch: input.systemPatch,
        thinkHarder: typeof req.body?.thinkHarder === "boolean" ? req.body.thinkHarder : undefined,
        // #911: a spoken turn may run desktop actions mid-game.
        voice: req.body?.source === "voice",
      };
      const turn = image
        ? await prepareImageTurn(input.text, [image], modelProfile)
        : { text: input.text, images: [] };
      replyMeta.images = turn.images;
      const reply = await context.buildAssistantReply(
        turn.text,
        screenText,
        joinPromptParts(marketText, input.userPatch),
        modelProfile,
        sessionId,
        assistantMode,
        presetId,
        replyMeta,
      );
      let finalReply = reply;
      let finalSources = null;
      if (webSources.length > 0) {
        const verified = verifyAndFilterCitations(reply, webSources);
        finalReply = verified.text;
        finalSources = verified.sources.length > 0 ? verified.sources : null;
      }
      return res.json({
        reply: finalReply,
        ...(replyMeta.answerModel ? { answerModel: replyMeta.answerModel, cloudFallback: Boolean(replyMeta.cloudFallback) } : {}),
        ...(finalSources ? { sources: finalSources } : {}),
        ...(replyMeta.thought ? { thought: replyMeta.thought } : {}),
        ttsConfigured: context.TTS_PROVIDER !== "none",
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

context.app.post("/reply/stream", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // #675: headers now, not at the first event -- a deep-thinking turn can
    // think ~25 s per request (tool rounds included) before it writes
    // anything, and the native launcher's HttpClient only waits its 100 s
    // default for the headers. Every outcome below is an event, never a
    // status code, so nothing needs the headers held back.
    res.flushHeaders();

    const writeEvent = (event) => res.write(JSON.stringify(event) + "\n");
    const thisMessage = ++messageNumber;

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
      const rawDocuments = Array.isArray(req.body?.documents)
        ? req.body.documents
        : typeof req.body?.document === "string"
          ? [req.body.document]
          : [];
      const documents = rawDocuments
        .filter((d) => (typeof d === "string" && d.trim()) || (d && typeof d === "object" && d.path))
        .map((d) => (typeof d === "string" ? d.trim() : d.path.trim()));

      const hasAttachments = images.length > 0 || documents.length > 0;
      const transcript = hasAttachments
        ? optionalString(req.body?.text, "text", "")
        : requireString(req.body?.text, "text");

      if (isRestartCommand(transcript)) {
        if (!context.hasRestartController(context.restartController)) {
          writeEvent({ type: "final", error: "restart controller is not configured" });
          return res.end();
        }
        const payload = context.restartController.buildAcceptedPayload();
        context.scheduleRestartAfterFinish(res, context.restartController);
        writeEvent({
          type: "final",
          reply: payload.message,
          restart: payload,
          ttsConfigured: false,
          changed: true,
        });
        return res.end();
      }

      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const input = await runInputHooks(
        transcript,
        optionalString(req.body?.source, "source", "typed"),
        sessionId,
        images.length > 0,
      );
      if (input.reply) {
        const active = context.characters?.active?.();
        writeEvent({
          type: "final",
          reply: input.reply,
          ttsConfigured: context.TTS_PROVIDER !== "none",
          changed: true,
          ...(active ? { character: active.id, characterName: active.name } : {}),
        });
        return res.end();
      }

      if (documents.length > 0) {
        input.text = await prepareDocumentTurn(input.text, documents, sessionId);
      }

      if (images.length) {
        if (typeof context.getVisionStatus === "function") {
          const vision = context.getVisionStatus();
          if (!vision || !vision.available) {
            writeEvent({
              type: "final",
              error: "no local vision model available",
              detail: vision ? vision.reason : undefined,
            });
            return res.end();
          }
        }
      }

      const screenText = context.clampText(
        optionalString(req.body?.screenText, "screenText", ""),
        context.SCREEN_CONTEXT_MAX_CHARS,
      );
      const hasModelProfile = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "modelProfile",
      );
      const modelProfile = hasModelProfile
        ? context.normalizeLlamaModelProfile(req.body?.modelProfile)
        : context.normalizeLlamaModelProfile(
            typeof context.getActiveModelProfile === "function"
              ? context.getActiveModelProfile()
              : "default",
          );
      const includeContext = req.body?.includeContext !== false;
      const world = optionalString(
        req.body?.ffxivWorld,
        "ffxivWorld",
        context.UNIVERSALIS_DEFAULT_WORLD,
      );
      const webSources = [];
      const marketText = includeContext
        ? await context.contributePluginPromptContext(context.capabilities, input.text, {
            marketDataClient: context.marketDataClient,
            jobApplicationsStore: context.jobApplicationsStore,
            pluginSettingsStore: context.pluginSettingsStore,
            world,
            screenText,
            game: context.currentGame(),
            // #963: only a turn that says it was typed gets the longer
            // mid-game wiki wait; a spoken or unlabelled one keeps 5 s.
            typed: req.body?.source === "typed",
            sources: webSources,
          })
        : "";
      const assistantMode = optionalString(req.body?.assistantMode, "assistantMode", null);
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      // #661: tool start/end events, so the native avatar can show she's
      // working while a tool runs.
      const replyMeta = {
        systemPatch: input.systemPatch,
        // #1318: plus the step (description, kind, status, detail...).
        onToolCall: (call) => writeEvent({ ...call, type: "tool" }),
        // #914: a relationship note she just made, for its chat line.
        onNoted: (noted) => writeEvent({ type: "noted", ...noted }),
        // #1354: reasoning tokens streamed separately so TTS never speaks them,
        // but the launcher can show a collapsed thought dropdown.
        onThought: (chunk) => {
          replyMeta.thought = (replyMeta.thought || "") + chunk;
          writeEvent({ type: "thought", text: chunk });
        },
        // #675: the client's "think harder" (deep-thinking toggle): true
        // thinks this turn, false ends Mana's own deep thinking (Q12b).
        thinkHarder: typeof req.body?.thinkHarder === "boolean" ? req.body.thinkHarder : undefined,
        // #911: a spoken turn may run desktop actions mid-game.
        voice: req.body?.source === "voice",
      };
      const turn = images.length
        ? await prepareImageTurn(input.text, images, modelProfile)
        : { text: input.text, images: [] };
      replyMeta.images = turn.images;

      // #914: every sentence/final event says which character is speaking,
      // so the launcher lip-syncs her avatar, speaks in her voice and labels
      // the chat. In group mode (not for image turns) she may not be the
      // active one.
      const group = images.length ? null : pickGroupSpeakers(input.text);
      const speaker = group ? group.first : context.characters?.active?.();
      const who = speaker ? { character: speaker.id, characterName: speaker.name } : {};
      const speakAs = (character, fn) => (group ? context.characters.speakAs(character.id, fn) : fn());
      let usedTools = false;
      const onToolCall = replyMeta.onToolCall;
      replyMeta.onToolCall = (call) => {
        usedTools = true;
        onToolCall(call);
      };

      const reply = await speakAs(speaker, () =>
        context.buildAssistantReply(
          turn.text,
          screenText,
          joinPromptParts(marketText, input.userPatch),
          modelProfile,
          sessionId,
          assistantMode,
          presetId,
          replyMeta,
          // #623: emotion is the sentence's face tag, when the model gave one.
          (sentence, emotion) =>
            writeEvent({ type: "sentence", text: sentence, ...(emotion ? { emotion } : {}), ...who }),
        ),
      );

      let finalReply = reply;
      let finalSources = null;
      if (webSources.length > 0) {
        const verified = verifyAndFilterCitations(reply, webSources);
        finalReply = verified.text;
        finalSources = verified.sources.length > 0 ? verified.sources : null;
      }

      writeEvent({
        type: "final",
        reply: finalReply,
        ...(replyMeta.answerModel ? { answerModel: replyMeta.answerModel, cloudFallback: Boolean(replyMeta.cloudFallback) } : {}),
        ...(finalSources ? { sources: finalSources } : {}),
        ...(replyMeta.thought ? { thought: replyMeta.thought } : {}),
        ttsConfigured: context.TTS_PROVIDER !== "none",
        changed: !replyMeta.streamedMatchesFinal,
        ...(replyMeta.expression ? { expression: replyMeta.expression } : {}),
        ...(replyMeta.emotion ? { emotion: replyMeta.emotion } : {}),
        // #675 Q12b: Mana's own deep thinking is on (the Think button lights).
        deepThinking: replyMeta.deepThinking === true,
        ...who,
      });

      // #914: her sister's short reaction, as more events on the same
      // stream (a sentence and a second final). Skipped once I've typed
      // again or the client has gone.
      if (group) {
        lastSpeakerId = group.first.id;
        if (
          typeof context.buildGroupReaction === "function" &&
          wantsGroupReaction(replyMeta, usedTools, reply) &&
          thisMessage === messageNumber &&
          !res.destroyed
        ) {
          const reaction = await speakAs(group.second, () =>
            context.buildGroupReaction({ sessionId, userText: input.text, sister: group.first, reply }),
          ).catch((e) => {
            console.warn("Group reaction failed:", e?.message || e);
            return "";
          });
          if (reaction && thisMessage === messageNumber) {
            lastSpeakerId = group.second.id;
            // Her own turn in the history, with no user line.
            speakAs(group.second, () => context.recordChatTurn(sessionId, "", reaction));
            const theirs = { character: group.second.id, characterName: group.second.name };
            writeEvent({ type: "sentence", text: reaction, ...theirs });
            writeEvent({ type: "final", reply: reaction, ttsConfigured: context.TTS_PROVIDER !== "none", changed: false, ...theirs });
          }
        }
      }
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

context.app.post("/transcribe", context.upload.single("file"), async (req, res) => {
    try {
      requireFile(req.file, "file");
      console.log("Got file upload:", req.file);
      const { tmpPath, audioPath } = context.normalizeUploadedAudio(req.file);

      console.log(
        "audioPath ->",
        audioPath,
        "exists=",
        context.fs.existsSync(audioPath),
        "size=",
        context.fs.existsSync(audioPath) ? context.fs.statSync(audioPath).size : 0,
      );
      const transcript = await context.runWhisper(audioPath);
      context.cleanupUploadedAudio(tmpPath, audioPath);

      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const input = await runInputHooks(transcript, "voice", sessionId, false);
      if (input.reply) {
        return res.json({
          transcript,
          reply: input.reply,
          ttsConfigured: context.TTS_PROVIDER !== "none",
        });
      }

      // Same generic plugin prompt-context chain /reply uses (issue #108).
      // No screenText/ffxivWorld here since /transcribe has no OCR or
      // per-request world override -- UNIVERSALIS_DEFAULT_WORLD covers it.
      const marketText = await context.contributePluginPromptContext(
        context.capabilities,
        input.text,
        {
          marketDataClient: context.marketDataClient,
          jobApplicationsStore: context.jobApplicationsStore,
          pluginSettingsStore: context.pluginSettingsStore,
          world: context.UNIVERSALIS_DEFAULT_WORLD,
          screenText: "",
          game: context.currentGame(),
        },
      );
      const assistantMode = optionalString(
        req.body?.assistantMode,
        "assistantMode",
        null,
      );
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      const replyMeta = { systemPatch: input.systemPatch, voice: true };
      const reply = await context.buildAssistantReply(
        input.text,
        "",
        joinPromptParts(marketText, input.userPatch),
        "default",
        sessionId,
        assistantMode,
        presetId,
        replyMeta,
      );

      return res.json({
        transcript,
        reply,
        ttsConfigured: context.TTS_PROVIDER !== "none",
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
  return { warnIfSessionless };
}

module.exports = { registerChatRoutes };
