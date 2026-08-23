const { ipcRenderer } = require("electron");
const { createLive2dAvatar } = require("./live2d-avatar");
const { createVrmAvatar } = require("./vrm-avatar");

const live2dCanvas = document.getElementById("live2d");
const vrmCanvas = document.getElementById("vrm");

let activeAvatar = null;
let currentState = "idle";

function setAvatarState(state, preferredExpression) {
  const nextState = ["idle", "talking", "excited", "angry"].includes(state) ? state : "idle";
  currentState = nextState;
  document.body.dataset.state = nextState;
  if (activeAvatar) {
    activeAvatar.setState(nextState, preferredExpression);
  }
}

ipcRenderer.on("avatar:state", (event, state, preferredExpression) => {
  setAvatarState(state, preferredExpression);
});

// Speech amplitude (0..1-ish RMS) plus the audio's classified viseme
// (issue #275, falls back to the older spectral centroid in Hz when
// unavailable) from the main window drive the mouth.
ipcRenderer.on("avatar:mouth", (event, rms, centroidHz, viseme) => {
  if (activeAvatar) {
    activeAvatar.setMouthTarget(rms, centroidHz, viseme);
  }
});

setAvatarState("idle");

// VRM is preferred when a model is configured (issue #161); Live2D is the
// fallback, matching how Mana already degrades when a model is missing --
// no sprite/PNG fallback is invented for either path.
async function loadAvatar() {
  try {
    const vrmInstance = await createVrmAvatar({
      canvas: vrmCanvas,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (vrmInstance) {
      vrmCanvas.hidden = false;
      live2dCanvas.hidden = true;
      return vrmInstance;
    }
  } catch (error) {
    console.error("VRM avatar failed to load, falling back to Live2D:", error);
  }

  try {
    const live2dInstance = await createLive2dAvatar({
      canvas: live2dCanvas,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (live2dInstance) {
      live2dCanvas.hidden = false;
      vrmCanvas.hidden = true;
      return live2dInstance;
    }
  } catch (error) {
    console.error("Live2D avatar failed to load:", error);
  }

  return null;
}

loadAvatar().then((instance) => {
  if (instance) {
    activeAvatar = instance;
    activeAvatar.setState(currentState);
  }
});

// Issue #398/#362: same caption feed the main window's renderer.js already
// wires up, just for whenever this overlay -- not the main window -- is
// what's actually visible (the default state, since the main window hides
// after startup). Purely additive -- if the socket never connects,
// everything else here behaves exactly as before.
(function initCaptions() {
  try {
    if (typeof createCaptionClient !== "function") return;
    const el = document.getElementById("mana-captions");
    if (!el) return;
    createCaptionClient({
      onCaption: ({ text }) => {
        el.textContent = text;
        el.hidden = false;
      },
    }).connect();
  } catch (e) {
    // Captions must never take the avatar overlay down with them.
  }
})();
