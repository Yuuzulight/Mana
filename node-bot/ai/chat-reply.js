const backendDir = require('node:path').join(__dirname, '..');
const { wrapUntrusted } = require('./untrusted-content');
const { createAnalysisToolSource, chartArtifact } = require('./analysis-tool-source');

function createChatReply(context) {
function buildScreenAwarePrompt(transcript, screenText, marketText = "") {
    if (!screenText && !marketText) {
      return transcript;
    }

    // Quick rundown: Mana sees this as extra context, not as something the user said.
    const parts = ["User said:", transcript];

    if (marketText) {
      parts.push("", marketText);
    }

    if (screenText) {
      parts.push("", "Visible screen text:", screenText);
    }

    parts.push(
      "",
      "Answer the user using the extra context only when it helps.",
    );
    return parts.join("\n");
  }

async function runOpenAIReply(prompt, maxTokens = context.LLAMA_MAX_TOKENS, systemPromptOverride = null, sessionId = null, remoteConfig = null) {
    let config = remoteConfig || { apiKey: context.openAiApiKey(), baseUrl: context.openAiBaseUrl(), model: context.openAiModel() };
    if (remoteConfig?.enabled === true) {
      try { config = context.modelManagement.resolveChatModel('cloud:fallback').remoteConfig; }
      catch { return null; }
      if (!config) return null;
      if (config.model !== remoteConfig.model || config.baseUrl !== remoteConfig.baseUrl) return null;
    }
    if (!context.shouldUseRemoteAi(config)) return null;
    if (sessionId) {
      const stopThreshold = Number(process.env.MANA_SESSION_TOKEN_STOP);
      if (Number.isFinite(stopThreshold) && stopThreshold > 0 && context.sessionTokenUsage.getUsage(sessionId).totalTokens >= stopThreshold) return null;
    }
    const result = await require('./remote-chat').requestChatCompletion({
      ...config,
      maxTokens,
      timeoutMs: process.env.MANA_REMOTE_AI_TIMEOUT_MS,
      messages: [
        { role: 'system', content: systemPromptOverride || context.activeDefaultPrompt() },
        { role: 'user', content: prompt },
      ],
    });
    if (sessionId && result?.usage) context.sessionTokenUsage.recordUsage(sessionId, result.usage);
    return result?.content || null;
  }

function pickAssistantMode(transcript, normalizedModelProfile) {
    try {
      const result = context.classifyIntent(transcript, normalizedModelProfile);
      if (result && result.mode) return result;
      return {
        mode: normalizedModelProfile === "coding" ? "coding" : "everyday",
        reason: "fallback_model_profile",
      };
    } catch (e) {
      return {
        mode: normalizedModelProfile === "coding" ? "coding" : "everyday",
        reason: "error_classifier",
      };
    }
  }

async function buildAssistantReply(
    transcript,
    screenText = "",
    marketText = "",
    modelProfile = "default",
    sessionId = null,
    assistantMode = null,
    presetId = null,
    // Issue #253: optional out-parameter -- a caller that cares about the
    // model's own expression__set tool call passes a fresh {} and reads
    // `.expression` back off it after the await, instead of this function's
    // return type (a plain string, unchanged, everywhere else) needing to
    // grow a second shape for the one caller that wants it.
    replyMeta = null,
    // Issue #331: optional streaming callback, called with each completed
    // sentence during the first plain local-completion attempt only. See
    // the firstPassStreamed comment below for why it's first-attempt-only.
    onSentence = null,
  ) {
    const prompt = buildScreenAwarePrompt(transcript, screenText, marketText);
    const analysisCharts = [];
    const chatChoice = replyMeta && !replyMeta.scheduled && sessionId ? context.acpMemoryStore.getSession?.(sessionId)?.chatModel : null;
    const selectedChatModel = chatChoice ? context.modelManagement.resolveChatModel(chatChoice, { fallbackToLocal: true }) : null;
    // let: #666's wait below may switch this turn to the fallback profile.
    let normalizedModelProfile = selectedChatModel?.profile || context.selectLlamaModelProfileForPrompt(
      transcript,
      selectedChatModel?.profile || modelProfile,
    );

    // #1343 Phase 3: Sticky coding session handling and gaming guard
    if (context.codingSessionManager.isExitCommand(transcript)) {
      context.codingSessionManager.stop(sessionId, "user_exit");
      if (replyMeta) replyMeta.codingSessionExited = true;
    }
    const inStickyCoding = context.codingSessionManager.isActive(sessionId);
    if (!inStickyCoding && (context.codingSessionManager.isEnterCommand(transcript) || normalizedModelProfile === "coding")) {
      if (context.gamingWatch.isGaming()) {
        normalizedModelProfile = "default";
        if (replyMeta) replyMeta.gamingHeld = true;
      } else {
        const startRes = context.codingSessionManager.start(sessionId);
        if (startRes.ok) {
          normalizedModelProfile = "coding";
          if (replyMeta) {
            replyMeta.codingSessionStarted = true;
            replyMeta.maskingPhrase = startRes.maskingPhrase;
          }
        }
      }
    } else if (inStickyCoding) {
      if (context.gamingWatch.isGaming()) {
        context.codingSessionManager.stop(sessionId, "game_started");
        normalizedModelProfile = "default";
      } else {
        context.codingSessionManager.touch(sessionId);
        normalizedModelProfile = "coding";
      }
    }
    // #675: "think harder" turns thinking on for this turn's replies (tool
    // loop, streamed or plain, and regenerations) with its own bigger
    // budget -- asked for in words, or by the client's thinkHarder request
    // field (the native launcher's deep-thinking toggle). Best-of-N never
    // thinks, so such a turn skips it. undefined (not false) otherwise:
    // the profile's own default then decides.
    // Q12b: or Mana's own deep thinking (deep_thinking__set) is on for this
    // session; a literal thinkHarder: false (the user clicked the lit Think
    // button off) ends it first. Only for callers with a replyMeta (the
    // user's own chat routes), never cron/Discord or other scheduled jobs
    // (#780's replyMeta.scheduled). let: her tool call can switch it
    // mid-reply.
    const userChat = Boolean(replyMeta && !replyMeta.scheduled);
    if (selectedChatModel?.profile && !replyMeta?.gamingHeld) normalizedModelProfile = selectedChatModel.profile;
    let manaThinking = false;
    if (userChat) {
      // #697: a reply soon after an unprompted remark counts as engaging with it.
      require("../proactive").react("engaged");
      if (replyMeta.thinkHarder === false) context.deepThinking.set(sessionId, false);
      manaThinking = context.deepThinking.takeReply(sessionId);
      replyMeta.deepThinking = context.deepThinking.isOn(sessionId);
    }
    const askedThinkHarder = (replyMeta && replyMeta.thinkHarder === true) || context.wantsThinkHarder(transcript);
    let thinkHarder = askedThinkHarder || manaThinking || undefined;

    // Determine assistant mode and system prompt
    const inferred = pickAssistantMode(transcript, normalizedModelProfile); // { mode, reason }
    // Use explicit assistantMode if provided; otherwise use inferred.mode
    const mode =
      assistantMode ||
      (inferred && inferred.mode) ||
      (normalizedModelProfile === "coding" ? "coding" : "everyday");
    // Same coding/developer check the system-prompt selection below uses --
    // every actual reply-generation call site in this function should use
    // this instead of LLAMA_MAX_TOKENS directly, so coding replies stop
    // getting cut off mid-example.
    const effectiveMaxTokens =
      mode === "coding" || mode === "developer"
        ? context.LLAMA_MAX_TOKENS_CODING
        : context.LLAMA_MAX_TOKENS;
    // #914: group mode adds a second reply only to casual turns.
    if (replyMeta) replyMeta.mode = mode;

    // Optional lightweight intent telemetry (enable with MANA_INTENT_TELEMETRY=1)
    try {
      const intentTelemetry =
        process.env.MANA_INTENT_TELEMETRY === "1" ||
        process.env.MANA_INTENT_TELEMETRY === "true";
      if (intentTelemetry) {
        console.log(
          `[Mana Router] 🧭 Routing to mode [${mode}] | Reason: ${inferred && inferred.reason ? inferred.reason : "none"} | Session: ${sessionId || "none"}`,
        );
      }
    } catch (e) {
      // don't block on telemetry
    }

    // Identity ("who Mana is") comes from persona.js, layered with each
    // mode's own task-specific operational instructions -- these three
    // used to each redefine Mana's personality from scratch, drifting
    // slightly from one another and from persona.js's other consumers.
    let selectedSystemPrompt = context.persona.buildPersonaPrompt(
      sessionId,
      context.personalityStore.get().traits,
      context.personaOf(context.characterStore.active()),
    );
    // Issue #623: per-sentence emotion tags for the avatar. Static text, so
    // it sits in the cached prefix; every reply path below strips the tags.
    selectedSystemPrompt = `${selectedSystemPrompt}\n\n${context.EMOTION_TAG_PROMPT}`;
    // Issue #660: the mode is picked per message, so its text is appended
    // last (after the session goal below) -- spliced in right after the
    // persona, a mode switch changed the prompt prefix and cost
    // llama-server its prompt cache for everything after it.
    const CASUAL_MODE_TEXT = `Use short paragraphs and natural conversational phrasing; include occasional friendly flourishes (e.g. "You got this!"). Ask one clarifying question only when necessary. If the user requests professional or safety-sensitive information, politely indicate you cannot provide it and offer to look up resources or recommend professionals.`;
    const EVERYDAY_MODE_TEXT = `Provide clear, concise, and practical guidance. When giving instructions, present them as short numbered steps and include expected outcomes or simple checks when helpful. Use plain language accessible to non-technical users. Offer follow-up actions and ask clarifying questions only when required. For health, legal, or hazardous topics, recommend professional resources.`;
    const CODING_MODE_TEXT = `In this mode, be focused, precise, and technical: start with a one-line summary of intent, then provide minimal, runnable code examples in fenced blocks, followed by a short explanation and a suggested test or verification step. Avoid small talk entirely. Ask only necessary clarifying questions. When the user requests structured output (JSON, patch, or commands), return exactly the machine-readable block unless commentary is explicitly requested. Include assumptions and environment notes when relevant.`;

    let modeText;
    if (mode === "casual" || mode === "chat") {
      modeText = CASUAL_MODE_TEXT;
    } else if (mode === "coding" || mode === "developer") {
      modeText = CODING_MODE_TEXT;
    } else {
      modeText = EVERYDAY_MODE_TEXT;
    }

    // A saved preset layers its instructions on top of the base persona
    // prompt rather than replacing it -- Mana stays Mana, just tuned. No
    // preset selected (the common case) leaves this untouched.
    if (presetId) {
      try {
        const preset = context.activePresetsStore.getPreset(presetId);
        if (preset && preset.instructions) {
          selectedSystemPrompt = `${selectedSystemPrompt}\n\n${preset.instructions}`;
        }
      } catch (presetErr) {
        console.warn("Failed to apply preset:", presetErr.message || presetErr);
      }
    }

    const projectSearch = sessionId && context.projectReferences ? await context.projectReferences.search(sessionId, transcript) : { results: [], warnings: [] };
    const projectBlock = sessionId ? context.activeProjectsStore?.promptBlockForSession(sessionId) || '' : '';
    if (projectBlock) selectedSystemPrompt += `\n\n${projectBlock}`;
    const projectReferenceText = projectSearch.results.length ? wrapUntrusted('project references', projectSearch.results.map(result => `Reference: ${result.label}\n${result.snippet}`).join('\n\n')) : '';
    if (projectReferenceText) selectedSystemPrompt += `\n\n${projectReferenceText}`;

    // Small server log for selected mode
    try {
      console.log(
        `Mana mode=${mode} session=${sessionId || "none"} system_prompt_snippet="${selectedSystemPrompt.slice(0, 160).replace(/\n/g, " ")}..."`,
      );
    } catch (e) {
      // don't block on logging
    }

    // Inject global BACKGROUND_MEMORY_BLOCK (loaded at startup) directly under the system instructions
    try {
      if (context.BACKGROUND_MEMORY_BLOCK) {
        selectedSystemPrompt = `${selectedSystemPrompt}\n\n${context.BACKGROUND_MEMORY_BLOCK}`;
      }
    } catch (e) {
      // ignore failures here
    }

    // Foundational tool-calling (issue #51), on by default (opt out with
    // MANA_TOOL_CALLING_ENABLED=0) and scoped to the "default" profile, the
    // one verified to emit reliable tool_calls (see
    // docs/roadmap/issue-51-tool-calling.md).
    // Hoisted above the skills-index block below: that block must not
    // advertise skill__view unless this same condition lets the model
    // actually call it (see the block's own comment for why).
    const toolCallingEnabled =
      String(process.env.MANA_TOOL_CALLING_ENABLED || "1") !== "0";

    // Always-visible skill index (see buildSkillsIndexBlock above) -- but
    // only when tool-calling can actually act on it. The index advertises
    // skill__view; outside the exact condition replyMaybeWithTools checks
    // below, no reply path can invoke it, and a model told about a tool it
    // can't call tends to narrate the call as plain text instead of either
    // answering normally or invoking nothing (observed: "Skill needed:
    // X\nCalling skill__view with name: X" leaking into a plain reply).
    // activeSkillsStore, not the module-level skillsStore singleton --
    // otherwise this would silently bypass a test's (or any future caller's)
    // deps.skillsStore override, the exact trap already called out where
    // activeSkillsStore is defined above.
    // Issue #401: the session's user-stated goal (if any) -- read
    // unconditionally here since the tool-array construction further
    // below also needs it, but only actually surfaced to the model (as
    // system-prompt text, and as the session_goal__finish tool) when
    // tool-calling is enabled for this reply. Outside that path (a plain
    // conversational reply, remote AI, etc.) there's no way for the model
    // to act on a goal at all, so mentioning it would just be misleading.
    // See ai/session-goal-tool-source.js's own header comment for why the
    // goal itself is never model-writable, only user-settable.
    let sessionGoal = null;
    if (sessionId) {
      try {
        const session = context.acpMemoryStore.getSession(sessionId);
        sessionGoal = session && session.goal ? session.goal : null;
      } catch (e) {
        // ignore -- goal context is best-effort, never blocks a reply
      }
    }
    // Issue #676: goal mode (opt in with MANA_GOAL_MODE=1) keeps the tool
    // loop going until the goal is done. It needs tools, which coding-routed
    // turns never get, so a goal-mode turn stays on the default profile.
    const goalMode =
      Boolean(sessionGoal) &&
      String((context.deps.env || process.env).MANA_GOAL_MODE || "0") === "1" &&
      toolCallingEnabled &&
      context.isLlamaServerAvailable();
    if (goalMode && !selectedChatModel?.profile) normalizedModelProfile = "default";

    // Issue #400: buildSkillsIndexBlock already computes how many skills it
    // left out, but only as a line of text baked into the block -- read
    // back out here rather than changing that function's return shape,
    // which other callers/tests still depend on as a bare string.
    let skillsOmittedCount = 0;
    let skillsIndexText = "";
    if (
      toolCallingEnabled &&
      normalizedModelProfile === "default" &&
      context.isLlamaServerAvailable()
    ) {
      // #1337: she narrates her tool rounds. Static, so ahead of the skills
      // index in the cached prefix; only where tools are offered.
      selectedSystemPrompt = `${selectedSystemPrompt}\n\n${context.TOOL_NARRATION_PROMPT}`;
      try {
        const skillsIndexBlock = context.buildSkillsIndexBlock(context.activeSkillsStore.listSkills());
        if (skillsIndexBlock) {
          skillsIndexText = skillsIndexBlock;
          selectedSystemPrompt = `${selectedSystemPrompt}\n\n${skillsIndexBlock}`;
          const omittedMatch = skillsIndexBlock.match(/\((\d+) more skill\(s\) omitted for length\)/);
          if (omittedMatch) skillsOmittedCount = Number(omittedMatch[1]) || 0;
        }
      } catch (e) {
        // ignore failures here
      }
      if (sessionGoal) {
        selectedSystemPrompt = `${selectedSystemPrompt}\n\nSession goal: ${sessionGoal}\nIf you believe this goal has been fully achieved, call session_goal__finish instead of continuing to use more tools.`;
      }
    }
    selectedSystemPrompt = `${selectedSystemPrompt}\n\n${modeText}`;
    // Issue #677: plugin onUserInput system patches are per turn, so they go
    // after the mode text for the same prompt-cache reason (#660).
    if (replyMeta && replyMeta.systemPatch) {
      selectedSystemPrompt = `${selectedSystemPrompt}\n\n${replyMeta.systemPatch}`;
    }
    // A message about suicide or self-harm gets a care-and-hotlines note for
    // this turn -- per turn, so last, like the mode text. Every chat path
    // (typed, voice, stream, mobile) builds its prompt here.
    const crisisNote = context.crisisInstruction(transcript, context.deps.env || process.env);
    if (crisisNote) selectedSystemPrompt = `${selectedSystemPrompt}\n\n${crisisNote}`;

    // Issue #282: memory (session summary/recent-turns, cross-session
    // facts) becomes its own positionable system-role messages -- "early"
    // (right after the persona) or "late" (right before the live user
    // turn, the higher-salience slot) -- for the two reply paths that can
    // take a real messages array (runToolAwareReply, runLocalAssistantReply
    // below). Paths that only take a flat system-prompt string (the OpenAI
    // proxy, Best-of-N) fall back to the old flattened text via
    // flatMemorySuffix so they don't lose memory context entirely.
    //
    // Issue #660: every memory entry built below changes turn to turn, so
    // all of them default to "late" -- anything per-turn placed early would
    // change the prompt prefix and defeat llama-server's prompt cache. The
    // system prompt above stays per-turn-free for the same reason (persona,
    // background memory, name-sorted skills index, session goal), except for
    // the per-message mode text, which goes last so a mode switch only
    // changes its tail; screen and market text already ride on the user
    // message itself.
    const memoryExtraMessages = { early: [], late: [] };
    // #679: images the chat model can see itself (server-routes.js decided);
    // buildMessages puts them on the live user message on every path below.
    if (replyMeta?.images?.length) memoryExtraMessages.images = replyMeta.images;
    let flatMemorySuffix = "";
    let promptMemoryChars = 0;
    let promptMemoryText = "";
    let promptMemoryTruncated = false;
    let turnsDroppedByAge = 0;
    try {
      if (sessionId) {
        const result = await context.acpMemoryStore.buildPromptMemoryEntries(sessionId);
        for (const entry of result.entries) {
          memoryExtraMessages[entry.position].push({ role: entry.role, content: entry.content });
          flatMemorySuffix += `\n\n${entry.content}`;
          promptMemoryChars += entry.content.length;
          promptMemoryText += `\n\n${entry.content}`;
          if (entry.truncated) promptMemoryTruncated = true;
        }
        turnsDroppedByAge = result.turnsDroppedByAge || 0;
      }
    } catch (memErr) {
      console.warn("Failed to build session memory:", memErr.message);
    }

    // Issue #141: the larger, on-demand tier -- only pulled in when the
    // current message actually names something previously discussed in a
    // *different* session. Bounded by maxChars in getRelatedFactsEntries,
    // so it never grows with total memory volume.
    let relatedFactsChars = 0;
    let relatedFactsText = "";
    let relatedFactsTruncated = false;
    // Issue #674: candidate/kept counts and any recall fallback, for #400.
    let relatedFactsRecall = null;
    try {
      if (typeof context.acpMemoryStore.getRelatedFactsEntries === "function") {
        const { entries, recall } = await context.acpMemoryStore.getRelatedFactsEntries(transcript, {
          excludeSessionId: sessionId,
          // Q27: a scheduled job (replyMeta.scheduled) sees confirmed facts only.
          confirmedOnly: Boolean(replyMeta && replyMeta.scheduled),
        });
        relatedFactsRecall = recall || null;
        for (const entry of entries) {
          memoryExtraMessages[entry.position].push({ role: entry.role, content: entry.content });
          flatMemorySuffix += `\n\n${entry.content}`;
          relatedFactsChars += entry.content.length;
          relatedFactsText += `\n\n${entry.content}`;
          if (entry.truncated) relatedFactsTruncated = true;
        }
      }
    } catch (relErr) {
      console.warn("Failed to look up related facts:", relErr.message);
    }

    // Issue #700: her mood, as tone guidance only -- "late" like memory,
    // since it changes turn to turn. It never touches the token budget,
    // tools or mode, and moodPromptBlock leaves coding replies alone.
    // Part of #700: plus "be gentle, don't pry" while I've seemed down for
    // several turns (even with her mood frozen -- that's about me, not her).
    let moodText = "";
    try {
      context.activeMoodStore.recordTurn(transcript);
      moodText = [context.moodPromptBlock(context.activeMoodStore.get(), mode), context.gentleHint(context.acpMemoryStore.getUserAffectState(), mode)]
        .filter(Boolean)
        .join("\n");
      if (moodText) {
        memoryExtraMessages.late.push({ role: "system", content: moodText });
        flatMemorySuffix += `\n\n${moodText}`;
      }
    } catch (moodErr) {
      console.warn("Failed to apply mood:", moodErr.message);
    }
    // #914: her own notes on how we get along, same place and rules; in my
    // own chat, now and then one of her milestones (our first chat is one:
    // for Mana, the day of the oldest session).
    try {
      const relationshipText = context.relationshipPromptBlock(context.relationshipStore.list(), mode);
      if (userChat) {
        context.relationshipStore.ensureFirstChat(() =>
          context.characterStore.active().id === context.DEFAULT_CHARACTER_ID ? context.oldestSessionAt() : null,
        );
      }
      const milestoneText = userChat ? context.relationshipStore.milestoneToMention(mode) : null;
      for (const text of [relationshipText, milestoneText].filter(Boolean)) {
        memoryExtraMessages.late.push({ role: "system", content: text });
        flatMemorySuffix += `\n\n${text}`;
      }
    } catch (relationshipErr) {
      console.warn("Failed to apply relationship notes:", relationshipErr.message);
    }

    // Issue #400: makes the composition of the prompt this reply actually
    // used observable (GET /prompt-composition), instead of only
    // discoverable by reading the code the way #364's truncation bug was.
    // Covers the three blocks gathered unconditionally above (system-prompt
    // folds in persona/preset/background-memory/skills-index/session-goal/mode,
    // since those are all concatenated into one string by this point),
    // before the reply-path branches below diverge; tool schemas and the
    // live turns differ per reply path (tool-aware vs. streaming vs. plain)
    // and aren't included here (#642 adds them once the reply is done).
    //
    // Issue #642: the skills index is its own block now, and each block's
    // text is kept (compositionTexts) so the end of the turn can count its
    // real tokens -- see finalizePromptComposition below.
    let systemPromptText = skillsIndexText
      ? selectedSystemPrompt.replace(`\n\n${skillsIndexText}`, "")
      : selectedSystemPrompt;
    if (projectBlock) systemPromptText = systemPromptText.replace(`\n\n${projectBlock}`, '');
    if (projectReferenceText) systemPromptText = systemPromptText.replace(`\n\n${projectReferenceText}`, '');
    const compositionTexts = {
      "system-prompt": systemPromptText,
      "project-instructions": projectBlock,
      "project-references": projectReferenceText,
      "skills-index": skillsIndexText,
      "prompt-memory": promptMemoryText,
      "related-facts": relatedFactsText,
      mood: moodText,
    };
    let compositionRecord = null;
    try {
      compositionRecord = context.recordPromptComposition(sessionId, [
        { name: "system-prompt", chars: systemPromptText.length, dropped: null },
        { name: "project-instructions", chars: projectBlock.length, dropped: null },
        { name: "project-references", chars: projectReferenceText.length, dropped: { warnings: projectSearch.warnings } },
        { name: "skills-index", chars: skillsIndexText.length, dropped: { skillsOmitted: skillsOmittedCount } },
        { name: "prompt-memory", chars: promptMemoryChars, dropped: { truncated: promptMemoryTruncated, turnsDroppedByAge } },
        {
          name: "related-facts",
          chars: relatedFactsChars,
          dropped: { truncated: relatedFactsTruncated, ...(relatedFactsRecall ? { recall: relatedFactsRecall } : {}) },
        },
        { name: "mood", chars: moodText.length, dropped: null },
      ]);
    } catch (compErr) {
      // Diagnostic-only; never blocks a reply.
      console.warn("Failed to record prompt composition:", compErr.message);
    }

    // Attempt retrieval from local retriever-index (fast) first. If it yields nothing, fall back to the existing HTTP or legacy Python retrievers.
    // Repository retrieval helps coding questions; casual chat just gets
    // polluted by random repo snippets. Override with MANA_RETRIEVAL_MODES
    // (comma-separated modes, e.g. "coding,everyday").
    let retrievedText = "";
    const retrievalModes = String(process.env.MANA_RETRIEVAL_MODES || "coding")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    try {
      if (!retrievalModes.includes(String(mode || "").toLowerCase())) {
        throw Object.assign(new Error("retrieval skipped for this mode"), {
          retrievalSkipped: true,
        });
      }
      try {
        const retrieverIndex = require("../tools/retriever-index");
        const idx =
          retrieverIndex.loadIndexSync && retrieverIndex.loadIndexSync();
        if (idx && Array.isArray(idx.entries) && idx.entries.length) {
          try {
            let hits = null;
            try {
              const vsModule = require("../tools/vector-store");
              const createStore =
                vsModule && vsModule.createStore ? vsModule.createStore : null;
              if (createStore) {
                const store = createStore({
                  dir:
                    process.env.VECTOR_STORE_DIR ||
                    context.path.join(backendDir, "..", "tools", "vector_store"),
                });
                await store.init();
                await store.load();
                const cnt = (await store.count().catch(() => 0)) || 0;
                if (
                  cnt > 0 &&
                  typeof retrieverIndex.computeEmbedding === "function"
                ) {
                  try {
                    const qembed =
                      await retrieverIndex.computeEmbedding(transcript, { query: true });
                    if (qembed) {
                      const s = await store.search(qembed, 5);
                      if (Array.isArray(s) && s.length) {
                        // Issue #217: this vector-store-direct fast path used
                        // to duplicate the read-file-then-slice(0, 800) loop
                        // retriever-index.js's search() itself replaced with
                        // buildSnippets() in issue #211 -- meaning whenever
                        // this fast path succeeded (the common case once a
                        // vector store exists), #211's compression never
                        // actually ran. Reusing the same shared helper here
                        // closes that gap.
                        const candidates = s.map((it) => ({
                          id: it.id,
                          path: it.path || it.id,
                          score: it.score,
                        }));
                        hits = await retrieverIndex.buildSnippets(
                          candidates,
                          transcript,
                          context.compressExcerpts,
                        );
                      }
                    }
                  } catch (e) {
                    hits = null;
                  }
                }
              }
            } catch (e) {
              hits = null;
            }

            if (!hits)
              hits = await retrieverIndex.search(transcript, 5, {
                compress: context.compressExcerpts,
              });
            if (Array.isArray(hits) && hits.length) {
              const maxChars = Number(process.env.RETRIEVER_MAX_CHARS || 3000);
              const pieces = [];
              let acc = 0;
              for (let i = 0; i < hits.length; i++) {
                const h = hits[i];
                const chunk = (h.snippet || "").trim();
                const header = `Source: ${h.path} [score ${h.score}]\n`;
                const snippet = header + chunk + "\n\n";
                if (acc + snippet.length > maxChars) {
                  break;
                }
                pieces.push(
                  `--- Retrieved snippet ${i + 1} ---\n${snippet}--- End snippet ${i + 1} ---`,
                );
                acc += snippet.length;
                if (pieces.length >= 5) break;
              }
              if (pieces.length) {
                retrievedText =
                  "Retrieved repository context:\n\n" +
                  pieces.join("\n\n") +
                  "\n\n";
              }
            }
          } catch (riErr) {
            console.warn(
              "retriever-index.search failed:",
              riErr && riErr.message ? riErr.message : riErr,
            );
          }
        }
      } catch (loadErr) {
        // retriever-index not available or failed to load; continue to HTTP/Python retriever
      }

      // If retriever-index produced results, skip the heavier HTTP/python retrievers
      if (!retrievedText) {
        const retrieverUrl =
          process.env.RETRIEVER_URL || "http://127.0.0.1:9000/retrieve";
        try {
          await context.retrieverService.ensure().catch((e) =>
            console.warn("Python retriever unavailable:", e?.message || e),
          );
          // try HTTP retriever first
          const resp = await fetch(retrieverUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: transcript, k: 5 }),
          });
          if (resp.ok) {
            try {
              const hits = await resp.json();
              if (Array.isArray(hits) && hits.length) {
                const maxChars = Number(
                  process.env.RETRIEVER_MAX_CHARS || 3000,
                );
                const pieces = [];
                let acc = 0;
                for (let i = 0; i < hits.length; i++) {
                  const h = hits[i];
                  const meta = h.meta || {};
                  const chunk = (meta.text || meta.preview || "").trim();
                  const header = `Source: ${meta.path} [chars ${meta.start_char}-${meta.end_char}]\n`;
                  const snippet = header + chunk + "\n\n";
                  if (acc + snippet.length > maxChars) {
                    break;
                  }
                  pieces.push(
                    `--- Retrieved snippet ${i + 1} ---\n${snippet}--- End snippet ${i + 1} ---`,
                  );
                  acc += snippet.length;
                  if (pieces.length >= 5) break;
                }
                if (pieces.length) {
                  retrievedText =
                    "Retrieved repository context:\n\n" +
                    pieces.join("\n\n") +
                    "\n\n";
                }
              }
            } catch (pe) {
              console.warn(
                "Failed to parse retriever HTTP response:",
                pe.message,
              );
            }
          } else {
            console.warn(
              "Retriever HTTP returned status",
              resp.status,
              resp.statusText,
            );
          }
        } catch (httpErr) {
          // HTTP retriever failed; attempt legacy python subprocess retriever for compatibility
          try {
            const vectorDir =
              process.env.VECTOR_STORE_DIR ||
              context.path.join(backendDir, "..", "tools", "vector_store");
            const pythonBin = process.env.PYTHON_BIN || "python";
            const retrieverScript = context.path.join(
              backendDir,
              "..",
              "tools",
              "retriever.py",
            );
            // NODE_ENV/NODE_TEST_CONTEXT guard (same convention used
            // throughout this file): this fallback is otherwise gated only
            // by fs.existsSync(vectorDir/retrieverScript), both real files
            // present in this repo, so without it a real `spawnSync` to a
            // real (but test-irrelevant) Python vector index runs on every
            // coding-mode reply a test exercises -- ~20s and fails anyway
            // since there's no matching index.
            const skipUnderTest =
              process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
            if (!skipUnderTest && context.fs.existsSync(vectorDir) && context.fs.existsSync(retrieverScript)) {
              const args = [
                retrieverScript,
                "--index",
                vectorDir,
                "--query",
                transcript,
                "--k",
                "5",
              ];
              const r = context.spawnSync(pythonBin, args, {
                encoding: "utf8",
                // Issue #388: no console flash on the retriever call.
                windowsHide: true,
                maxBuffer: 20 * 1024 * 1024,
              });
              if (!r.error && r.status === 0 && r.stdout) {
                try {
                  const hits = JSON.parse(r.stdout);
                  if (Array.isArray(hits) && hits.length) {
                    const maxChars = Number(
                      process.env.RETRIEVER_MAX_CHARS || 3000,
                    );
                    const pieces = [];
                    let acc = 0;
                    for (let i = 0; i < hits.length; i++) {
                      const h = hits[i];
                      const meta = h.meta || {};
                      const chunk = (meta.text || meta.preview || "").trim();
                      const header = `Source: ${meta.path} [chars ${meta.start_char}-${meta.end_char}]\n`;
                      const snippet = header + chunk + "\n\n";
                      if (acc + snippet.length > maxChars) {
                        break;
                      }
                      pieces.push(
                        `--- Retrieved snippet ${i + 1} ---\n${snippet}--- End snippet ${i + 1} ---`,
                      );
                      acc += snippet.length;
                      if (pieces.length >= 5) break;
                    }
                    if (pieces.length) {
                      retrievedText =
                        "Retrieved repository context:\n\n" +
                        pieces.join("\n\n") +
                        "\n\n";
                    }
                  }
                } catch (pe) {
                  console.warn(
                    "Failed to parse retriever subprocess output:",
                    pe.message,
                  );
                }
              } else if (r.error) {
                console.warn(
                  "Retriever subprocess spawn error:",
                  r.error.message,
                );
              } else if (r.status !== 0) {
                console.warn(
                  "Retriever subprocess exited with status",
                  r.status,
                );
              }
            }
          } catch (subErr) {
            console.warn("Subprocess retriever failed:", subErr.message);
          }
        }
      }
    } catch (e) {
      if (!e || !e.retrievalSkipped) {
        console.warn("Vector retriever failed:", e.message);
      }
    }

    const finalPrompt = (retrievedText || "") + prompt;

    // Issue #623: the reply without its emotion tags, applied wherever a
    // pass produces one; replyMeta.emotion is the face for a client that
    // speaks it as one clip (not streamed, or rewritten after streaming).
    const untag = (text) => {
      if (typeof text !== "string") return text;
      const { text: clean, emotions } = context.stripEmotionTags(text);
      if (replyMeta) replyMeta.emotion = context.replyEmotion(emotions);
      return clean;
    };

    // Try OpenAI/proxy only when explicitly allowed.
    const useRemoteChat = selectedChatModel?.remoteConfig || (!selectedChatModel && context.shouldUseRemoteAi() && !require('../local-only').isLocalOnly());
    if (useRemoteChat) {
      try {
        const openAiReply = untag(await runOpenAIReply(
          finalPrompt,
          effectiveMaxTokens,
          selectedSystemPrompt + flatMemorySuffix,
          sessionId,
          selectedChatModel?.remoteConfig || null,
        ));
        if (openAiReply) {
          if (replyMeta) replyMeta.answerModel = selectedChatModel?.remoteConfig?.model || context.openAiModel();
          console.log("Using OpenAI proxy reply.");
          context.queueVTubeReaction(openAiReply);
          try {
            if (
              sessionId &&
              context.acpMemoryStore &&
              typeof context.acpMemoryStore.appendTurn === "function"
            ) {
              // fire-and-forget but log failures
              context.acpMemoryStore
                .appendTurn({
                  sessionId,
                  user: transcript,
                  assistant:
                    typeof openAiReply === "string" &&
                    typeof context.cleanLlamaOutput === "function"
                      ? context.cleanLlamaOutput(openAiReply)
                      : openAiReply,
                  // #914: history lines are labelled with who said them.
                  speaker: context.characterStore.active().name,
                  answerModel: replyMeta?.answerModel,
                })
                .catch((memErr) =>
                  console.warn(
                    "Failed to append turn to ACP memory:",
                    memErr?.message || memErr,
                  ),
                );
            }
          } catch (memErr) {
            console.warn(
              "Failed to append turn to ACP memory:",
              memErr.message,
            );
          }
          return openAiReply;
        }
      } catch (e) {
        console.warn(
          "OpenAI proxy failed, falling back to local llama:",
          e.message,
        );
      }
    }

    // toolCallingEnabled is declared earlier, alongside the skills-index
    // gate above -- both need the same condition. Any failure or empty
    // result from the tool-aware attempt below falls straight back to the
    // plain path rather than surfacing a broken reply.
    // Captured here rather than threaded through replyMaybeWithBestOfN's and
    // the verify/retry loop's return values (both currently just `string`)
    // -- issue #153 needs whatever tool calls actually produced the reply
    // that gets appended to session memory, and a closure-scoped variable
    // gets that without changing any other reply path's signature.
    let lastToolCalls = [];
    // Issue #673: every tool that has returned so far this turn (across
    // regeneration attempts too), so a memory write can tell whether it may
    // be repeating content a tool brought in (memory-tool-source.js).
    const turnTools = [];

    // Issue #331: onSentence streams only the very first plain local-
    // completion attempt. Regeneration (rut-detection nudge, verify/retry)
    // reuses replyMaybeWithBestOfN/replyMaybeWithTools too, but must not
    // stream again -- multiple overlapping sentence streams from separate
    // generation attempts would be nonsensical to a client. This flag makes
    // "first call only" explicit rather than relying on call order.
    let firstPassStreamed = false;
    const streamedSentences = [];
    // Issue #623: each sentence goes out without its emotion tags, with the
    // face it's said with. An untagged sentence keeps the previous one's;
    // a bare tag (the chunker cut it off as its own "sentence") only sets
    // the face for the next.
    let sentenceEmotion = null;
    const wrappedOnSentence = onSentence
      ? async (tagged) => {
          const { text: sentence, emotions } = context.stripEmotionTags(tagged);
          if (emotions.length) sentenceEmotion = emotions[0];
          if (!sentence) return;
          fallbackAttempt?.markStarted();
          streamedSentences.push(sentence);
          await onSentence(sentence, sentenceEmotion);
        }
      : null;

    // Issue #642: what the reply's own completion was sent -- the user turn
    // and, on the tool-aware path, the tool schemas -- and llama-server's
    // real size of that prompt. A regeneration pass calls this again and
    // the last one wins, same as lastToolCalls. Compared by identity: the
    // runtime keeps a fresh object per completion, so an unchanged one
    // means this pass never reached llama-server (llama-cli fallback).
    let turnToolSchemas = [];
    let turnPromptUsage = null;
    // #646: this pass's entry in GET /agent/activity; its stop flag is
    // read by the executeTool wrapper below.
    let activityRun = null;
    let fallbackAttempt = null;
    async function replyMaybeWithTools(promptText) {
      fallbackAttempt?.signal.throwIfAborted();
      turnToolSchemas = [];
      const usageBefore = context.activeLlamaServerRuntime.getLastPromptUsage?.();
      activityRun = context.agentActivity.start({
        model: String(context.activeLlamaServerRuntime.getStatus?.()?.model || "").split(/[\\/]/).pop() || null,
      });
      // #1122: the Browser tool lists the web pages this turn took in.
      context.activeBrowserAutomationToolSource.activityLog.recordTurnPages(context.untrustedLinks(promptText));
      let reply;
      try {
        reply = await replyMaybeWithToolsUnmetered(promptText);
      } finally {
        context.agentActivity.finish(activityRun);
        // #1159: her task is over; only the tab she's on stays open.
        context.browserAutomationPlugin.closeExtraTabs().catch(() => {});
      }
      const usageAfter = context.activeLlamaServerRuntime.getLastPromptUsage?.();
      turnPromptUsage = usageAfter && usageAfter !== usageBefore ? usageAfter : null;
      compositionTexts["user-turn"] = promptText;
      return reply;
    }

    async function replyMaybeWithToolsUnmetered(promptText) {
      lastToolCalls = [];
      if (
        toolCallingEnabled &&
        normalizedModelProfile === "default" &&
        context.isLlamaServerAvailable()
      ) {
        try {
          // Issue #169/#267: merged fresh per reply, not cached -- MCP tool
          // discovery is async and the registered-server list is small
          // enough that re-listing costs little once a connection is
          // already established (see mcp-client-registry.js). One generic
          // buildToolPolicy call folds in every source at once instead of
          // a hand-rolled buildToolPolicyWithX chain.
          //
          // Memory (issue #198): bound to this reply's sessionId (not
          // model-supplied), built fresh per reply for the same reason --
          // cheap, and the session the fact should be attributed to only
          // exists per-call. approvalGate: a model-asserted memory write is
          // agent-authored content same as a skill write (issue #152) --
          // gated the same way, see ai/memory-tool-source.js.
          //
          // Session search: full-text search across past conversations,
          // independent of the curated memory summary above.
          //
          // Skill creation (issue #262 follow-up): user-requested mid-
          // conversation ("make a skill that does X") -- distinct from the
          // idle-triggered autonomous proposal pass, which nobody
          // explicitly asked for. Despite the direct ask, this still stays
          // genuinely pending like the idle pass does, not auto-approved
          // like the Settings UI's own create flow -- the drafted content
          // is the model's own text, not the user's verbatim words, and a
          // page Mana read earlier in the same turn could otherwise talk
          // it into staging attacker-authored content (see
          // ai/skill-tool-source.js).
          //
          // Browser automation (issue #188): only offered when the plugin
          // is actually enabled (Settings > Plugins) -- same gate every
          // other browser-automation entry point (its own HTTP routes,
          // GET /plugins) already respects.
          // #1158: files whose full path I write in my own chat message are
          // the ones her browser may upload (never ones she picks herself).
          if (userChat) context.browserAutomationPlugin.offerFilesFromMessage(transcript);
          let mergedToolPolicy = await context.buildToolPolicy(context.activeToolPolicy, [
            context.activeMcpClientRegistry,
            context.createMemoryToolSource({
              acpMemoryStore: context.acpMemoryStore,
              sessionId,
              approvalGate: context.activeApprovalGate,
              // Issue #317: deliberately `transcript` (the raw user turn),
              // not `prompt`/`finalPrompt` -- both of those are already
              // blended with screen OCR, market data, and retrieved web
              // content by this point, which would let a memory__remember
              // call "attribute" itself to injected content instead of
              // something the user actually said.
              userMessage: transcript,
              // Issue #431: LLM-confirmed conflict judging -- never loads
              // or swaps a model, see llamaServerRuntime's own comment on
              // isProfileAlreadyLoaded/runLocalReplyIfSafelyLoaded.
              runLocalReply: context.llamaServerRuntime.runLocalReplyIfSafelyLoaded,
              turnTools,
            }),
            context.createSessionSearchToolSource({ acpMemoryStore: context.acpMemoryStore, sessionId }),
            ...(context.projectReferences ? [context.projectReferences.toolSource(sessionId)] : []),
            context.createSkillToolSource({ approvalGate: context.activeApprovalGate, skillsStore: context.activeSkillsStore }),
            ...(userChat ? [createAnalysisToolSource({
              env: context.deps.env || process.env,
              userMessage: transcript,
              runSandbox: context.deps.runAnalysisSandbox,
              onCharts: charts => analysisCharts.push(...charts.slice(0, 4 - analysisCharts.length)),
            })] : []),
            context.createSnapshotToolSource({
              approvalGate: context.activeApprovalGate,
              snapshotStore: context.snapshotStore,
              // Issue #475 whole-branch review: without this, a file-kind
              // restore skips the workspace-containment check that
              // getEditorIntegrations().restoreEditSnapshot already
              // enforces for the REST/UI restore path.
              restoreFileSnapshot: (id, opts) => context.getEditorIntegrations().restoreEditSnapshot(id, opts),
            }),
            // Issue #253: lets Mana pick her own Live2D expression for this
            // reply, alongside (not instead of) reply-emotion.js's automatic
            // detection. No approvalGate/store needed -- see
            // ai/expression-tool-source.js's own header comment for why.
            context.createExpressionToolSource(),
            // #923/#925: speech words and mishearing fixes I ask for;
            // only words from this turn's own text (see the source).
            context.createSpeechToolSource({ speechVocabulary: context.speechVocabulary, userMessage: transcript }),
            // Issue #417: lets Mana decide mid-reply that seeing the screen
            // would help, instead of vision only being reachable via the
            // hotkey or the ambient screen-sensing loop. Same
            // deps.X || fallback resolution registerCoreRoutes's deps use
            // for these two below (server.js:4742-4747) -- no single
            // shared local exists at this point in registerRoutes to reuse.
            context.createVisionToolSource({
              getVisionStatus:
                context.deps.getVisionStatus || (() => context.llamaServerRuntime.getVisionStatus()),
              runVisionReply:
                context.deps.runVisionReply ||
                ((prompt, images, maxTokens) =>
                  context.llamaServerRuntime.runVisionReply(prompt, images, maxTokens)),
              visionCaptureBridge: context.visionCaptureBridge,
              screenSensingPlugin: context.screenSensingPlugin,
              pluginSettingsStore: context.activePluginSettingsStore,
            }),
            // Issue #276: draft a proposed code change as a diff file
            // instead of editing live -- reuses the existing editor
            // workspace/proposal machinery (zed-integration.js) that
            // already backs the /editors/* admin routes, just stops short
            // of ever calling approveEditProposal.
            // #787: approvalGate enables coding__run_tests (asks first).
            context.createCodingToolSource({ editors: context.getEditorIntegrations(), approvalGate: context.activeApprovalGate, reviewEdit: context.reviewEdit }),
            ...(context.isPluginEnabled(context.browserAutomationPlugin, context.activePluginSettingsStore)
              ? [context.activeBrowserAutomationToolSource.forSession?.(sessionId) || context.activeBrowserAutomationToolSource]
              : []),
            // Issue #401: only offered when this session actually has a
            // goal set -- there's nothing to finish otherwise, and no
            // reason to spend schema tokens advertising it on every reply.
            ...(sessionGoal ? [context.createSessionGoalToolSource()] : []),
            // #675 Q12b: Mana turns deep thinking on/off herself; the rest
            // of this reply's tool rounds follow it at once.
            // #905: reminders the user asks for in chat -- not offered to
            // scheduled replies, which nobody is asking in.
            ...(userChat ? [context.createReminderToolSource({ getScheduler: context.cronSchedulerPlugin.getScheduler, sessionId })] : []),
            // #1282: "not now", "don't bring this up again", quiet hours.
            ...(userChat ? [context.createProactiveToolSource({ proactive: require("../proactive") })] : []),
            // #1010: "let me try your PR" / "back to main" -- a PR number
            // only from my own message. #1194: "update to main" asks me first.
            ...(userChat
              ? [
                  context.createTryPrToolSource({
                    userMessage: transcript,
                    revert: context.reverter.revert,
                    approvalGate: context.activeApprovalGate,
                    isGaming: context.deps.isGaming || context.gamingWatch.isGaming,
                  }),
                ]
              : []),
            // #1008: "work on #N" -- only a number from my own message.
            ...(userChat ? [context.selfWork.chatToolSource(transcript, { sessionId })] : []),
            // #1182: git and GitHub, only in my own chat.
            ...(userChat ? [context.gitTools] : []),
            // #906: my email and calendar, only in my own chat (never a
            // scheduled reply or a Discord/Telegram bridge).
            ...(userChat
              ? [context.createMailCalendarToolSource({ store: context.mailCalendarSettings, approvalGate: context.activeApprovalGate })]
              : []),
            // #911: media keys, volume, apps, audio output, file moves --
            // only when I'm asking.
            ...(userChat
              ? [
                  context.createDesktopToolSource({
                    bridge: context.visionCaptureBridge,
                    isGaming: context.deps.isGaming || context.gamingWatch.isGaming,
                    voice: replyMeta.voice === true,
                    snapshotStore: context.snapshotStore,
                  }),
                ]
              : []),
            // #907: "brief me".
            ...(userChat ? [context.briefing.toolSource] : []),
            // #914: her own notes on our relationship.
            // Each new note is a chat line (replyMeta.onNoted), so I see it.
            ...(userChat
              ? [
                  context.createRelationshipToolSource({
                    store: context.relationshipStore,
                    onNoted: ({ kind, id, text, date }) => {
                      const character = context.characterStore.active();
                      replyMeta.onNoted?.({ kind, id, text, date, character: character.id, characterName: character.name });
                    },
                  }),
                ]
              : []),
            ...(userChat
              ? [
                  context.createDeepThinkingToolSource({
                    onSet: (on) => {
                      // Already on for this reply: asking again mustn't
                      // restart the 10-reply cap.
                      if (!(on && manaThinking)) context.deepThinking.set(sessionId, on);
                      replyMeta.deepThinking = context.deepThinking.isOn(sessionId);
                      thinkHarder = askedThinkHarder || on || undefined;
                    },
                  }),
                ]
              : []),
          ]);
          // #1318: command and sub-task tools ask for a `description`.
          mergedToolPolicy = context.withStepDescriptions(mergedToolPolicy);
          // #1318: a step held in the approval queue shows as awaiting
          // approval in the chat and activity panel until it's answered.
          const stepApprovalGate = new context.Proxy(context.activeApprovalGate, {
            get(target, prop) {
              const value = context.Reflect.get(target, prop, target);
              if (typeof value !== "function") return value;
              if (prop !== "requestApproval") return value.bind(target);
              return async (...request) => {
                reportTool(activityRun.tool, "waiting");
                try {
                  return await value.apply(target, request);
                } finally {
                  reportTool(activityRun.tool, "resumed");
                }
              };
            },
          });
          // Issue #281: on the "fast" (small) profile, protect its limited
          // context from a large tool catalogue and from raw tool-result
          // payloads -- both reuse this same already-loaded model rather
          // than a dedicated filter model, and both are pure best-effort
          // (any failure falls back to the unfiltered/uncompressed
          // behavior, never blocks the reply). Skipped entirely on
          // "quality"/"coding" profiles, which have the context headroom
          // to not need either pass.
          if (context.modelManagement.getActiveProfile() === "fast") {
            mergedToolPolicy.tools = await context.filterRelevantTools({
              tools: mergedToolPolicy.tools,
              queryText: promptText,
              runLocalReply: context.runLocalLlamaReply,
            });
            mergedToolPolicy = context.wrapWithResultDigest(mergedToolPolicy, {
              runLocalReply: context.runLocalLlamaReply,
            });
          }
          // Issue #426: the user's own PreToolUse/PostToolUse-style hook
          // rules (deny/ask/run-command), applied *before* (wrapped inside)
          // wrapWithToolCallLog below -- so a denied or ask-gated call still
          // lands in the audit trail as its own logged event, additive to
          // both existing gates rather than replacing either.
          mergedToolPolicy = context.wrapWithHooks(mergedToolPolicy, context.activeHooksStore, stepApprovalGate, {
            snapshotStore: context.snapshotStore,
          });
          // Issue #669: per-call risk tiers. Destructive calls (rm -rf,
          // registry edits, iwr | iex, credential files...) always go to a
          // human; the mode (Settings > Approvals, else MANA_TOOL_APPROVAL,
          // else "smart") decides the rest. Outside
          // wrapWithHooks so a destructive call is reviewed before any hook
          // runs; inside wrapWithToolCallLog so the outcome is logged.
          // #699: a heartbeat check brings its own gate (its grants and
          // scope) in place of this one.
          mergedToolPolicy =
            typeof replyMeta?.wrapToolPolicy === "function"
              ? replyMeta.wrapToolPolicy(mergedToolPolicy, context.activeApprovalGate)
              : context.wrapWithRiskGate(mergedToolPolicy, stepApprovalGate, {
                  mode: context.resolveToolApprovalMode(
                    context.activeApprovalGate.getToolApprovalMode(),
                    (context.deps.env || process.env).MANA_TOOL_APPROVAL,
                  ),
                  // A web page, search/wiki results or the browser tab
                  // (framed by ai/untrusted-content.js) came in with the turn.
                  untrustedSources: context.untrustedSources(`${promptText}\n${projectReferenceText}`),
                });
          // Issue #188: applied last so it catches every tool call from
          // every source (local read_file, browser-automation, MCP) in one
          // shared audit/trace log.
          mergedToolPolicy = context.wrapWithToolCallLog(mergedToolPolicy, context.activeToolCallLog, () =>
            context.activeMoodStore.record("task_failed"),
          );
          // #486: modify-input hook rules rewrite args first, so every gate
          // above and the audit log see the rewritten call, never the original.
          mergedToolPolicy = context.wrapWithInputHooks(mergedToolPolicy, context.activeHooksStore);
          const executeLoggedTool = mergedToolPolicy.executeTool;
          // #661: /reply/stream relays tool start/end so the avatar can
          // show she's working. expression__set is her face, not work.
          const onToolCall =
            replyMeta && typeof replyMeta.onToolCall === "function" ? replyMeta.onToolCall : null;
          const run = activityRun;
          // #1318: each step's description/status/duration goes to the
          // activity record and, as a "tool" event, to the chat's step lines.
          const reportTool = (name, phase, extra) => {
            if (!name || context.isExpressionToolName(name)) return;
            const step =
              phase === "start"
                ? context.agentActivity.toolStarted(run, name, extra)
                : phase === "waiting" || phase === "resumed"
                  ? context.agentActivity.toolWaiting(run, phase === "waiting")
                  : context.agentActivity.toolEnded(run, name, extra);
            if (!onToolCall) return;
            try {
              onToolCall({ ...step, name, phase });
            } catch (e) {}
          };
          mergedToolPolicy.executeTool = async (name, args) => {
            fallbackAttempt?.markStarted();
            // #646: Stop from the activity panel. The tool already running
            // finishes; every later call is refused, so the model answers
            // or the loop's own 3-consecutive-errors cap makes it.
            // ponytail: no runtime change (it's mid-edit in #770/#787) --
            // a stop check in runToolAwareReply's budget test would end
            // the loop without those extra refused rounds.
            if (run.stopRequested) {
              throw new Error("Stopped by the user. Don't call any more tools; answer with what you have.");
            }
            reportTool(name, "start", context.stepInfo(name, args));
            let ok = false;
            let result;
            try {
              // #1121: a command this call runs is stopped by this loop's Stop.
              result = await context.terminalFeed.runWith({ stop: () => context.agentActivity.stop(run.id) }, () =>
                executeLoggedTool(name, args),
              );
              turnTools.push(name);
              ok = true;
              return result;
            } catch (error) {
              if (name === 'analysis__run_python') result = error.message;
              throw error;
            } finally {
              reportTool(name, "end", {
                ok,
                result: ok || name === 'analysis__run_python'
                  ? context.trimResult(result, name === 'analysis__run_python' ? 30000 : undefined) : undefined,
                tokens: context.activeLlamaServerRuntime.getLastPromptUsage?.()?.promptTokens,
                // #1337: a background task it started gets its own chat line.
                task: ok ? context.launchedTask(result) : undefined,
              });
            }
          };
          // #1337: what she says before a tool round is part of the reply:
          // streamed as it comes and kept ahead of her answer. A step's
          // textOffset is the reply's length when its round started. Joined
          // by single spaces so the offsets hold in the saved turn too (its
          // text is whitespace-collapsed by acp-memory-store's cleanText).
          const streamThisPass = Boolean(wrappedOnSentence && !firstPassStreamed);
          const say = async (text) => {
            firstPassStreamed = true;
            const chunker = context.createSentenceChunker();
            for (const sentence of [...chunker.push(text), ...chunker.flush()]) {
              await wrappedOnSentence(sentence);
            }
          };
          let shownText = "";
          const toolResult = await context.runToolAwareReply(
            promptText,
            mergedToolPolicy,
            {
              maxTokens: effectiveMaxTokens,
              profile: normalizedModelProfile,
              overrideSystemPrompt: selectedSystemPrompt,
              extraMessages: memoryExtraMessages,
              thinking: () => thinkHarder,
              goal: goalMode ? sessionGoal : null,
              onRoundText: async (text) => {
                const clean = context.stripEmotionTags(text).text.replace(/\s+/g, " ").trim();
                if (streamThisPass) await say(text);
                if (clean) shownText = shownText ? `${shownText} ${clean}` : clean;
                context.agentActivity.textShown(run, shownText.length);
              },
            },
          );
          if (toolResult.content && toolResult.content.trim()) {
            if (toolResult.toolCalls.length) {
              lastToolCalls = toolResult.toolCalls;
              console.log(
                `Mana tool-calling (${toolResult.rounds} round(s)): ${toolResult.toolCalls
                  .map((call) => `${call.name}(${call.ok ? "ok" : "error"})`)
                  .join(", ")}`,
              );
              // Issue #253: reported via the replyMeta out-parameter, not a
              // return-value change -- buildAssistantReply's return type
              // stays a plain string for every one of its 5 call sites
              // (mana-acp-agent.js, mobile-routes.js x2, server-routes.js x2),
              // same reasoning already documented above for lastToolCalls.
              if (replyMeta) {
                // Last successful call wins, not first -- runToolAwareReply
                // supports multiple tool-calling rounds, so a model that
                // calls expression__set more than once in one reply is
                // revising its choice; the final pick is the one that
                // reflects "Mana's expression for this reply."
                const expressionCall = [...toolResult.toolCalls]
                  .reverse()
                  .find((call) => context.isExpressionToolName(call.name) && call.ok);
                if (expressionCall) {
                  const name = String(expressionCall.args?.name || "").trim();
                  if (name) replyMeta.expression = name;
                }
              }
            }
            turnToolSchemas = mergedToolPolicy.tools;
            // Issue #623: the tool path isn't streamed, so the finished reply
            // goes out sentence by sentence here, each with its own face,
            // instead of as one clip with one face.
            if (streamThisPass) await say(toolResult.content);
            return shownText ? `${shownText} ${toolResult.content}` : toolResult.content;
          }
          console.warn(
            "Tool-aware reply returned empty content; falling back to the plain reply path",
          );
        } catch (e) {
          if (e?.code === 'LOCAL_CLEANUP_FAILED') throw e;
          fallbackAttempt?.signal.throwIfAborted();
          console.warn(
            "Tool-aware reply failed, falling back to plain reply:",
            e && e.message ? e.message : e,
          );
        }
      }
      if (wrappedOnSentence && !firstPassStreamed && context.isLlamaServerAvailable()) {
        // Set before the attempt, not just on success -- sentences may
        // already have been emitted (and possibly spoken client-side)
        // before a failure, so a later regeneration must not stream again.
        firstPassStreamed = true;
        try {
          return await context.activeLlamaServerRuntime.streamLocalAssistantReply(promptText, {
            maxTokens: effectiveMaxTokens,
            profile: normalizedModelProfile,
            overrideSystemPrompt: selectedSystemPrompt,
            extraMessages: memoryExtraMessages,
            onSentence: wrappedOnSentence,
            onThought: replyMeta?.onThought,
            onThoughtDone: (thought) => {
              if (replyMeta) replyMeta.thought = thought;
            },
            thinking: thinkHarder,
          });
        } catch (e) {
          if (e?.code === 'LOCAL_CLEANUP_FAILED') throw e;
          fallbackAttempt?.signal.throwIfAborted();
          console.warn(
            "Streaming local reply failed, falling back to non-streaming:",
            e && e.message ? e.message : e,
          );
        }
      }
      if (memoryExtraMessages && replyMeta) {
        memoryExtraMessages.onThoughtDone = (thought) => {
          replyMeta.thought = thought;
        };
      }
      return context.runLocalAssistantReply(
        promptText,
        effectiveMaxTokens,
        normalizedModelProfile,
        selectedSystemPrompt,
        memoryExtraMessages,
        () => replyWithBackup(promptText),
        thinkHarder,
      );
    }

    // Best-of-N self-voting (issue #70), opt-in and scoped to coding-mode
    // replies. Layers on top of replyMaybeWithTools rather than replacing
    // the reply pipeline: on any failure or empty result it falls through
    // to the same tool-calling-or-plain path above, and the existing
    // verify/retry pass below still gates whatever reply comes out of here,
    // exactly as it already does for every other reply path.
    const bestOfNEnabled =
      String(process.env.MANA_BEST_OF_N_ENABLED || "0") === "1";
    async function replyMaybeWithBestOfN(promptText) {
      fallbackAttempt?.signal.throwIfAborted();
      if (
        bestOfNEnabled &&
        !goalMode &&
        // #679: Best-of-N builds its own messages without the images.
        !replyMeta?.images?.length &&
        mode === "coding" &&
        !thinkHarder &&
        context.isLlamaServerAvailable()
      ) {
        try {
          const n = Number(process.env.MANA_BEST_OF_N_COUNT || 3);
          const result = await context.runBestOfNReply(promptText, {
            signal: memoryExtraMessages.signal,
            onReplyStarted: memoryExtraMessages.onReplyStarted,
            n,
            maxTokens: effectiveMaxTokens,
            profile: normalizedModelProfile,
            overrideSystemPrompt: selectedSystemPrompt + flatMemorySuffix,
          });
          if (result.content && result.content.trim()) {
            // Issue #159: rather than trusting the judge's pick blindly,
            // prefer whichever already-generated candidate is least
            // similar to Mana's recent replies in this session -- no
            // extra network call, since Best-of-N already paid for all N.
            let selected = { content: result.content, index: result.judgeIndex, switched: false };
            if (sessionId && context.acpMemoryStore && result.candidates.length > 1) {
              const recentReplies = (context.acpMemoryStore.getSession(sessionId)?.turns || [])
                .map((t) => t.assistant)
                .filter(Boolean);
              selected = context.rutDetector.pickLeastRepetitive(
                sessionId,
                result.candidates,
                result.judgeIndex,
                recentReplies,
              );
              if (selected.switched) {
                console.log(
                  `Mana rut detection: swapped judge's pick for candidate ${selected.index + 1}/${result.candidates.length} (less repetitive)`,
                );
              }
            }
            console.log(
              `Mana best-of-N: judge picked candidate ${result.judgeIndex + 1}/${result.candidates.length}`,
            );
            return selected.content;
          }
          console.warn(
            "Best-of-N reply returned empty content; falling back to the plain reply path",
          );
        } catch (e) {
          if (e?.code === 'LOCAL_CLEANUP_FAILED') throw e;
          fallbackAttempt?.signal.throwIfAborted();
          console.warn(
            "Best-of-N reply failed, falling back to plain reply:",
            e && e.message ? e.message : e,
          );
        }
      }
      return replyMaybeWithTools(promptText);
    }

    const BACKUP_NOTICE = "My main model isn't answering, so I'm using my backup.";
    const fallbackConfig = replyMeta && !replyMeta.scheduled && !selectedChatModel?.remoteConfig && !selectedChatModel?.localOnly ? context.openAiFallbackConfig?.() : null;
    fallbackAttempt = (context.createChatAttempt || require('./chat-attempt').createChatAttempt)(fallbackConfig?.timeoutSeconds);
    memoryExtraMessages.signal = fallbackAttempt.signal;
    memoryExtraMessages.onReplyStarted = fallbackAttempt.markStarted;
    memoryExtraMessages.requireCancellable = [30, 60].includes(fallbackConfig?.timeoutSeconds);
    let replyWithBackup;
    try {
    let usedBackup = false;
    // #666: wait out a llama-server (re)start instead of failing the turn,
    // telling a streaming client once, as a spoken sentence. Not in
    // streamedSentences, so it never counts against streamedMatchesFinal.
    // If nothing comes up, the paths below fall back to llama-cli as before.
    // Gated on the runtime's own isEnabled (false under the test runner), not
    // the deps.isLlamaServerEnabled override: a test that only stubs that
    // override must never reach a real llama-server start from here.
    if (
      context.activeLlamaServerRuntime.waitForServer &&
      context.activeLlamaServerRuntime.isEnabled()
    ) {
      try {
        const readyProfile = await context.activeLlamaServerRuntime.waitForServer(
          normalizedModelProfile,
          onSentence ? () => onSentence("Give me a second, I'm waking up.") : null,
          memoryExtraMessages.images,
          { signal: fallbackAttempt.signal },
        );
        if (readyProfile !== normalizedModelProfile) {
          console.warn(`Mana: ${normalizedModelProfile} model unavailable, answering with ${readyProfile}`);
          if (onSentence) onSentence(BACKUP_NOTICE);
          normalizedModelProfile = readyProfile;
          usedBackup = true;
        }
      } catch (e) {
        if (e?.code === 'LOCAL_CLEANUP_FAILED') throw e;
        console.warn("llama-server still unavailable after waiting:", e && e.message ? e.message : e);
      }
    }

    // #666: an empty reply (after the runtime's own retry) gets one try on
    // the backup model before llama-cli -- once per turn, including a switch
    // the wait above already made, so the notice is said at most once.
    replyWithBackup = async function replyWithBackup(promptText) {
      if (usedBackup) return null;
      usedBackup = true;
      try {
        const backup = context.activeLlamaServerRuntime.backupProfileFor?.(normalizedModelProfile);
        if (!backup) return null;
        const backupReply = await context.activeLlamaServerRuntime.runLocalAssistantReply(
          promptText,
          effectiveMaxTokens,
          backup,
          selectedSystemPrompt,
          memoryExtraMessages,
        );
        console.warn(`Mana: ${normalizedModelProfile} model gave an empty reply, answered with ${backup}`);
        if (onSentence) onSentence(BACKUP_NOTICE);
        normalizedModelProfile = backup;
        return backupReply;
      } catch (e) {
        if (e?.code === 'LOCAL_CLEANUP_FAILED') throw e;
        fallbackAttempt.signal.throwIfAborted();
        console.warn("Backup model reply failed, falling back to llama-cli:", e && e.message ? e.message : e);
        return null;
      }
    }

    // Fall back to local llama
    let reply;
    let localError;
    try { reply = untag(await replyMaybeWithBestOfN(finalPrompt)); }
    catch (error) { localError = error; }
    if (localError?.code === 'LOCAL_CLEANUP_FAILED') throw localError;
    if (!(typeof reply === 'string' && reply.trim())) {
      if (fallbackConfig && !fallbackAttempt.started) {
        fallbackAttempt.close();
        const permittedFallback = context.openAiFallbackConfig?.();
        const fallbackReply = permittedFallback ? untag(await runOpenAIReply(finalPrompt, effectiveMaxTokens, selectedSystemPrompt + flatMemorySuffix, sessionId, permittedFallback)) : null;
        if (fallbackReply) {
          if (replyMeta) { replyMeta.cloudFallback = true; replyMeta.answerModel = permittedFallback.model; }
          reply = fallbackReply;
        }
      }
      if (!reply && localError) throw localError;
    }
    fallbackAttempt.close();
    if (replyMeta && !replyMeta.answerModel) replyMeta.answerModel = context.activeLlamaServerRuntime.getStatus?.()?.model?.split(/[\\/]/).pop() || `Local: ${normalizedModelProfile}`;

    // Conversational rut detection (issue #159), general reply path: the
    // Best-of-N branch above already prefers a less-repetitive candidate
    // when one exists, but every reply -- Best-of-N or not -- funnels
    // through here, so this is where casual/everyday replies (where
    // verbal-tic repetition actually shows up) get covered too. Only one
    // regeneration attempt, with an explicit nudge -- if that's still a
    // rut, send it rather than looping.
    try {
      const rutEnabled = String(process.env.MANA_RUT_DETECTION_ENABLED || "1") === "1";
      // #676: never regenerate a goal-mode reply -- that reruns the whole loop, tool calls included.
      if (rutEnabled && !replyMeta?.cloudFallback && !goalMode && sessionId && context.acpMemoryStore && typeof reply === "string") {
        const recentReplies = (context.acpMemoryStore.getSession(sessionId)?.turns || [])
          .map((t) => t.assistant)
          .filter(Boolean);
        const check = context.rutDetector.checkReply(sessionId, reply, recentReplies);
        if (check.isRut) {
          const nudgedPrompt = `${finalPrompt}\n\nYour last several replies have repeated similar phrasing. Say this differently -- vary your wording and sentence structure instead of reusing recent lines.`;
          const regenerated = await replyMaybeWithBestOfN(nudgedPrompt);
          if (typeof regenerated === "string" && regenerated.trim()) {
            reply = untag(regenerated);
            context.rutDetector.recordIntervention(sessionId);
            console.log("Mana rut detection: regenerated a repetitive reply with a phrasing nudge");
          }
        }
      }
    } catch (e) {
      console.warn("Rut detection check failed:", e?.message || e);
    }
    context.queueVTubeReaction(reply);

    // Token-budget accounting: estimate reply tokens and deduct from session budget
    try {
      const talkBudget = require("../utils/talk_budget");
      try {
        const tokenCount =
          await require("../tools/python_token_cache.async").countTokensForText(
            typeof reply === "string" ? reply : String(reply),
            ".py",
            false,
          );
        const sessionKey = sessionId || "global";
        const consumeRes = talkBudget.consumeTokens(sessionKey, tokenCount);
        if (!consumeRes.ok) {
          console.warn(
            `Talk budget exceeded for session ${sessionKey}: attempted ${tokenCount} tokens, remaining ${consumeRes.remaining}`,
          );
        }
        // record perf metric (perfMetrics.operations is a label->stats map,
        // same shape logPerf uses; GET /perf/status returns it as-is)
        context.perfMetrics.operations.reply_token_usage = {
          lastTokens: tokenCount,
          session: sessionKey,
          updatedAt: new Date().toISOString(),
        };
      } catch (e) {
        console.warn("Failed to account for reply tokens:", e?.message || e);
      }
    } catch (e) {
      // if talk budget module missing, skip
    }

    // Optional verification and auto-retry logic
    try {
      const { verifyReply } = require("../utils/reply-verifier");
      const verifyEnabled =
        String(process.env.MANA_VERIFY_REPLY || "0") === "1";
      const autoRetry =
        String(process.env.MANA_AUTO_RETRY_VERIFICATION || "0") === "1";
      const maxRetries = Number(process.env.MANA_VERIFY_MAX_RETRIES || 1);

      if (verifyEnabled && !replyMeta?.cloudFallback) {
        let attempts = 0;
        while (true) {
          attempts += 1;
          const verification = await verifyReply(
            typeof reply === "string" ? reply : String(reply),
            assistantMode || "everyday",
          );
          if (verification.ok) {
            // verified
            break;
          }

          console.warn("Reply verification failed:", verification.issues);
          if (autoRetry && !goalMode && attempts <= maxRetries) {
            // Ask the model to fix its previous reply
            const fixPrompt =
              finalPrompt +
              "\n\nThe assistant produced a reply that failed verification.\nPlease regenerate the reply and fix the following issues:\n" +
              verification.issues
                .map((i) => `- ${i.type}: ${i.message}`)
                .join("\n") +
              "\nReturn only the reply.";
            console.log(
              "Attempting auto-retry of assistant reply (attempt",
              attempts,
              ")",
            );
            try {
              reply = untag(await replyMaybeWithBestOfN(fixPrompt));
              context.queueVTubeReaction(reply);
              continue; // re-verify
            } catch (retryErr) {
              console.warn("Auto-retry failed:", retryErr?.message || retryErr);
              break;
            }
          }

          break;
        }
      }
    } catch (e) {
      console.warn("Reply verification unavailable:", e?.message || e);
    }

    // Anti-formulaic-phrasing rewrite pass (issue #160): runs last, right
    // before the reply is recorded/returned, since the verify/retry loop
    // above can still replace `reply` wholesale -- this needs to see
    // whatever text will actually be spoken, not an intermediate draft.
    try {
      const phrasingEnabled =
        String(process.env.MANA_PHRASING_VARIATION_ENABLED || "1") === "1";
      if (phrasingEnabled && !replyMeta?.cloudFallback && sessionId && typeof reply === "string") {
        const check = context.phrasingVariator.checkReply(sessionId, reply);
        if (check.isPredictable) {
          const alt = await context.rewritePhrase(check.match.matchedText, {
            synthesize: (prompt) =>
              context.runLocalAssistantReply(
                prompt,
                40,
                normalizedModelProfile,
                "You are a concise writing assistant. Follow instructions exactly and reply with only what was asked for.",
              ),
          });
          if (alt && alt.trim() && alt.toLowerCase() !== check.match.matchedText.toLowerCase()) {
            reply = reply.replace(check.match.matchedText, alt.trim());
            console.log("Mana phrasing variation: rewrote a repeated catchphrase/opener");
          }
        }
        const finalMatch = context.phrasingVariator.findLexiconMatch(reply);
        if (finalMatch) context.phrasingVariator.recordUsage(sessionId, finalMatch.id);
      }
    } catch (e) {
      console.warn("Phrasing variation check failed:", e?.message || e);
    }

    if (analysisCharts.length) reply = String(reply || '') + chartArtifact(analysisCharts);
    try {
      if (
        sessionId &&
        context.acpMemoryStore &&
        typeof context.acpMemoryStore.appendTurn === "function"
      ) {
        context.acpMemoryStore
          .appendTurn({
            sessionId,
            user: transcript,
            assistant:
              typeof reply === "string" &&
              typeof context.cleanLlamaOutput === "function"
                ? context.cleanLlamaOutput(reply)
                : reply,
            thought: replyMeta?.thought || null,
            toolCalls: lastToolCalls,
            // #1337: the reply's step lines, for the chat when it's reopened.
            steps: activityRun ? context.agentActivity.steps(activityRun.id) : null,
            speaker: context.characterStore.active().name,
            answerModel: replyMeta?.answerModel,
            cloudFallback: replyMeta?.cloudFallback,
          })
          .catch((memErr) =>
            console.warn(
              "Failed to append turn to ACP memory:",
              memErr?.message || memErr,
            ),
          );
      }
    } catch (memErr) {
      console.warn("Failed to append turn to ACP memory:", memErr.message);
    }
    if (replyMeta) {
      replyMeta.streamedMatchesFinal = context.streamedMatchesFinal(streamedSentences, reply);
    }
    // #642 (Q33c): once per conversation, at 90% of the context window,
    // Mana ends this reply by suggesting a fresh chat. Added after the
    // stream check (like #666's notice, it's an extra sentence, not a
    // changed reply) and after the turn went to memory. Rides on a reply
    // the user asked for, so it's fine while gaming too.
    const contextSize = turnPromptUsage ? await context.activeLlamaServerRuntime.getContextSize?.() : null;
    const fullNote = turnPromptUsage && typeof reply === "string"
      ? context.contextFullNote(sessionId, turnPromptUsage.promptTokens, contextSize)
      : "";
    if (fullNote) {
      reply = `${reply.trimEnd()} ${fullNote}`;
      // Streamed and unchanged: speak it as one more sentence. Otherwise the
      // client speaks the final reply, which now ends with it.
      if (onSentence && replyMeta?.streamedMatchesFinal) await onSentence(fullNote);
    }
    // Issue #642: the context meter (GET /prompt-composition/:sessionId).
    // Not awaited -- a few local /tokenize calls are never worth delaying
    // the reply for; until they land the record shows char/4 estimates.
    if (compositionRecord) {
      const isMcp = (tool) => String(tool?.function?.name || "").startsWith("mcp__");
      const localTools = turnToolSchemas.filter((tool) => !isMcp(tool));
      const mcpTools = turnToolSchemas.filter(isMcp);
      (async () =>
        context.finalizePromptComposition(compositionRecord, {
          texts: {
            ...compositionTexts,
            "tool-schemas": localTools.length ? JSON.stringify(localTools) : "",
            "mcp-tool-schemas": mcpTools.length ? JSON.stringify(mcpTools) : "",
          },
          promptUsage: turnPromptUsage,
          contextSize: contextSize ?? (await context.activeLlamaServerRuntime.getContextSize?.()),
          countTokens: context.activeLlamaServerRuntime.countTokens,
        }))().catch((e) => console.warn("Failed to finalize prompt composition:", e?.message || e));
    }
    return reply;
    } finally { fallbackAttempt.close(); }
  }

async function buildGroupReaction({ sessionId, userText, sister, reply }) {
    const me = context.characterStore.active();
    const system = [
      context.persona.buildPersonaPrompt(sessionId, context.personalityStore.get().traits, context.personaOf(me)),
      context.moodPromptBlock(context.activeMoodStore.get(), "casual"),
    ]
      .filter(Boolean)
      .join("\n\n");
    const prompt = `I said: "${userText}"\n\nYour sister ${sister.name} answered: "${reply}"\n\nAdd one short reaction to her, one or two short sentences, as yourself. Don't repeat what she said.`;
    const raw = context.shouldUseRemoteAi()
      ? await runOpenAIReply(prompt, context.GROUP_REACTION_MAX_TOKENS, system, sessionId)
      : await context.runLocalAssistantReply(prompt, context.GROUP_REACTION_MAX_TOKENS, "default", system);
    return context.cleanLlamaOutput(context.stripEmotionTags(String(raw || "")).text).trim();
  }

  return { buildScreenAwarePrompt, runOpenAIReply, pickAssistantMode, buildAssistantReply, buildGroupReaction };
}

module.exports = { createChatReply };
