const { ipcRenderer } = require("electron");

const avatar = document.getElementById("avatar");
const states = {
  idle: "../assets/avatar/idle.svg",
  talking: "../assets/avatar/talking.svg",
};

function setAvatarState(state) {
  const nextState = states[state] ? state : "idle";
  document.body.dataset.state = nextState;
  avatar.src = states[nextState];
}

ipcRenderer.on("avatar:state", (event, state) => {
  setAvatarState(state);
});

setAvatarState("idle");
