function createCompletions(context) {
// Issue #282: splices caller-supplied memory entries into the message
  // array at either end -- "early" right after the persona system message,
  // "late" right before the live user message (the higher-salience
  // position, closest to what's actually being asked). Omitting
  // extraMessages entirely preserves today's exact 2-message shape.
  // Issue #660: "early" is only for content that is stable across turns --
  // anything there becomes part of the prompt prefix llama-server's prompt
  // cache reuses, so per-turn content there would invalidate it each turn.
  //
  // Only the first message may be system-role: Qwen3.5's chat template (the
  // default model) raises "System message must be at the beginning" for any
  // later one, and llama-server answers 500 -- so every turn with memory
  // fell back to llama-cli. System-role entries are folded instead: early
  // ones into the leading system message (where they already sat), late
  // ones onto the front of the live user message (still last in the prompt,
  // so the stable prefix stays cacheable, #660). Other roles pass through.
  //
  // #679: extraMessages.images (data URLs) ride on the live user message,
  // but only when the running server has an mmproj -- a text-only server
  // (a backup profile, say) would reject the whole request, so they are
  // dropped there and the model answers from the text alone.
  // Bare base64 becomes a data URL (runVisionReply's rule); anything else
  // that isn't one stays unusable to llama-server rather than a URL it fetches.
  function toImageDataUrl(image) {
    return String(image).startsWith("data:") ? String(image) : `data:image/png;base64,${image}`;
  }

function buildMessages(systemContent, prompt, extraMessages) {
    const early = extraMessages?.early || [];
    const late = extraMessages?.late || [];
    const systemText = (entries) => entries.filter((m) => m.role === "system").map((m) => m.content);
    const nonSystem = (entries) => entries.filter((m) => m.role !== "system");
    const lateText = systemText(late);
    const userText = [...lateText, prompt].join("\n\n");
    let images = extraMessages?.images || [];
    if (images.length && !context.state.mmproj) {
      console.warn(`llama-server has no mmproj loaded; answering without the ${images.length} attached image(s)`);
      images = [];
    }
    return [
      { role: "system", content: [systemContent, ...systemText(early)].join("\n\n") },
      ...nonSystem(early),
      ...nonSystem(late),
      {
        role: "user",
        content: images.length
          ? [{ type: "text", text: userText }, ...images.map((image) => ({ type: "image_url", image_url: { url: toImageDataUrl(image) } }))]
          : userText,
      },
    ];
  }

// Issue #660: llama-server reports per request how many prompt tokens it
  // reused from its prompt cache (cache_n) vs. processed fresh (prompt_n),
  // so the cache hit rate between turns is visible in the log.
  //
  // #642: also kept as the latest prompt's real size for the context meter
  // -- cache_n + prompt_n is the whole prompt. A fresh object every time,
  // so a caller can tell "a completion ran since I last looked" by identity.
  function logPromptCache(label, timings) {
    if (!timings || typeof timings.prompt_n !== "number") return;
    const cacheN = Number(timings.cache_n) || 0;
    console.log(`${label}: prompt cache_n=${cacheN} prompt_n=${timings.prompt_n}`);
    context.state.lastPromptUsage = { promptTokens: cacheN + timings.prompt_n, promptN: timings.prompt_n, cacheN };
  }

function getLastPromptUsage() {
    return context.state.lastPromptUsage;
  }

// #642: exact token count of text with the loaded model's tokenizer.
  // Only asks a server this runtime already started or adopted -- never
  // starts one -- and returns null when there is none or it fails, so the
  // caller can fall back to an estimate.
  async function countTokens(text) {
    if (!context.state.port || typeof context.fetchImpl !== "function") return null;
    try {
      const resp = await context.fetchImpl(`http://127.0.0.1:${context.state.port}/tokenize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: String(text || "") }),
      });
      if (!resp || !resp.ok) return null;
      const json = await resp.json();
      return Array.isArray(json?.tokens) ? json.tokens.length : null;
    } catch (e) {
      return null;
    }
  }

// #642: the running server's real per-slot context (/props n_ctx),
  // else the -c value buildServerArgs would pass. Never starts a server.
  function configuredContext() {
    if (context.state.gamingModel) return Number(context.env.MANA_GAMING_LLAMA_CONTEXT || 8192);
    if (context.state.contextOverride) return context.state.contextOverride;
    return Number(context.env.LLAMA_CONTEXT || context.env.LLAMA_CONTEXT_CAP || "4096");
  }

async function getContextSize() {
    const configured = configuredContext();
    if (!context.state.port || typeof context.fetchImpl !== "function") return configured;
    try {
      const resp = await context.fetchImpl(`http://127.0.0.1:${context.state.port}/props`);
      if (!resp || !resp.ok) return configured;
      const props = await resp.json();
      return Number(props?.default_generation_settings?.n_ctx) || configured;
    } catch (e) {
      return configured;
    }
  }

// #675: a "think harder" request asks for its reply's max_tokens plus a
  // 1024-token thinking budget (512 on a tool round). Keeps prompt +
  // max_tokens inside the slot's context, so a long prompt shortens the
  // thinking first (then the reply) instead of generation running off the
  // end of the window mid-thought.
  // The prompt is measured as the JSON of what's sent (messages + tools),
  // which slightly overcounts -- the safe side.
  async function fitThinkingToContext(params, payload) {
    const budget = params.thinking_budget_tokens;
    if (!budget || !Number.isFinite(params.max_tokens)) return;
    // #679: an attached image's base64 would count as ~100k text tokens.
    // ponytail: images count as 0 here; a per-image estimate if image turns
    // with deep thinking start overflowing the context.
    const text = JSON.stringify(payload, (key, value) => (key === "image_url" ? undefined : value));
    const [contextSize, counted] = await Promise.all([getContextSize(), countTokens(text)]);
    const room = contextSize - (counted ?? Math.ceil(text.length / 3)) - 64;
    const over = params.max_tokens - room;
    if (over <= 0) return;
    params.max_tokens = Math.max(1, room);
    if (over >= budget) {
      delete params.thinking_budget_tokens;
      delete params.reasoning_budget_message;
      params.chat_template_kwargs = { enable_thinking: false };
    } else {
      params.thinking_budget_tokens = budget - over;
    }
  }

async function runLocalAssistantReply(
    prompt,
    maxTokens = 256,
    profile = "default",
    overrideSystemPrompt = null,
    extraMessages = null,
    task = null,
    thinkingOverride = undefined,
  ) {
    if (typeof context.fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = context.nowMs();
    await context.ensureServer(profile, extraMessages?.images, { signal: extraMessages?.signal });
    extraMessages?.signal?.throwIfAborted();

    // #1343: Tri-mode dynamic multi-LoRA routing
    if (context.state.hasLoraAdapters) {
      const targetAdapter = (task === "tools" || extraMessages?.tools?.length) ? "assistant" : "companion";
      await context.applyLoraAdapter(targetAdapter);
    }

    // #675: per-profile/per-task sampler preset and thinking.
    const sampling = context.buildSamplingParams({ profile, task, maxTokens, thinking: thinkingOverride, env: context.env });
    const messages = buildMessages(overrideSystemPrompt || context.systemPromptOf(), prompt, extraMessages);
    if (thinkingOverride === true) await fitThinkingToContext(sampling.params, { messages });
    const resp = await context.fetchImpl(
      `http://127.0.0.1:${context.state.port}/v1/chat/completions`,
      {
        method: "POST",
        signal: extraMessages?.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, ...sampling.params }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `llama-server reply failed (${resp.status}): ${text.slice(0, 500)}`,
      );
    }
    const json = await resp.json();
    logPromptCache("llama-server", json?.timings);
    const rawContent = json?.choices?.[0]?.message?.content;
    if (context.stripThinking(rawContent)?.trim()) extraMessages?.onReplyStarted?.();
    const thought = context.extractThinking(rawContent);
    if (thought && typeof extraMessages?.onThoughtDone === "function") {
      extraMessages.onThoughtDone(thought);
    }
    // Reasoning models may wrap deliberation in <think> blocks; keep only
    // the reply (a reply that was all thinking counts as empty).
    const content = context.stripThinking(rawContent);
    if (!content) {
      // #675: thinking can use up the reply (reasoning, no content) -- one
      // retry with thinking off so the user still gets an answer.
      if (sampling.thinking) {
        console.warn("llama-server: empty reply with thinking on; retrying once with thinking off");
        return runLocalAssistantReply(prompt, maxTokens, profile, overrideSystemPrompt, extraMessages, task, false);
      }
      throw new Error("llama-server returned an empty reply");
    }

    context.scheduleIdleShutdown();
    context.logPerf("llama-server", startedAt);
    return content;
  }

// Issue #331: the streaming counterpart of runLocalAssistantReply. Same
  // prompt construction and the same post-processing, but the reply is
  // consumed as it is generated so each finished sentence can go to TTS
  // while the model is still writing the next one.
  //
  // onSentence is called with each completed sentence, in order. The full
  // reply is still returned, so a caller that only wants the text can use
  // this exactly like the blocking version and ignore the callback.
  //
  // Two filters sit between the wire and the caller, and the order matters:
  // think-block suppression runs FIRST, so reasoning never reaches the
  // sentence chunker and therefore never reaches TTS. Doing it the other
  // way round would speak the model's deliberation aloud before the closing
  // tag arrived.
  async function streamLocalAssistantReply(
    prompt,
    {
      maxTokens = 256,
      profile = "default",
      overrideSystemPrompt = null,
      extraMessages = null,
      onSentence = null,
      onThought = null,
      onThoughtDone = null,
      maxSentenceChars,
      thinking,
    } = {},
  ) {
    if (typeof context.fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = context.nowMs();
    await context.ensureServer(profile, extraMessages?.images, { signal: extraMessages?.signal });
    extraMessages?.signal?.throwIfAborted();

    const messages = buildMessages(overrideSystemPrompt || context.systemPromptOf(), prompt, extraMessages);
    const { params } = context.buildSamplingParams({ profile, task: "stream", maxTokens, thinking, env: context.env });
    if (thinking === true) await fitThinkingToContext(params, { messages });
    const resp = await context.fetchImpl(
      `http://127.0.0.1:${context.state.port}/v1/chat/completions`,
      {
        method: "POST",
        signal: extraMessages?.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, ...params, stream: true }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `llama-server stream failed (${resp.status}): ${text.slice(0, 500)}`,
      );
    }

    // Kept and logged once: only the final frame normally carries timings,
    // but a server run with timings_per_token sends them on every frame.
    let lastTimings = null;
    const full = await context.streamSentences(resp, {
      onReplyStarted: extraMessages?.onReplyStarted,
      onSentence,
      onThought,
      onThoughtDone,
      maxSentenceChars,
      onTimings: (timings) => {
        lastTimings = timings;
      },
    });
    logPromptCache("llama-server-stream", lastTimings);

    if (!full.trim()) {
      throw new Error("llama-server returned an empty reply");
    }

    context.scheduleIdleShutdown();
    context.logPerf("llama-server-stream", startedAt);
    return full;
  }

// Raw OpenAI-compatible passthrough (issue #95). Unlike runLocalAssistantReply,
  // this does not inject Mana's persona system prompt or post-process the
  // reply -- external clients (Obsidian Copilot, etc.) bring their own
  // messages/system prompt and expect a standard OpenAI response shape,
  // streaming or not. Returns the raw fetch Response so the HTTP layer can
  // relay status/JSON/SSE as-is without this runtime needing to understand
  // Express or SSE framing.
  async function proxyChatCompletion(body, profile = "default") {
    if (typeof context.fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    await context.ensureServer(profile);
    context.scheduleIdleShutdown();
    return context.fetchImpl(`http://127.0.0.1:${context.state.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

// Best-of-N self-voting (issue #70): generate N candidates at varied
  // temperature, then a temp-0 judge call picks the best one. Sequential,
  // not parallel -- this llama-server instance runs with the default single
  // parallel slot (no --parallel flag), so concurrent requests would just
  // queue behind each other on this hardware anyway, not actually overlap.
  // See docs/roadmap/issue-70-best-of-n.md for the measured latency cost.
  async function runBestOfNReply(
    prompt,
    {
      n = 3,
      maxTokens = 512,
      profile = "coding",
      overrideSystemPrompt = null,
      signal = null,
      onReplyStarted = null,
    } = {},
  ) {
    if (typeof context.fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = context.nowMs();
    await context.ensureServer(profile, null, { signal });

    async function completeChat(messages, temperature, tokenLimit) {
      signal?.throwIfAborted();
      const resp = await context.fetchImpl(
        `http://127.0.0.1:${context.state.port}/v1/chat/completions`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages,
            // #675: the profile's preset, with the ladder/judge temperature on top.
            ...context.buildSamplingParams({ profile, task: "bestofn", maxTokens: tokenLimit, env: context.env }).params,
            temperature,
          }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `llama-server reply failed (${resp.status}): ${text.slice(0, 500)}`,
        );
      }
      const json = await resp.json();
      if (context.stripThinking(json?.choices?.[0]?.message?.content)?.trim()) onReplyStarted?.();
      const content =
        json && json.choices && json.choices[0] && json.choices[0].message
          ? String(json.choices[0].message.content || "")
          : "";
      return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }

    const baseMessages = [
      { role: "system", content: overrideSystemPrompt || context.systemPromptOf() },
      { role: "user", content: prompt },
    ];
    // Fixed ladder from a safe low-temperature baseline up to more varied
    // alternatives, rather than N identical low-temp calls that would just
    // reproduce the same candidate.
    const temperatures = Array.from({ length: n }, (_, i) =>
      n === 1
        ? 0.2
        : Math.round((0.2 + (0.8 * i) / (n - 1)) * 100) / 100,
    );

    const candidates = [];
    for (const temperature of temperatures) {
      const content = await completeChat(baseMessages, temperature, maxTokens);
      if (content) candidates.push(content);
    }
    if (!candidates.length) {
      throw new Error("llama-server returned no usable candidates");
    }

    let judgeIndex = 0;
    if (candidates.length > 1) {
      const judgeMessages = [
        {
          role: "system",
          content:
            "You are a terse code reviewer. Reply with only the number of the best candidate, nothing else.",
        },
        {
          role: "user",
          content:
            `You are judging ${candidates.length} candidate answers to the same coding question. ` +
            "Pick the single best one for correctness, edge-case handling, and efficiency.\n\n" +
            candidates
              .map((c, i) => `Candidate ${i + 1}:\n${c}`)
              .join("\n\n") +
            "\n\nBest candidate number:",
        },
      ];
      const judgeReply = await completeChat(judgeMessages, 0, 16);
      const parsed = parseInt((judgeReply.match(/\d+/) || [])[0], 10);
      // Falls back to candidate 1 (the lowest-temperature, safest one) if
      // the judge doesn't return a clean, in-range number.
      judgeIndex =
        Number.isInteger(parsed) && parsed >= 1 && parsed <= candidates.length
          ? parsed - 1
          : 0;
    }

    context.scheduleIdleShutdown();
    context.logPerf("llama-server-best-of-n", startedAt);
    return { content: candidates[judgeIndex], candidates, judgeIndex };
  }

