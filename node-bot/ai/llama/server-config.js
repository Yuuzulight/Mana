function createServerConfig(context) {
// A GGUF file's size on disk is a rough proxy for its VRAM footprint at
  // full offload (-ngl 99, this runtime's default) -- weights dominate the
  // footprint, though KV cache/context buffers aren't captured by file size
  // alone (see the 20% margin below). Only meaningful for a local file path;
  // a bare -hf hub spec has no size to check without downloading it first,
  // so this returns null rather than guessing -- same graceful-fallback
  // policy detectGpuVramMb already follows elsewhere in this codebase.
  function estimateModelFootprintMb(modelSpec) {
    if (!context.isLocalModelSpec(modelSpec, context.fs)) {
      return null;
    }
    try {
      const stats = context.fs.statSync(modelSpec);
      return Math.round(stats.size / (1024 * 1024));
    } catch (e) {
      return null;
    }
  }

// Sums a model file with its optional mmproj (vision loads carry a
  // separate projector file, also fully GPU-offloaded alongside the main
  // model) -- null only when the *model* itself can't be sized, since that's
  // the dominant term; an unsizeable mmproj just contributes 0 rather than
  // discarding a real model-size estimate over a secondary file.
  function estimateLoadFootprintMb(modelSpec, mmprojSpec) {
    const modelMb = estimateModelFootprintMb(modelSpec);
    if (modelMb === null) return null;
    const mmprojMb = mmprojSpec ? estimateModelFootprintMb(mmprojSpec) || 0 : 0;
    return modelMb + mmprojMb;
  }

// Checked BEFORE the outgoing model (if any) is stopped, not after --
  // stopping first and only then discovering the replacement doesn't fit
  // would leave nothing loaded at all, which is worse than refusing the
  // swap up front. Since the outgoing model's VRAM isn't freed yet at this
  // point, its own estimated footprint is added back to current free VRAM
  // to approximate what stopping it is about to release.
  function assertVramForSwap(model, mmproj) {
    if (!context.vramGuardEnabled) return;
    const targetFootprintMb = estimateLoadFootprintMb(model, mmproj);
    if (targetFootprintMb === null) return;
    const usage = context.detectGpuVramUsage();
    if (!usage || !Number.isFinite(usage.freeMb)) return;

    const outgoingFootprintMb =
      (context.state.model && estimateLoadFootprintMb(context.state.model, context.state.mmproj)) || 0;
    const projectedFreeMb = usage.freeMb + outgoingFootprintMb;
    const requiredMb = Math.round(targetFootprintMb * 1.2);

    if (projectedFreeMb < requiredMb) {
      throw new Error(
        `llama-server: refusing to load ${model} -- estimated ${targetFootprintMb}MB model` +
          `${mmproj ? " (incl. mmproj)" : ""} needs ~${requiredMb}MB free VRAM, only ` +
          `~${projectedFreeMb}MB projected free (${usage.freeMb}MB free now + ` +
          `~${outgoingFootprintMb}MB from the outgoing model, if any). ` +
          `Set LLAMA_SERVER_VRAM_GUARD=0 to override.`,
      );
    }
  }

// GGML_CUDA_ENABLE_UNIFIED_MEMORY is a ggml-cuda runtime env var (not a
  // llama-server CLI flag): it switches the CUDA backend to cudaMallocManaged
  // allocations, letting inactive weights page to system RAM under memory
  // pressure instead of the driver hard-failing the allocation. Measured
  // real cold-start/swap latency on an RTX 3070 Ti (see
  // docs/roadmap/issue-68-vram-hotswap-tuning.md): ~64% faster cold start
  // (11.4s -> 4.1s) and ~32% faster on the larger 4B->7B swap direction.
  // Off by default now: on the RTX 5080 machine, every llama-server
  // stop with it on left ~5 GB of system RAM committed to no process (model
  // sized, gone only after a reboot; 4 of 4 runs). With it off nothing was
  // left behind (3 of 3), including a forced kill after a 60 s CTRL_C wait,
  // so it's the unified memory, not the kill. MANA_LLAMA_UNIFIED_MEMORY=1
  // opts back in.
  function buildServerEnv() {
    if (context.env.MANA_LLAMA_UNIFIED_MEMORY === "1") {
      return { ...context.env, GGML_CUDA_ENABLE_UNIFIED_MEMORY: "1" };
    }
    return context.env;
  }

function buildServerArgs(model, port, mmproj = null, profile = null, bin = null) {
    const args = [
      context.isLocalModelSpec(model, context.fs) ? "-m" : "-hf",
      model,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-t",
      String(context.threads),
      "--no-webui",
    ];
    if (mmproj) {
      args.push("--mmproj", mmproj);
    }

    // Reasoning models (e.g. Qwen3) otherwise spend the whole token budget
    // "thinking" and return an empty content field — a spoken companion
    // needs direct replies. MANA_LLAMA_REASONING=on|auto re-enables it.
    const reasoning = ["on", "off", "auto"].includes(
      String(context.env.MANA_LLAMA_REASONING || "").toLowerCase(),
    )
      ? String(context.env.MANA_LLAMA_REASONING).toLowerCase()
      : "off";
    args.push("--reasoning", reasoning);

    // Issue #360: every profile switch kills and respawns this whole
    // process (see startServer below), so a return to a previously-active
    // model relies entirely on the OS page cache (mmap is llama.cpp's
    // default) to avoid a genuine cold disk read -- fine most of the time,
    // but those cached pages can be evicted under memory pressure from
    // anything else running, showing up as an occasional slow p95 switch.
    // --mlock pins the model in physical RAM so a switch back is always
    // fast, at the real cost of denying that RAM back to the OS even when
    // something else (a game) needs it -- opt-in only, never a default.
    //
    // Otherwise the model loads straight into VRAM by default: with full
    // GPU offload, mmap still maps the whole GGUF into this process --
    // measured on an RTX 5080 / 32 GB box (9B Q4_K_M, -ngl 99, -c 16384)
    // that drove llama-server to ~5 GB working set and system RAM 79% ->
    // 95%+; without mmap it loaded in 6.7s at ~1.1 GB (+3.7 points RAM).
    // `--load-mode none` is b10507's replacement for the deprecated
    // --no-mmap. A switch back then re-reads the file instead of relying on
    // the page cache above, and with a low LLAMA_NGL the CPU layers become
    // private memory, so Settings > Model or MANA_LLAMA_MMAP=1 turns mmap
    // back on (see model-settings-store.js).
    const loadIntoVram = context.modelSettingsStore
      ? context.modelSettingsStore.isLoadIntoVram(context.env)
      : context.env.MANA_LLAMA_MMAP !== "1";
    if (context.env.LLAMA_MLOCK === "1") {
      args.push("--mlock");
    } else if (loadIntoVram) {
      if (context.supportsLoadMode(bin)) {
        args.push("--load-mode", "none");
      } else {
        args.push("--no-mmap");
      }
    }

    // Issue #660: llama-server keeps a host-RAM prompt cache (b10507
    // default 8 GiB). Uncapped, its working set grew 0.9 -> 4.6 GB over one
    // session. The in-slot KV cache (VRAM) already gives turn-to-turn prefix
    // reuse; the host cache only helps when requests hop slots or sessions,
    // so 1 GiB keeps most of that. LLAMA_CACHE_RAM overrides it (MiB; -1 =
    // no limit, 0 = off).
    // #889: the gaming model gets MANA_GAMING_CACHE_RAM (256): a live FFXIV
    // run showed system RAM, not VRAM, runs out first while gaming.
    if (context.supportsFlag(bin, "--cache-ram")) {
      const [setting, fallback] = context.state.gamingModel ? [context.env.MANA_GAMING_CACHE_RAM, 256] : [context.env.LLAMA_CACHE_RAM, 1024];
      const cacheRam = Number(String(setting || "").trim() || fallback);
      args.push("--cache-ram", String(Number.isInteger(cacheRam) && cacheRam >= -1 ? cacheRam : fallback));
    }

    // Same opt-in hardware flags as the llama-cli path.
    if (context.env.LLAMA_ENABLE_FLASHATTN === "1") {
      args.push("--flash-attn", context.env.LLAMA_ARG_FLASH_ATTN || "auto");
    }
    // #889: the gaming model's KV cache type. A quantized V cache needs
    // flash attention, which llama-server's default (auto) turns on for it.
    const kvCache = context.state.gamingModel ? context.env.MANA_GAMING_KV_CACHE || "q8_0" : context.env.LLAMA_KV_COMPRESS;
    if (kvCache) {
      args.push("-ctk", kvCache);
      args.push("-ctv", kvCache);
    }
    if (context.env.LLAMA_ENABLE_NO_KV_OFFLOAD === "1") {
      args.push("--no-kv-offload");
    }

    // Issue #332: speculative decoding, both opt-in and independent of each
    // other -- --spec-type takes a comma-separated list, so both can be
    // active together if a caller sets both env vars.
    //
    // N-gram/lookup: drafts candidate tokens by pattern-matching against the
    // ongoing generation itself -- no second model, no extra VRAM. Defaults
    // to ngram-simple, llama.cpp's simplest/most-tested lookup variant, when
    // the gate is on but no specific variant is named. Deliberately doesn't
    // wire ngram-cache's -lcs/-lcd persisted-cache-file flags -- that's a
    // different feature (a cache surviving across process restarts) than
    // "match against this generation," and the other ngram-* variants
    // already provide the latter without needing an external cache file.
    //
    // Draft-model: loads a genuinely separate, smaller model alongside the
    // target and drafts tokens by actually running it. LLAMA_SPEC_DRAFT_MODEL
    // is the draft model's own path, same convention as LLAMA_MODEL/
    // LLAMA_VISION_MODEL. Only draft-simple is wired -- draft-eagle3/
    // draft-mtp need the target model itself trained for that, which is
    // unconfirmed for Mana's current models (see the issue's own scope
    // note).
    //
    // -ngld (--spec-draft-ngl) is explicitly set to match the target's own
    // -ngl here, rather than left at its own 'auto' default -- measured
    // directly (issue #332): with a real coder-7B target + a same-family
    // 1.5B draft, -ngld auto left the draft model mostly off-GPU and
    // generation ran at 14.6 tok/s (vs. a 97.4 tok/s no-draft baseline on
    // identical hardware); forcing -ngld to match -ngl recovered most of
    // that to 78.7 tok/s. Still slower than no draft at all on this
    // single-GPU setup even at a 93% token-acceptance rate -- draft-model
    // speculative decoding stays opt-in rather than a recommended default,
    // but a caller who does enable it shouldn't hit a measured, avoidable
    // 5x regression from an unrelated default.
    const ngl = context.env.LLAMA_NGL || "99";
    const specTypes = [];
    const profileDefaults = context.PROFILE_TUNING[profile] || {};
    const specNgramEnabled =
      context.env.LLAMA_ENABLE_SPEC_NGRAM === "1"
        ? true
        : context.env.LLAMA_ENABLE_SPEC_NGRAM === "0"
          ? false
          : Boolean(profileDefaults.enableSpecNgram);
    if (specNgramEnabled) {
      specTypes.push(context.env.LLAMA_SPEC_NGRAM_TYPE || "ngram-simple");
    }
    if (context.env.LLAMA_SPEC_DRAFT_MODEL) {
      specTypes.push("draft-simple");
      args.push("--spec-draft-model", context.env.LLAMA_SPEC_DRAFT_MODEL);
      args.push("--spec-draft-ngl", String(ngl));
    }
    if (specTypes.length) {
      args.push("--spec-type", specTypes.join(","));
    }

    if (ngl) {
      args.push("-ngl", String(ngl));
    }
    const contextCap = context.configuredContext();

    // Issue #462: opt-in real concurrency, now that the 16GB card leaves
    // room for it (was rejected on the prior 8GB card -- see
    // docs/roadmap/issue-70-best-of-n.md). llama.cpp divides a single -c
    // budget evenly across slots, so a bare --parallel N would silently
    // shrink every request's context to 1/N of today's value; multiplying
    // -c by N here keeps each slot's effective context unchanged from the
    // single-slot default, matching this file's existing convention of a
    // flag never changing behavior unless explicitly opted into.
    const parallel = Number(context.env.LLAMA_PARALLEL || "1");
    if (parallel > 1) {
      args.push("--parallel", String(parallel));
      args.push("-c", String(contextCap * parallel));
    } else if (contextCap) {
      args.push("-c", String(contextCap));
    }

    // #1343: Tri-mode dynamic multi-LoRA adapters
    // When resident brain runs with Qwen 9B base, dynamically load companion and assistant LoRAs
    const loras = context.findLoraAdapters();
    if (loras && context.supportsFlag(bin, "--lora-init-without-apply")) {
      const loraSpecs = [];
      if (loras.companionPath) loraSpecs.push(`${loras.companionPath}:0.0`);
      if (loras.assistantPath) loraSpecs.push(`${loras.assistantPath}:0.0`);
      if (loraSpecs.length > 0) {
        args.push("--lora-init-without-apply");
        args.push("--lora-scaled", loraSpecs.join(","));
      }
    }

    return args;
  }

// KV cache MB for ctx tokens. ponytail: a per-token constant (an 8B GQA
  // model at f16, halved for a q4/q8 LLAMA_KV_COMPRESS), tunable with
  // LLAMA_KV_MB_PER_1K_TOKENS; the upgrade is reading it from the GGUF
  // (layers x KV heads x head size).
  function kvCacheMb(ctx) {
    const per1k = Number(context.env.LLAMA_KV_MB_PER_1K_TOKENS) || (/^q[4-8]/i.test(context.env.LLAMA_KV_COMPRESS || "") ? 64 : 128);
    return (ctx / 1024) * per1k;
  }

// Restarting at ctx frees the running server's own KV cache and needs
  // the larger one, with assertVramForSwap's 20% margin.
  function contextFits(ctx) {
    if (!context.vramGuardEnabled) return true;
    const usage = context.detectGpuVramUsage();
    if (!usage || !Number.isFinite(usage.freeMb)) return true;
    const held = context.state.port ? kvCacheMb(context.state.ctx || context.configuredContext()) : 0;
    return usage.freeMb >= (kvCacheMb(ctx) - held) * 1.2;
  }

  return { estimateModelFootprintMb, estimateLoadFootprintMb, assertVramForSwap, buildServerEnv, buildServerArgs, kvCacheMb, contextFits };
}

module.exports = { createServerConfig };
