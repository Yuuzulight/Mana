// Shared Live2D avatar driver, ported from windows-launcher/avatar/live2d-avatar.js
// for the desktop-client chat window. See desktop-client/AVATAR_NOTICE.md: the
// currently-loaded model is a temporary testing placeholder, not the final
// avatar, and its character design rights remain with the original IP holder.
// Expects the page to have loaded (in order):
//   assets/live2d/live2dcubismcore.min.js
//   node_modules/pixi.js/dist/browser/pixi.min.js
//   node_modules/pixi-live2d-display/dist/cubism4.min.js
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const {
  augmentModelSettings,
  computeZoomFraming,
  expressionForState,
  findModelJson,
  fitModelToView,
  mergeStateMappings,
  motionGroupForState,
  nextRandomDelay,
  nextZoomLevel,
  normalizeAvatarConfig,
  parseParamIdList,
  parseStateMappingOverrides,
  rmsToMouth,
  smoothMouthValue,
} = require("./live2d-logic");

const MODEL_DIR = path.join(__dirname, "model");
// Dev convenience only: if desktop-client has no model of its own (avoids
// duplicating the large, personal, gitignored Live2D model in two places
// during local testing), fall back to windows-launcher's copy when present.
// A packaged installer build only bundles desktop-client itself, so this
// path won't exist there — that's fine, it just means no fallback is found
// and the avatar gracefully degrades to the sprite UI, same as any other
// missing-model case.
const FALLBACK_MODEL_DIR = path.join(
  __dirname,
  "..",
  "..",
  "windows-launcher",
  "avatar",
  "model",
);

function live2dRuntimeAvailable() {
  return (
    typeof window.Live2DCubismCore !== "undefined" &&
    typeof window.PIXI !== "undefined" &&
    window.PIXI.live2d &&
    typeof window.PIXI.live2d.Live2DModel !== "undefined"
  );
}

function findConfiguredModelJson(env = process.env) {
  const explicit = env.MANA_LIVE2D_MODEL || "";
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  return findModelJson(MODEL_DIR, fs) || findModelJson(FALLBACK_MODEL_DIR, fs);
}

function loadAvatarConfig(modelJson) {
  const candidates = [
    path.join(path.dirname(modelJson), "mana-avatar.json"),
    path.join(MODEL_DIR, "mana-avatar.json"),
    path.join(FALLBACK_MODEL_DIR, "mana-avatar.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const config = normalizeAvatarConfig(
          JSON.parse(fs.readFileSync(candidate, "utf8")),
        );
        console.log(`Loaded avatar config: ${candidate}`);
        return config;
      }
    } catch (error) {
      console.warn(`Ignoring invalid avatar config ${candidate}:`, error);
    }
  }
  return normalizeAvatarConfig(null);
}

