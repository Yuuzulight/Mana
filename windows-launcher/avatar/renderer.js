const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");
const { createLive2dAvatar } = require("./live2d-avatar");

const avatar = document.getElementById("avatar");
const live2dCanvas = document.getElementById("live2d");
const assetRoot = path.join(__dirname, "..", "assets", "avatar");
const states = {
  idle: resolveAvatarAsset("idle"),
  talking: resolveAvatarAsset("talking"),
  excited: resolveAvatarAsset("talking"),
  angry: resolveAvatarAsset("talking"),
};

let live2dAvatar = null;
let currentState = "idle";

function resolveAvatarAsset(name) {
  const pngPath = path.join(assetRoot, `${name}.png`);
  if (fs.existsSync(pngPath)) {
    return `../assets/avatar/${name}.png`;
  }

  return `../assets/avatar/${name}.svg`;
}

function setAvatarState(state) {
  const nextState = states[state] ? state : "idle";
  currentState = nextState;
  document.body.dataset.state = nextState;
  avatar.src = states[nextState];
  if (live2dAvatar) {
    live2dAvatar.setState(nextState);
  }
}

ipcRenderer.on("avatar:state", (event, state) => {
  setAvatarState(state);
});

// Speech amplitude from the main window (0..1-ish RMS) drives the mouth.
ipcRenderer.on("avatar:mouth", (event, rms) => {
  if (live2dAvatar) {
    live2dAvatar.setMouthTarget(rms);
  }
});

setAvatarState("idle");

createLive2dAvatar({
  canvas: live2dCanvas,
  width: window.innerWidth,
  height: window.innerHeight,
})
  .then((instance) => {
    if (instance) {
      live2dAvatar = instance;
      document.body.dataset.renderer = "live2d";
      live2dAvatar.setState(currentState);
    }
  })
  .catch((error) => {
    console.warn("Live2D avatar failed to load; using sprite avatar:", error);
    document.body.dataset.renderer = "sprite";
  });
