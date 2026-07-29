// VRM (3D) avatar driver (issue #161) -- a second renderer alongside
// live2d-avatar.js, matching its external shape exactly:
//   { setState(state), setMouthTarget(rms), setZoom(level), cycleZoom(),
//     getZoom(), stop() }
// so avatar/renderer.js and renderer/renderer.js can treat either
// interchangeably. Basic rendering + lip sync + emotion blend shapes only
// -- no spring-bone/physics tuning, per the issue's explicit scope.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const THREE = require("three");
const { GLTFLoader } = require("three/addons/loaders/GLTFLoader.js");
const { VRMLoaderPlugin, VRMUtils } = require("@pixiv/three-vrm");
const {
  BLINK_DURATION_MS,
  blinkValueAt,
  crossfadeValue,
  findVrmFile,
  nextBlinkDelay,
  pickVrmSaccadeOffset,
  randomSaccadeInterval,
  vrmExpressionForState,
  rmsToMouth,
  smoothMouthValue,
  smoothTowardTarget,
} = require("./vrm-logic");
const { centroidToMouthForm, vrmMouthBlendShapes } = require("./lip-sync");

const MODEL_DIR = path.join(__dirname, "model");
const ZOOM_LEVELS = ["full", "waist", "bust"];
// Camera-height fractions (0 = feet, 1 = head) framing what's visible at
// each zoom level -- mirrors live2d-logic.js's DEFAULT_ZOOM_FRACTIONS in
// spirit (crop-to-the-head-progressively), expressed as a look-at target
// height instead of a 2D crop since this is a real 3D camera.
const ZOOM_LOOK_HEIGHT_FRACTION = { full: 0.55, waist: 0.85, bust: 0.97 };
const ZOOM_DISTANCE = { full: 2.6, waist: 1.5, bust: 0.85 };

function findConfiguredVrmFile(env = process.env) {
  const explicit = env.MANA_VRM_MODEL || "";
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  return findVrmFile(MODEL_DIR, fs);
}

