const { ipcRenderer } = require("electron");
const { createLive2dAvatar } = require("./live2d-avatar");

const live2dCanvas = document.getElementById("live2d");

let live2dAvatar = null;
let currentState = "idle";

function setAvatarState(state) {
  const nextState = ["idle", "talking", "excited", "angry"].includes(state) ? state : "idle";
  currentState = nextState;
  document.body.dataset.state = nextState;
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
      live2dAvatar.setState(currentState);
    }
  })
  .catch((error) => {
    // No sprite fallback -- only the Live2D model is ever shown, so a
    // failure here just leaves the overlay blank instead of resurrecting
    // old placeholder art.
    console.error("Live2D avatar failed to load:", error);
  });
