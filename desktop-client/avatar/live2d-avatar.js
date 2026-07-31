// Shared Live2D avatar driver, ported from windows-launcher/avatar/live2d-avatar.js
// for the desktop-client chat window. See desktop-client/AVATAR_NOTICE.md
// for the current default-avatar situation.
// Expects the page to have loaded (in order):
//   assets/live2d/live2dcubismcore.min.js
//   node_modules/pixi.js/dist/browser/pixi.min.js
//   node_modules/pixi-live2d-display/dist/cubism4.min.js
//   avatar/live2d-logic.js
// This file runs in the renderer, which has no fs/path/require access
// (context-isolated, see issue #122) -- model/config discovery and file
// reads happen in the main process (avatar/resolve-model.js) and reach
// here over IPC via window.electronAPI.resolveAvatarModel().
//
// Wrapped in an IIFE (renderer-only, no Node/CJS consumer) so its top-level
// declarations don't leak into the shared global scope classic scripts
// otherwise all share -- see live2d-logic.js for why that matters.
(function () {

const {
  augmentModelSettings,
  centroidToMouthForm,
  computeZoomFraming,
  visemeToMouthForm,
  DEFAULT_IDLE_GAZE_PERIOD_MS,
  expressionForState,
  fitModelToView,
  mergeStateMappings,
  motionGroupForState,
  nextRandomDelay,
  nextZoomLevel,
  parseParamIdList,
  parseStateMappingOverrides,
  pickIdleSaccadeTarget,
  randomSaccadeInterval,
  rmsToMouth,
  smoothMouthValue,
  smoothTowardTarget,
} = window.Live2DLogic;

function live2dRuntimeAvailable() {
  return (
    typeof window.Live2DCubismCore !== "undefined" &&
    typeof window.PIXI !== "undefined" &&
    window.PIXI.live2d &&
    typeof window.PIXI.live2d.Live2DModel !== "undefined"
  );
}

// Creates a Live2D avatar bound to `canvas`. Returns null when the runtime
// or model is unavailable (callers fall back to sprites), otherwise:
//   { setState(state), setMouthTarget(rms), setZoom(level), cycleZoom(),
//     getZoom(), stop() }
// Zoom levels are "full" | "waist" | "bust" (see live2d-logic's ZOOM_LEVELS).
async function createLive2dAvatar({ canvas, width, height }) {
  if (!live2dRuntimeAvailable()) {
    console.log("Live2D runtime not available; using sprite avatar");
    return null;
  }

  const resolved = await window.electronAPI.resolveAvatarModel();
  if (!resolved || !resolved.modelJson) {
    console.log("No Live2D model found; using sprite avatar");
    return null;
  }
  if (resolved.validation && !resolved.validation.valid) {
    // resolve-model.js already logged the detailed missing-file list from
    // the main process; bail the same way as "no model found" rather than
    // letting Live2DModel.from() fail deep inside pixi-live2d-display.
    console.log("Live2D model is missing required file(s); using sprite avatar");
    return null;
  }
  const { modelJson, config, env } = resolved;

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
  // Mouth *shape* (not openness) driven by the voice's spectral brightness,
  // layered on top of mouthParam -- see live2d-logic.js's
  // centroidToMouthForm. 0 (or an empty mouthFormParam) opts out.
  const mouthFormParam = env.MANA_LIVE2D_MOUTH_FORM_PARAM || config.mouthFormParam;
  const mouthFormGain =
    env.MANA_LIVE2D_MOUTH_FORM_GAIN !== undefined
      ? Number(env.MANA_LIVE2D_MOUTH_FORM_GAIN)
      : config.mouthFormGain;
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

  // Guard against a bad frame (e.g. a corrupt/incompatible model triggering
  // a WebGL error) taking down the render loop silently forever instead of
  // stopping cleanly with a diagnosable log line.
  app.ticker.remove(app.render, app);
  app.ticker.add(() => {
    try {
      app.render();
    } catch (error) {
      console.error("Live2D render error, stopping ticker:", error);
      app.ticker.stop();
    }
  });

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
  const settings = augmentModelSettings(
    resolved.rawSettings,
    resolved.motionFileNames,
    resolved.expressionFileNames,
    eyeBlinkParamIds,
  );
  settings.url = resolved.settingsUrl;

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

  // Subtle idle "looking around" drift (head + eyes) -- separate concern
  // from the sleepy tilt above, so a model can enable/disable either
  // independently. Fades in/out with the same idleBlend used by the tilt so
  // both settle together instead of drifting in and out of sync.
  const idleGazeDeg =
    env.MANA_LIVE2D_IDLE_GAZE_DEG !== undefined
      ? Number(env.MANA_LIVE2D_IDLE_GAZE_DEG)
      : config.idleGazeDeg;
  const idleGazePeriodMs =
    env.MANA_LIVE2D_IDLE_GAZE_PERIOD_MS !== undefined
      ? Number(env.MANA_LIVE2D_IDLE_GAZE_PERIOD_MS)
      : config.idleGazePeriodMs;
  const idleGazeActive = idleGazeDeg !== 0;
  // Ratio against the old fixed-period default, so a per-model
  // idleGazePeriodMs override still means "faster/slower saccades" even
  // though the underlying distribution is now randomized, not periodic.
  const saccadeIntervalScale = idleGazePeriodMs / DEFAULT_IDLE_GAZE_PERIOD_MS;
  let saccadeTarget = { angleX: 0, eyeBallX: 0, eyeBallY: 0 };
  const saccadeCurrent = { angleX: 0, eyeBallX: 0, eyeBallY: 0 };
  let nextSaccadeAt = 0;

  // Drive the mouth parameter and idle head tilt after each motion update,
  // so the underlying motion clip cannot overwrite them.
  let mouthTarget = 0;
  let mouthValue = 0;
  let formTarget = 0;
  let formValue = 0;
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

    // Mouth *shape* from spectral brightness (see setMouthTarget), layered
    // on top of mouthParam above. Only touches mouthFormParam while talking
    // or while there's still a nonzero release tail to smooth out --
    // otherwise it would fight an idle motion/expression's own mouth-form
    // value (e.g. a smile) every frame even while she's not speaking.
    if (mouthFormParam && mouthFormGain !== 0) {
      formValue = smoothTowardTarget(formValue, formTarget, dt, 180);
      if (currentState === "talking" || Math.abs(formValue) > 0.01) {
        try {
          coreModel.setParameterValueById(mouthFormParam, formValue * mouthFormGain);
        } catch (e) {}
      }
    }

    if (idleTiltActive || idleGazeActive) {
      const tiltTarget = currentState === "idle" ? 1 : 0;
      const tiltAlpha = Math.min(1, dt / idleTiltBlendMs);
      idleTiltBlend += (tiltTarget - idleTiltBlend) * tiltAlpha;

      if (idleTiltActive && idleTiltBlend > 0.001) {
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

      if (idleGazeActive && idleTiltBlend > 0.001) {
        try {
          // Randomized "look around" saccades (see live2d-logic.js's
          // randomSaccadeInterval/pickIdleSaccadeTarget) instead of a
          // fixed-period sine drift, which read as mechanical over a long
          // idle stretch.
          if (now >= nextSaccadeAt) {
            saccadeTarget = pickIdleSaccadeTarget(idleGazeDeg);
            nextSaccadeAt =
              now + randomSaccadeInterval(Math.random, saccadeIntervalScale);
          }
          saccadeCurrent.angleX = smoothTowardTarget(
            saccadeCurrent.angleX,
            saccadeTarget.angleX,
            dt,
            500,
          );
          saccadeCurrent.eyeBallX = smoothTowardTarget(
            saccadeCurrent.eyeBallX,
            saccadeTarget.eyeBallX,
            dt,
            500,
          );
          saccadeCurrent.eyeBallY = smoothTowardTarget(
            saccadeCurrent.eyeBallY,
            saccadeTarget.eyeBallY,
            dt,
            500,
          );

          const rawX = coreModel.getParameterValueById("ParamAngleX");
          coreModel.setParameterValueById(
            "ParamAngleX",
            rawX + saccadeCurrent.angleX * idleTiltBlend,
          );
          const rawEyeX = coreModel.getParameterValueById("ParamEyeBallX");
          coreModel.setParameterValueById(
            "ParamEyeBallX",
            rawEyeX + saccadeCurrent.eyeBallX * idleTiltBlend,
          );
          const rawEyeY = coreModel.getParameterValueById("ParamEyeBallY");
          coreModel.setParameterValueById(
            "ParamEyeBallY",
            rawEyeY + saccadeCurrent.eyeBallY * idleTiltBlend,
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

  function applyStateExpression(state, preferredName) {
    try {
      const expressionManager = motionManager.expressionManager;
      if (!expressionManager) {
        return;
      }
      const names = (expressionManager.definitions || [])
        .map((definition) => definition.Name || definition.name)
        .filter(Boolean);
      const expression = expressionForState(state, names, expressionOverrides, preferredName);
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
    // Issue #253: preferredName is an LLM-chosen expression for this
    // specific reply. State-driven side effects (motion, mouth reset) stay
    // gated on an actual state change, same as before -- but the expression
    // itself is re-applied whenever preferredName is given even if the
    // coarse state bucket didn't change (e.g. two "excited" replies in a
    // row), since the model asking for a specific expression is a deliberate
    // per-reply signal, not something that should get silently dropped just
    // because the surrounding state happened to already be the same.
    setState(state, preferredName) {
      const nextState = String(state || "idle");
      const stateChanged = nextState !== currentState;
      if (stateChanged) {
        currentState = nextState;
        setAutoLoopMotionGroup(nextState);
        if (nextState !== "talking") {
          mouthTarget = 0;
          formTarget = 0;
        }
        playStateMotion(nextState);
      }
      if (stateChanged || preferredName) {
        applyStateExpression(nextState, preferredName);
      }
    },
    // Issue #275: viseme (the classified "aa"/"ee"/"oo" mouth shape from
    // live2d-logic.js's MFCC-based classifyViseme) takes priority over the
    // older centroidHz-driven form when supplied, same additive shape as
    // setState's preferredName above.
    setMouthTarget(rms, centroidHz, viseme) {
      mouthTarget = rmsToMouth(rms, { gain: mouthGain });
      if (viseme) {
        formTarget = visemeToMouthForm(viseme);
      } else if (centroidHz !== undefined && centroidHz !== null) {
        formTarget = centroidToMouthForm(centroidHz);
      }
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

window.ManaLive2DAvatar = { createLive2dAvatar, live2dRuntimeAvailable };

})();