// Creates a VRM avatar bound to `canvas`. Returns null when no VRM model
// is configured (callers fall back to Live2D/no avatar), otherwise the
// same interface shape createLive2dAvatar returns.
async function createVrmAvatar({ canvas, width, height, env = process.env }) {
  const vrmPath = findConfiguredVrmFile(env);
  if (!vrmPath) {
    console.log(
      `No VRM model found (looked in ${MODEL_DIR} and MANA_VRM_MODEL); falling back`,
    );
    return null;
  }

  // Same render cap Live2D's PIXI ticker already applies (docs/
  // live2d_avatar_setup.md documents 30 FPS for "keeping GPU cost tiny next
  // to a running game") -- VRM's requestAnimationFrame loop had no cap at
  // all, running at full display refresh rate for no visual benefit in this
  // small avatar window.
  const fps = Number(env.MANA_AVATAR_FPS || 30);
  const minFrameIntervalMs = fps > 0 ? 1000 / fps : 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(0.5, 1, 1);
  scene.add(keyLight);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await new Promise((resolve, reject) => {
    loader.load(pathToFileURL(vrmPath).href, resolve, undefined, reject);
  });
  const vrm = gltf.userData.vrm;
  if (!vrm) {
    throw new Error(`Loaded GLTF has no VRM extension data: ${vrmPath}`);
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  scene.add(vrm.scene);

  // Disable frustum culling: an always-visible, always-animated character's
  // rest-pose bounding boxes go stale once bones move, which can otherwise
  // make parts pop out of view at the frame edge (same fix Project AIRI
  // applies to its VRM renderer).
  vrm.scene.traverse((object) => {
    object.frustumCulled = false;
  });

  // VRM 0.x models face +Z by convention, 1.0 models face -Z; without this
  // correction a 0.x model can load facing away from the camera.
  if (vrm.lookAt) {
    const targetDirection = new THREE.Vector3(0, 0, -1);
    const facingDirection = vrm.lookAt.faceFront.clone();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      facingDirection.normalize(),
      targetDirection.normalize(),
    );
    vrm.scene.quaternion.premultiply(quaternion);
    vrm.scene.updateMatrixWorld(true);
  }

  function headWorldHeight() {
    const head = vrm.humanoid?.getNormalizedBoneNode("head");
    if (!head) return 1.5;
    return head.getWorldPosition(new THREE.Vector3()).y;
  }

  let zoomLevel = "full";
  function applyZoom(level) {
    zoomLevel = ZOOM_LEVELS.includes(level) ? level : "full";
    const headHeight = headWorldHeight();
    const lookHeight = headHeight * ZOOM_LOOK_HEIGHT_FRACTION[zoomLevel];
    camera.position.set(0, lookHeight, ZOOM_DISTANCE[zoomLevel]);
    camera.lookAt(0, lookHeight, 0);
  }
  applyZoom("full");

  let currentState = "idle";

  // Expression preset crossfade: snapshots whatever's currently showing as
  // the transition's start point instead of snapping through 0 first (the
  // old behavior visibly popped between faces in a single frame). Ported
  // from Project AIRI's useVRMEmote, which fixed the same class of bug.
  const EXPRESSION_PRESETS = ["happy", "angry", "sad", "relaxed"];
  const EXPRESSION_BLEND_MS = 300;
  const expressionStartValues = Object.fromEntries(
    EXPRESSION_PRESETS.map((preset) => [preset, 0]),
  );
  const expressionTargetValues = Object.fromEntries(
    EXPRESSION_PRESETS.map((preset) => [preset, 0]),
  );
  let expressionTransitionStart = 0;

  function applyExpression(state) {
    if (!vrm.expressionManager) return;
    for (const preset of EXPRESSION_PRESETS) {
      expressionStartValues[preset] = vrm.expressionManager.getValue(preset) ?? 0;
      expressionTargetValues[preset] = 0;
    }
    const preset = vrmExpressionForState(state);
    if (preset) {
      expressionTargetValues[preset] = 1;
    }
    expressionTransitionStart = performance.now();
  }

  function updateExpressionCrossfade(now) {
    if (!vrm.expressionManager) return;
    const elapsed = now - expressionTransitionStart;
    for (const preset of EXPRESSION_PRESETS) {
      vrm.expressionManager.setValue(
        preset,
        crossfadeValue(
          expressionStartValues[preset],
          expressionTargetValues[preset],
          elapsed,
          EXPRESSION_BLEND_MS,
        ),
      );
    }
  }

  // Auto-blink: VRM has no built-in blink manager the way Cubism/Live2D
  // does, so it's timed manually (see vrm-logic.js's nextBlinkDelay/
  // blinkValueAt, ported from Project AIRI's useBlink).
  let isBlinking = false;
  let blinkElapsed = 0;
  let timeSinceLastBlink = 0;
  let nextBlinkAt = nextBlinkDelay();

  function updateBlink(dt) {
    if (!vrm.expressionManager) return;
    if (!isBlinking) {
      timeSinceLastBlink += dt;
      if (timeSinceLastBlink >= nextBlinkAt) {
        isBlinking = true;
        blinkElapsed = 0;
      }
      return;
    }
    blinkElapsed += dt;
    vrm.expressionManager.setValue("blink", blinkValueAt(blinkElapsed));
    if (blinkElapsed >= BLINK_DURATION_MS) {
      isBlinking = false;
      timeSinceLastBlink = 0;
      nextBlinkAt = nextBlinkDelay();
      vrm.expressionManager.setValue("blink", 0);
    }
  }

  // Idle eye saccades: reuses the same randomized-interval distribution as
  // Live2D's idle gaze (see vrm-logic.js). Fades in/out over
  // IDLE_GAZE_BLEND_MS on entering/leaving idle, same pattern as Live2D's
  // idleTiltBlend, rather than snapping the eyes to/from a look-at target.
  const eyeLookTarget = new THREE.Object3D();
  let saccadeOffset = { x: 0, y: 0 };
  let nextSaccadeAt = 0;
  let idleGazeBlend = 0;
  const IDLE_GAZE_BLEND_MS = 900;

  function updateIdleEyeSaccades(now, dt) {
    if (!vrm.lookAt) return;
    const gazeTarget = currentState === "idle" ? 1 : 0;
    idleGazeBlend += (gazeTarget - idleGazeBlend) * Math.min(1, dt / IDLE_GAZE_BLEND_MS);
    if (idleGazeBlend <= 0.001) return;

    if (now >= nextSaccadeAt) {
      saccadeOffset = pickVrmSaccadeOffset();
      nextSaccadeAt = now + randomSaccadeInterval();
    }

    eyeLookTarget.position.set(
      saccadeOffset.x * idleGazeBlend,
      headWorldHeight() + saccadeOffset.y * idleGazeBlend,
      camera.position.z,
    );
    vrm.lookAt.target = eyeLookTarget;
    vrm.lookAt.update(dt / 1000);
  }

  let mouthTarget = 0;
  let mouthValue = 0;
  let mouthFormTarget = 0;
  let mouthFormValue = 0;
  let stopped = false;
  let lastTick = performance.now();
  let lastRenderTick = performance.now();

  function animate() {
    if (stopped) return;
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;

    mouthValue = smoothMouthValue(mouthValue, mouthTarget, dt);
    mouthFormValue = smoothTowardTarget(mouthFormValue, mouthFormTarget, dt, 180);
    if (vrm.expressionManager) {
      const shapes = vrmMouthBlendShapes(mouthValue, mouthFormValue);
      vrm.expressionManager.setValue("aa", shapes.aa);
      vrm.expressionManager.setValue("ih", shapes.ih);
      vrm.expressionManager.setValue("ou", shapes.ou);
      updateBlink(dt);
      updateExpressionCrossfade(now);
      vrm.expressionManager.update();
    }
    updateIdleEyeSaccades(now, dt);
    vrm.update(dt / 1000);

    // Same render cap Live2D's PIXI ticker applies -- see the `fps`
    // comment above. Animation/expression state above still updates every
    // frame so motion stays smooth; only the actual GPU render is skipped.
    if (minFrameIntervalMs > 0 && now - lastRenderTick < minFrameIntervalMs) {
      return;
    }
    lastRenderTick = now;

    // Guard against a bad frame (e.g. a WebGL context/driver error) taking
    // down the render loop silently forever instead of stopping cleanly
    // with a diagnosable log line -- same fix already applied to Live2D's
    // PIXI ticker.
    try {
      renderer.render(scene, camera);
    } catch (error) {
      console.error("VRM render error, stopping:", error);
      stopped = true;
    }
  }
  animate();

  return {
    setState(state) {
      currentState = state;
      applyExpression(state);
    },
    setMouthTarget(rms, centroidHz) {
      mouthTarget = rmsToMouth(rms, {});
      if (centroidHz !== undefined && centroidHz !== null) {
        mouthFormTarget = centroidToMouthForm(centroidHz);
      }
    },
    setZoom(level) {
      applyZoom(level);
      return zoomLevel;
    },
    cycleZoom() {
      const index = ZOOM_LEVELS.indexOf(zoomLevel);
      applyZoom(ZOOM_LEVELS[(index + 1) % ZOOM_LEVELS.length]);
      return zoomLevel;
    },
    getZoom() {
      return zoomLevel;
    },
    stop() {
      stopped = true;
      renderer.dispose();
    },
  };
}

module.exports = { createVrmAvatar };
