function createModelDiscovery(context) {
function supportsFlag(bin, flag) {
    if (!bin) return true;
    if (!context.helpTexts.has(bin)) {
      let text = "";
      try {
        text = String(context.probeHelp(bin));
      } catch (e) {
        text = "";
      }
      context.helpTexts.set(bin, text);
    }
    return context.helpTexts.get(bin).includes(flag);
  }

// Without --load-mode, --no-mmap does the same; it's still accepted
  // (deprecated) by builds that do have --load-mode.
  function supportsLoadMode(bin) {
    return supportsFlag(bin, "--load-mode");
  }

function findLlamaServerBin() {
    const candidates = [];
    // #693: a build switched in by an update (tools/llama/active.json)
    // comes first; with no pointer, or an unreadable one, the order below
    // is exactly what it was before. path.win32 for the same reason as
    // LLAMA_BIN below: the pointer always names a Windows folder.
    const pointer = context.readActivePointer(context.toolsDir, context.fs);
    if (pointer) {
      candidates.push(context.path.win32.join(pointer.active, "llama-server.exe"));
    }
    if (context.env.LLAMA_SERVER_BIN) {
      candidates.push(context.env.LLAMA_SERVER_BIN);
    }
    if (context.env.LLAMA_BIN) {
      // LLAMA_BIN always names a Windows .exe (this module only supports
      // the bundled Windows/CUDA llama-server build) -- use path.win32
      // explicitly so this resolves the same way regardless of which OS
      // Node itself is running on (native path.dirname/join would silently
      // misparse a "C:\..." string as a relative path on a POSIX host).
      candidates.push(
        context.path.win32.join(context.path.win32.dirname(context.env.LLAMA_BIN), "llama-server.exe"),
      );
    }

    const bundledLlamaDir = context.path.join(
      context.toolsDir,
      "llama-b9436-bin-win-cuda-12.4-x64",
    );
    candidates.push(
      context.path.join(bundledLlamaDir, "llama-server.exe"),
      context.path.join(context.toolsDir, "llama-server.exe"),
    );

    const validPath = candidates.find(
      (candidate) => candidate && context.fs.existsSync(candidate),
    );
    if (validPath) {
      return validPath;
    }

    const checked = candidates.filter(Boolean).join(", ");
    throw new Error(
      `llama-server executable not found. Checked: ${checked}. Set LLAMA_SERVER_BIN to a valid llama-server.exe path.`,
    );
  }

function isEnabled() {
    if (context.env.MANA_LLAMA_SERVER === "0") {
      return false;
    }
    // Never spawn a persistent server from test runs: a killed test process
    // cannot clean up its children, which leaves orphaned llama-server.exe
    // processes behind. NODE_TEST_CONTEXT is set by the node:test runner.
    if (context.env.NODE_ENV === "test" || context.env.NODE_TEST_CONTEXT) {
      return false;
    }
    try {
      findLlamaServerBin();
      return true;
    } catch (e) {
      return false;
    }
  }

// #889: while the gaming model is in use, every profile resolves to it.
  function findLlamaModel(profile = "default") {
    return context.state.gamingModel ? context.env.MANA_GAMING_LLAMA_MODEL : findNormalLlamaModel(profile);
  }

function findNormalLlamaModel(profile = "default") {
    const storedPath = context.modelSettingsStore ? context.modelSettingsStore.getModelPath() : null;
    return context.findPreferredLlamaModel({
      explicitModel: storedPath || context.env.LLAMA_MODEL || "",
      searchDir: context.toolsDir,
      profile,
    });
  }

// Issue #1343: Tri-mode dynamic multi-LoRA adapters
  function findLoraAdapters() {
    const explicitCompanion = context.env.MANA_COMPANION_LORA;
    const explicitAssistant = context.env.MANA_ASSISTANT_LORA;
    const loraDir = context.path.join(context.toolsDir, "llama", "gguf-models", "loras");
    const companionPath = explicitCompanion || context.path.join(loraDir, "mana-companion.gguf");
    const assistantPath = explicitAssistant || context.path.join(loraDir, "mana-assistant.gguf");
    const hasCompanion = Boolean(companionPath && context.fs.existsSync(companionPath));
    const hasAssistant = Boolean(assistantPath && context.fs.existsSync(assistantPath));
    if (!hasCompanion && !hasAssistant) return null;
    return {
      companionPath: hasCompanion ? companionPath : null,
      assistantPath: hasAssistant ? assistantPath : null,
    };
  }

async function refreshLoraAdapters() {
    if (!context.state.port) return;
    try {
      const res = await context.fetchImpl(`http://127.0.0.1:${context.state.port}/lora-adapters`);
      if (res && res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) {
          context.state.hasLoraAdapters = true;
          context.state.loraIds = {};
          for (const item of list) {
            const p = String(item.path || "").toLowerCase();
            if (p.includes("companion")) {
              context.state.loraIds.companion = item.id;
            } else if (p.includes("assistant")) {
              context.state.loraIds.assistant = item.id;
            }
          }
          await applyLoraAdapter("companion");
        }
      }
    } catch (e) {
      // Dynamic LoRA lookup best-effort
    }
  }

