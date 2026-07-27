const { ipcRenderer } = require("electron");
const { createLive2dAvatar } = require("./live2d-avatar");
const { createVrmAvatar } = require("./vrm-avatar");

const live2dCanvas = document.getElementById("live2d");
const vrmCanvas = document.getElementById("vrm");

let activeAvatar = null;
let currentState = "idle";

function setAvatarState(state) {
  const nextState = ["idle", "talking", "excited", "angry"].includes(state) ? state : "idle";
  currentState = nextState;
  document.body.dataset.state = nextState;
  if (activeAvatar) {
    activeAvatar.setState(nextState);
  }
}

ipcRenderer.on("avatar:state", (event, state) => {
  setAvatarState(state);
});

// Speech amplitude from the main window (0..1-ish RMS) drives the mouth.
ipcRenderer.on("avatar:mouth", (event, rms) => {
  if (activeAvatar) {
    activeAvatar.setMouthTarget(rms);
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
