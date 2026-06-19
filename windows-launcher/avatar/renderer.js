const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

const avatar = document.getElementById("avatar");
const assetRoot = path.join(__dirname, "..", "assets", "avatar");
const states = {
  idle: resolveAvatarAsset("idle"),
  talking: resolveAvatarAsset("talking"),
};

function resolveAvatarAsset(name) {
  const pngPath = path.join(assetRoot, `${name}.png`);
  if (fs.existsSync(pngPath)) {
    return `../assets/avatar/${name}.png`;
  }

  return `../assets/avatar/${name}.svg`;
}

function setAvatarState(state) {
  const nextState = states[state] ? state : "idle";
  document.body.dataset.state = nextState;
  avatar.src = states[nextState];
}

ipcRenderer.on("avatar:state", (event, state) => {
  setAvatarState(state);
});

setAvatarState("idle");