async function applyLoraAdapter(name = "companion") {
    if (!context.state.port || !context.state.hasLoraAdapters) return false;
    if (context.state.activeLoraAdapter === name) return true;
    try {
      const companionScale = name === "companion" ? 1.0 : 0.0;
      const assistantScale = name === "assistant" ? 1.0 : 0.0;
      const payload = [];
      if (context.state.loraIds?.companion !== undefined) {
        payload.push({ id: context.state.loraIds.companion, scale: companionScale });
      }
      if (context.state.loraIds?.assistant !== undefined) {
        payload.push({ id: context.state.loraIds.assistant, scale: assistantScale });
      }
      if (payload.length === 0) return false;
      const res = await context.fetchImpl(`http://127.0.0.1:${context.state.port}/lora-adapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res && res.ok) {
        context.state.activeLoraAdapter = name;
        return true;
      }
    } catch (e) {
      // Dynamic LoRA scale application best-effort
    }
    return false;
  }

function isMmprojFile(filePath) {
    return context.path.basename(filePath).toLowerCase().includes("mmproj");
  }

// Vision models are resolved separately from the chat profiles: falling
  // back to a text model would make llama-server reject every image request.
  function findVisionModel() {
    const storedPath = context.modelSettingsStore
      ? context.modelSettingsStore.getVisionSettings().modelPath
      : "";
    const explicitVisionModel = storedPath || context.env.LLAMA_VISION_MODEL;
    if (explicitVisionModel) {
      if (context.fs.existsSync(explicitVisionModel)) {
        return explicitVisionModel;
      }
      throw new Error(
        `Vision model is set but does not exist: ${explicitVisionModel}`,
      );
    }

    const ggufs = context.collectFilesRecursively(context.toolsDir, (fullPath) =>
      fullPath.toLowerCase().endsWith(".gguf"),
    );
    const candidates = ggufs.filter((fullPath) => {
      if (isMmprojFile(fullPath)) return false;
      return /(^|[-_.])(vl|vision|llava|minicpm-v|moondream|gemma-3|gemma-4)/i.test(
        context.path.basename(fullPath),
      );
    });
    if (!candidates.length) {
      throw new Error(
        "No local vision model found. Place a vision GGUF (e.g. Qwen2.5-VL) and its mmproj file under tools/llama/gguf-models, or set LLAMA_VISION_MODEL. See docs/vision_setup.md.",
      );
    }

    // Prefer smaller, well-supported models first.
    const preferenceOrder = [
      "qwen2.5-vl-3b",
      "gemma-4",
      "qwen2.5-vl",
      "minicpm-v",
      "gemma-3",
      "llava",
    ];
    const rank = (fullPath) => {
      const name = context.path.basename(fullPath).toLowerCase();
      const index = preferenceOrder.findIndex((token) => name.includes(token));
      return index === -1 ? preferenceOrder.length : index;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates[0];
  }

function findVisionMmproj(modelPath) {
    const storedPath = context.modelSettingsStore
      ? context.modelSettingsStore.getVisionSettings().mmprojPath
      : "";
    const explicitMmproj = storedPath || context.env.LLAMA_VISION_MMPROJ;
    if (explicitMmproj) {
      if (context.fs.existsSync(explicitMmproj)) {
        return explicitMmproj;
      }
      throw new Error(
        `Vision mmproj is set but does not exist: ${explicitMmproj}`,
      );
    }

    const modelDir = context.path.dirname(modelPath);
    const mmprojFiles = context.collectFilesRecursively(modelDir, (fullPath) =>
      fullPath.toLowerCase().endsWith(".gguf"),
    ).filter(isMmprojFile);
    if (!mmprojFiles.length) {
      throw new Error(
        `No mmproj file found next to ${modelPath}. Download the matching mmproj GGUF for the vision model, or set LLAMA_VISION_MMPROJ. See docs/vision_setup.md.`,
      );
    }

    // #872: Q8_0 first -- it read test images as well as F16 for ~280 MiB
    // less VRAM. Then prefer one that shares the model's family token
    // (e.g. "qwen2.5-vl").
    mmprojFiles.sort((a, b) => /-q8_0\.gguf$/i.test(b) - /-q8_0\.gguf$/i.test(a));
    const modelName = context.path.basename(modelPath).toLowerCase();
    const familyToken = (modelName.match(/^[a-z0-9.]+(-vl)?/i) || [""])[0];
    const match = mmprojFiles.find(
      (fullPath) =>
        familyToken &&
        context.path.basename(fullPath).toLowerCase().includes(familyToken),
    );
    return match || mmprojFiles[0];
  }

// #679: the vision mmproj when the vision model is this same file (a
  // natively multimodal chat model, the setup .env.sample documents), else
  // null. #872: the chat server only loads it once an image turn wants it
  // (state.visionWanted) and drops it again after MANA_VISION_IDLE_MS.
  function chatMmprojFor(model) {
    // #889: never with the gaming model (a small model may not see images);
    // image turns go describe-first instead.
    if (context.state.gamingModel) return null;
    try {
      const visionModel = findVisionModel();
      // path.relative is case-insensitive on Windows.
      return context.path.relative(visionModel, model) === "" ? findVisionMmproj(visionModel) : null;
    } catch {
      return null;
    }
  }

function chatAcceptsImages(profile) {
    try {
      return Boolean(chatMmprojFor(findLlamaModel(profile)));
    } catch {
      return false;
    }
  }

function getVisionStatus() {
    try {
      const model = findVisionModel();
      const mmproj = findVisionMmproj(model);
      return { available: true, model, mmproj };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }

// #666: the profile's fallbackProfile, or null when it has none or it
  // resolves to the same model file (retrying that model wouldn't help).
  function backupProfileFor(profile) {
    const fallback = context.LLAMA_MODEL_PROFILES[profile]?.fallbackProfile;
    const fallbackModel = fallback ? findLlamaModel(fallback) : null;
    return fallbackModel && fallbackModel !== findLlamaModel(profile) ? fallback : null;
  }

  return { supportsFlag, supportsLoadMode, findLlamaServerBin, isEnabled, findLlamaModel, findNormalLlamaModel, findLoraAdapters, refreshLoraAdapters, applyLoraAdapter, isMmprojFile, findVisionModel, findVisionMmproj, chatMmprojFor, chatAcceptsImages, getVisionStatus, backupProfileFor };
}

module.exports = { createModelDiscovery };
