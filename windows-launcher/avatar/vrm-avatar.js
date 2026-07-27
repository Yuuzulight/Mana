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
  findVrmFile,
  vrmExpressionForState,
  rmsToMouth,
  smoothMouthValue,
} = require("./vrm-logic");

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
  function applyExpression(state) {
    if (!vrm.expressionManager) return;
    for (const preset of ["happy", "angry", "sad", "relaxed"]) {
      vrm.expressionManager.setValue(preset, 0);
    }
    const preset = vrmExpressionForState(state);
    if (preset) vrm.expressionManager.setValue(preset, 1);
  }

  let mouthTarget = 0;
  let mouthValue = 0;
  let stopped = false;
  let lastTick = performance.now();

  function animate() {
    if (stopped) return;
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;

    mouthValue = smoothMouthValue(mouthValue, mouthTarget, dt);
    if (vrm.expressionManager) {
      vrm.expressionManager.setValue("aa", mouthValue);
      vrm.expressionManager.update();
    }
    vrm.update(dt / 1000);
    renderer.render(scene, camera);
  }
  animate();

  return {
    setState(state) {
      currentState = state;
      applyExpression(state);
    },
    setMouthTarget(rms) {
      mouthTarget = rmsToMouth(rms, {});
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