// Creates a Live2D avatar bound to `canvas`. Returns null when the runtime
// or model is unavailable (callers fall back to sprites), otherwise:
//   { setState(state), setMouthTarget(rms), setZoom(level), cycleZoom(),
//     getZoom(), stop() }
// Zoom levels are "full" | "waist" | "bust" (see live2d-logic's ZOOM_LEVELS).
async function createLive2dAvatar({ canvas, width, height, env = process.env }) {
  if (!live2dRuntimeAvailable()) {
    console.log("Live2D runtime not available; using sprite avatar");
    return null;
  }

  const modelJson = findConfiguredModelJson(env);
  if (!modelJson) {
    console.log(
      `No Live2D model found (looked in ${MODEL_DIR}, ${FALLBACK_MODEL_DIR}, and MANA_LIVE2D_MODEL); using sprite avatar`,
    );
    return null;
  }

  // Loaded first (needs only the model path) so every tuning knob below can
  // fall back to it: env var (quick experiments) > mana-avatar.json (travels
  // with the model, so a swap carries its own tuning) > hardcoded default.
  const config = loadAvatarConfig(modelJson);

  const mouthParam = env.MANA_LIVE2D_MOUTH_PARAM || config.mouthParam;
  // Lip-sync sensitivity. rmsToMouth's baseline gain is 9, which kept the
  // mouth around a quarter open during ordinary speech — too subtle; the
  // default of 18 doubles the openness for the same voice level, giving a
  // much more exaggerated, expressive mouth (values clamp at the
  // parameter's max, so loud passages simply hold fully open).
  const mouthGain =
    env.MANA_LIVE2D_MOUTH_GAIN !== undefined
      ? Number(env.MANA_LIVE2D_MOUTH_GAIN)
      : config.mouthGain;
  // How wide "eyes open" holds while she's not idle, as a multiplier on the
  // blink manager's 0..1 output. Most models run ParamEyeL/ROpen 0..1
  // (1 = fully open) or 0..2 (1 = resting, 2 = maximally wide) — the
  // default of 1.5 lands at ~75% of a 0..2 range, clearly awake and
  // expressive without a startled full-max stare; values clamp to
  // whatever the model's own parameter range actually is.
  const eyeOpenScale =
    env.MANA_LIVE2D_EYE_OPEN_SCALE !== undefined
      ? Number(env.MANA_LIVE2D_EYE_OPEN_SCALE)
      : config.eyeOpenScale;
  const fps = Number(env.MANA_AVATAR_FPS || 30);
  const viewWidth = width || canvas.clientWidth || 234;
  const viewHeight = height || canvas.clientHeight || 288;

  const PIXI = window.PIXI;
  const app = new PIXI.Application({
    view: canvas,
    width: viewWidth,
    height: viewHeight,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  app.ticker.maxFPS = fps;

  // Register loose VTube-Studio-style motion/expression files before load,
  // and backfill a blank EyeBlink parameter group so she blinks naturally
  // (see augmentModelSettings). Override the parameter names for a model
  // that uses non-standard ids; empty disables the auto-blink backfill.
  const eyeBlinkParamIds = parseParamIdList(
    env.MANA_LIVE2D_EYE_BLINK_PARAMS,
    config.eyeBlinkParams,
  );
  // Parameters neutralized outside idle to keep the iris constant-sized
  // (see the fixed-iris block below). Same override/empty-disables
  // convention as eyeBlinkParamIds.
  const smileParamIds = parseParamIdList(
    env.MANA_LIVE2D_SMILE_PARAMS,
    config.smileParams,
  );
  const browParamIds = parseParamIdList(
    env.MANA_LIVE2D_BROW_PARAMS,
    config.browParams,
  );
  const modelDir = path.dirname(modelJson);
  const rawSettings = JSON.parse(fs.readFileSync(modelJson, "utf8"));
  const dirFiles = fs.readdirSync(modelDir);
  const settings = augmentModelSettings(
    rawSettings,
    dirFiles.filter((name) => name.toLowerCase().endsWith(".motion3.json")),
    dirFiles.filter((name) => name.toLowerCase().endsWith(".exp3.json")),
    eyeBlinkParamIds,
  );
  settings.url = pathToFileURL(modelJson).href;

  const model = await PIXI.live2d.Live2DModel.from(settings, {
    autoInteract: false,
  });

  const modelWidth = model.width / model.scale.x;
  const modelHeight = model.height / model.scale.y;
  let zoomLevel = "full";

  function applyZoom(level) {
    const framing = computeZoomFraming(
      level,
      modelWidth,
      modelHeight,
      viewWidth,
      viewHeight,
      config.zoomFractions,
    );
    model.scale.set(framing.scale);
    model.x = framing.x;
    model.y = framing.y;
  }

  const fit = fitModelToView(modelWidth, modelHeight, viewWidth, viewHeight);
  model.scale.set(fit.scale);
  model.x = fit.x;
  model.y = fit.y;
  app.stage.addChild(model);

  const motionOverrides = mergeStateMappings(
    parseStateMappingOverrides(env.MANA_LIVE2D_STATE_MOTIONS),
    config.stateMotions,
  );
  const expressionOverrides = mergeStateMappings(
    parseStateMappingOverrides(env.MANA_LIVE2D_STATE_EXPRESSIONS),
    config.stateExpressions,
  );

  const coreModel = model.internalModel.coreModel;
  const motionManager = model.internalModel.motionManager;

  // Some idle motions pitch the head back dramatically ("falling
  // backwards"); ease that toward a gentle side tilt instead, so idle reads
  // as dozing off sideways. Tune per-model (mana-avatar.json) or via env;
  // sign/magnitude depends on the model's rig — a model whose idle motion
  // doesn't need this can zero both out in its config.
  const idleTiltAngleZ =
    env.MANA_LIVE2D_IDLE_TILT_DEG !== undefined
      ? Number(env.MANA_LIVE2D_IDLE_TILT_DEG)
      : config.idleTiltDeg;
  const idleTiltMaxAngleY =
    env.MANA_LIVE2D_IDLE_MAX_PITCH_DEG !== undefined
      ? Number(env.MANA_LIVE2D_IDLE_MAX_PITCH_DEG)
      : config.idleMaxPitchDeg;
  // Real Cubism head-angle parameters rarely exceed ~30 degrees, so a max
  // pitch at or above 90 can never actually clamp anything — that's the
  // opt-out: set idleTiltDeg: 0, idleMaxPitchDeg: 90 in mana-avatar.json (or
  // the matching env vars) for a model whose idle motion doesn't need this.
  const idleTiltActive = idleTiltAngleZ !== 0 || idleTiltMaxAngleY < 90;
  const idleTiltBlendMs = 900;
  let idleTiltBlend = 0;

  // Drive the mouth parameter and idle head tilt after each motion update,
  // so the underlying motion clip cannot overwrite them.
  let mouthTarget = 0;
  let mouthValue = 0;
  let lastTick = performance.now();
  const eyeBlink = model.internalModel.eyeBlink;
  const originalUpdate = motionManager.update.bind(motionManager);
  motionManager.update = (...args) => {
    const result = originalUpdate(...args);
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;

    mouthValue = smoothMouthValue(mouthValue, mouthTarget, dt);
    try {
      coreModel.setParameterValueById(mouthParam, mouthValue);
    } catch (e) {}

    if (idleTiltActive) {
      const tiltTarget = currentState === "idle" ? 1 : 0;
      const tiltAlpha = Math.min(1, dt / idleTiltBlendMs);
      idleTiltBlend += (tiltTarget - idleTiltBlend) * tiltAlpha;
      if (idleTiltBlend > 0.001) {
        try {
          const rawY = coreModel.getParameterValueById("ParamAngleY");
          const clampedY = Math.max(
            -idleTiltMaxAngleY,
            Math.min(idleTiltMaxAngleY, rawY),
          );
          coreModel.setParameterValueById(
            "ParamAngleY",
            rawY + (clampedY - rawY) * idleTiltBlend,
          );

          const rawZ = coreModel.getParameterValueById("ParamAngleZ");
          coreModel.setParameterValueById(
            "ParamAngleZ",
            rawZ + (idleTiltAngleZ - rawZ) * idleTiltBlend,
          );
        } catch (e) {}
      }
    }

    // Keep the iris visually constant-sized outside of idle: hold the eye
    // at a fixed wide-open level (eyeOpenScale, ~75% of this parameter's
    // 0..2 range by default) except during an actual blink, and neutralize
    // the smile-squint curve (smileParamIds) and any eyebrow movement
    // (browParamIds) that would otherwise cover part of the iris.
    // Motions/expressions don't get a say in these while she's not idle;
    // blinking itself is untouched, just driven by us instead of whatever
    // clip happens to be playing, so it always reads as one consistent,
    // naturally-timed blink rather than a motion's own baked beat
    // repeating every loop. Idle keeps its own eyes — the sleepy motion's
    // gradual doze-off close and brow relax are intentional. All three
    // param lists (eyeBlink/smile/brow) are overridable per model via env,
    // and any parameter id a model doesn't have is a harmless no-op.
    if (currentState !== "idle") {
      if (eyeBlink) {
        try {
          eyeBlink.updateParameters(coreModel, dt / 1000);
          for (const id of eyeBlinkParamIds) {
            const v = coreModel.getParameterValueById(id);
            coreModel.setParameterValueById(id, v * eyeOpenScale);
          }
        } catch (e) {}
      }
      try {
        for (const id of smileParamIds) {
          coreModel.setParameterValueById(id, 0);
        }
        for (const id of browParamIds) {
          coreModel.setParameterValueById(id, 0);
        }
      } catch (e) {}
    }

    // Whenever we've taken over the eye-open parameters ourselves (above),
    // tell the SDK a motion is still "updating" even if none is, so its
    // own internal auto-blink call (which runs independently right after
    // this function returns) doesn't also fire and double-advance the
    // blink clock for the same frame.
    return currentState === "idle" ? result : true;
  };

  // The motion manager auto-replays whatever group is in
  // motionManager.groups.idle any time no other motion is queued
  // (shouldRequestIdleMotion() only checks "is anything queued", it has no
  // real idea of "idle" as a concept) — so we reuse that mechanism for
  // every state, not just idle: point it at the CURRENT state's own motion
  // group. That makes an emotional reaction (e.g. angry -> shake) keep
  // looping for as long as she's actually in that state, instead of
  // playing once and freezing partway through a long reply. States with no
  // motion of their own (this model has no Talk/Speak clip for "talking")
  // leave nothing to loop, which also keeps sleepy from auto-firing while
  // she's actively mid-sentence.
  let currentState = "idle";

  function autoLoopGroupForState(state) {
    return motionGroupForState(
      state,
      Object.keys(motionManager.definitions || {}),
      motionOverrides,
    );
  }

  function setAutoLoopMotionGroup(state) {
    try {
      if (motionManager.groups) {
        motionManager.groups.idle = autoLoopGroupForState(state) || undefined;
      }
    } catch (e) {}
  }
  setAutoLoopMotionGroup("idle");

  function playStateMotion(state) {
    try {
      const definitions = motionManager.definitions || {};
      const group = motionGroupForState(
        state,
        Object.keys(definitions),
        motionOverrides,
      );
      if (group) {
        // Priority 3 (FORCE) so emotional reactions cut off the idle motion.
        model.motion(group, undefined, state === "idle" ? 1 : 3);
      }
    } catch (error) {
      console.warn("Live2D motion failed:", error);
    }
  }

  function applyStateExpression(state) {
    try {
      const expressionManager = motionManager.expressionManager;
      if (!expressionManager) {
        return;
      }
      const names = (expressionManager.definitions || [])
        .map((definition) => definition.Name || definition.name)
        .filter(Boolean);
      const expression = expressionForState(state, names, expressionOverrides);
      if (expression) {
        model.expression(expression);
      } else if (
        state === "idle" &&
        typeof expressionManager.resetExpression === "function"
      ) {
        // Only "idle" resets to the model's default face when unmapped.
        // States like "talking" have no dedicated expression on this model
        // (no Talk-specific face), so leave whatever's currently showing
        // alone instead of wiping an excited/angry/idle expression blank
        // the instant she starts a reply.
        expressionManager.resetExpression();
      }
    } catch (error) {
      console.warn("Live2D expression failed:", error);
    }
  }

  // Ambient motions (e.g. her spirit drifting in) at random intervals,
  // restricted to the configured states.
  let randomMotionTimers = [];
  config.randomMotions.forEach((entry, index) => {
    const scheduleNext = () => {
      const delay = nextRandomDelay(entry.minIntervalMs, entry.maxIntervalMs);
      randomMotionTimers[index] = setTimeout(() => {
        try {
          if (entry.states.includes(currentState)) {
            // Priority 2 (NORMAL): plays over the idle loop but never cuts
            // off a forced emotion reaction.
            model.motion(entry.group, undefined, 2);
          }
        } catch (error) {
          console.warn("Random motion failed:", error);
        }
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  });

  console.log(`Live2D avatar loaded: ${modelJson}`);
  playStateMotion("idle");
  applyStateExpression("idle");

  // Debug hook: inspect live model/expression/motion state from DevTools
  // (or `mcp__Claude_Browser__javascript_tool` / a CDP Runtime.evaluate call)
  // without needing to wire up new IPC each time something looks off.
  try {
    window.__manaLive2D = {
      app,
      model,
      motionManager,
      expressionManager: motionManager.expressionManager,
      coreModel,
      motionOverrides,
      expressionOverrides,
    };
  } catch (e) {}

  return {
    setState(state) {
      const nextState = String(state || "idle");
      if (nextState === currentState) {
        return;
      }
      currentState = nextState;
      setAutoLoopMotionGroup(nextState);
      if (nextState !== "talking") {
        mouthTarget = 0;
      }
      playStateMotion(nextState);
      applyStateExpression(nextState);
    },
    setMouthTarget(rms) {
      mouthTarget = rmsToMouth(rms, { gain: mouthGain });
    },
    setZoom(level) {
      zoomLevel = String(level || "full");
      applyZoom(zoomLevel);
      return zoomLevel;
    },
    cycleZoom() {
      zoomLevel = nextZoomLevel(zoomLevel);
      applyZoom(zoomLevel);
      return zoomLevel;
    },
    getZoom() {
      return zoomLevel;
    },
    stop() {
      for (const timer of randomMotionTimers) {
        clearTimeout(timer);
      }
      randomMotionTimers = [];
      try {
        app.destroy(false, { children: true });
      } catch (e) {}
    },
  };
}

module.exports = { createLive2dAvatar, live2dRuntimeAvailable };