// Vision replies must go through llama-server (llama-cli has no equivalent
  // one-shot multimodal path here), so there is no CLI fallback: errors
  // propagate to the caller with a configuration hint.
  async function runVisionReply(
    prompt,
    images,
    maxTokens = 256,
    overrideSystemPrompt = null,
  ) {
    if (typeof context.fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    if (!context.isEnabled()) {
      throw new Error(
        "llama-server runtime is disabled; local vision replies are unavailable",
      );
    }
    const imageList = [].concat(images || []).filter(Boolean);
    if (!imageList.length) {
      throw new Error("runVisionReply requires at least one image");
    }

    const startedAt = context.nowMs();
    const model = context.findVisionModel();
    // #889: while gaming, a separate vision model can still describe the
    // image (the VRAM guard has the last word), but the normal chat model
    // plus its mmproj is exactly the load the gaming model is there to avoid.
    if (context.state.gamingModel && context.sameModelPath(model, context.findNormalLlamaModel())) {
      const error = new Error("Vision is paused while gaming");
      error.code = "VISION_PAUSED_GAMING";
      throw error;
    }
    const mmproj = context.findVisionMmproj(model);
    // #872: when the vision model is the chat model, chat turns now keep
    // the mmproj this loads (vision__look mid tool loop: one reload, not two).
    context.noteImageTurn();
    await context.ensureServerConfig(model, mmproj);

    const content = [
      {
        type: "text",
        text: String(prompt || "Describe what you see in this image."),
      },
    ];
    for (const image of imageList) {
      const url = String(image).startsWith("data:")
        ? String(image)
        : `data:image/png;base64,${image}`;
      content.push({ type: "image_url", image_url: { url } });
    }

    const resp = await context.fetchImpl(
      `http://127.0.0.1:${context.state.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: overrideSystemPrompt || context.systemPromptOf() },
            { role: "user", content },
          ],
          ...context.buildSamplingParams({ task: "vision", maxTokens, env: context.env }).params,
        }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `llama-server vision reply failed (${resp.status}): ${text.slice(0, 500)}`,
      );
    }
    const json = await resp.json();
    const replyContent =
      json && json.choices && json.choices[0] && json.choices[0].message
        ? String(json.choices[0].message.content || "")
        : "";
    if (!replyContent.trim()) {
      throw new Error("llama-server returned an empty vision reply");
    }

    context.scheduleIdleShutdown();
    context.logPerf("llama-vision", startedAt);
    return replyContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

// Issue #431: a small utility-classification call (same shape as
  // guardian-precheck.js's judgeActionRisk) that never triggers a load or a
  // swap -- returns null instead of running when no already-loaded profile
  // is safely reusable, rather than guessing and risking a swap. Callers
  // that don't care which profile actually served the call (a yes/no
  // classification, not a user-facing reply) can use this instead of
  // picking a profile themselves.
  async function runLocalReplyIfSafelyLoaded(prompt, maxTokens) {
    const safeProfile = context.getKnownLlamaModelProfiles().find((profile) =>
      context.isProfileAlreadyLoaded(profile),
    );
    if (!safeProfile) {
      return null;
    }
    return runLocalAssistantReply(prompt, maxTokens, safeProfile, null, null, "utility");
  }

  return { toImageDataUrl, buildMessages, logPromptCache, getLastPromptUsage, countTokens, configuredContext, getContextSize, fitThinkingToContext, runLocalAssistantReply, streamLocalAssistantReply, proxyChatCompletion, runBestOfNReply, runVisionReply, runLocalReplyIfSafelyLoaded };
}

module.exports = { createCompletions };
