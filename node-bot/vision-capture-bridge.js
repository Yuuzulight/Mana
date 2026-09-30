// Issue #417: a request/response bridge between the server's tool-calling
// loop and the Electron client's screenshot capture. Screenshot capture
// only happens client-side (windows-launcher's desktopCapturer, via the
// existing "screen:capture-primary" IPC handler) -- node-bot has no way to
// take one itself, so a vision__look tool call mid-reply needs something
// that can ask the client to capture right now and wait for the answer.
//
// Deliberately separate from tray-notifier.js/tray-server.js -- that
// channel is fire-and-forget broadcast (server -> client only, no response
// expected). Bolting correlation IDs and pending-promise bookkeeping onto
// it would blur its single "notify, don't wait" purpose. Split the same
// way tray-notifier.js/tray-server.js are split: this module is pure
// request/response bookkeeping, safely requirable (and callable) from
// anywhere with no http.Server dependency -- the actual WebSocket
// transport (vision-capture-server.js) is created later, only once a real
// server starts (startServer(), gated on require.main === module, never
// runs under createApp()-only tests), and wires its "send to the
// connected client" function in via setSender(), mirroring
// tray-notifier.js's setBroadcaster().
const { randomUUID } = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 10000;

function createVisionCaptureBridge({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let sender = null;
  let cameraCheck = null;
  let desktopCheck = null;
  const pending = new Map();

  // #912: hasCamera says whether a connected client can take camera
  // snapshots (the native launcher declares it; Electron doesn't). #911:
  // hasDesktop, likewise, whether one can carry out desktop actions.
  function setSender(fn, hasCamera, hasDesktop) {
    sender = typeof fn === "function" ? fn : null;
    cameraCheck = typeof hasCamera === "function" ? hasCamera : null;
    desktopCheck = typeof hasDesktop === "function" ? hasDesktop : null;
  }

  function hasCamera() {
    return Boolean(cameraCheck?.());
  }

  function hasDesktop() {
    return Boolean(desktopCheck?.());
  }

  function clearPending(requestId) {
    const entry = pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
    }
  }

  // #962: save asks the launcher to write its last camera snapshot to disk
  // and answer with the file's path instead of an image.
  function requestCapture({ camera = false, save = false } = {}) {
    const source = save ? "camera-save" : camera ? "camera" : null;
    return request({ type: "capture-request", ...(source && { source }) }, "capture");
  }

  // #911: a desktop action the launcher carries out (ai/desktop-tool-source.js);
  // resolves with its result object. ms: a longer wait (file moves).
  function requestDesktop(action, args, ms = timeoutMs) {
    return request({ type: "desktop-request", action, args: args || {} }, "desktop", ms);
  }

  function request(message, what, ms = timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof sender !== "function") {
        reject(new Error("no client connected"));
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${what} request timed out`));
      }, ms);
      pending.set(requestId, { resolve, reject, timer });
      const sent = sender({ ...message, requestId });
      if (!sent) {
        clearPending(requestId);
        reject(new Error("no client connected"));
      }
    });
  }

  function resolveCapture(requestId, image) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearPending(requestId);
    entry.resolve(image);
    return true;
  }

  function rejectCapture(requestId, reason) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearPending(requestId);
    entry.reject(new Error(reason || "capture rejected"));
    return true;
  }

  return { requestCapture, requestDesktop, resolveCapture, rejectCapture, setSender, hasCamera, hasDesktop };
}

const visionCaptureBridge = createVisionCaptureBridge();

module.exports = { createVisionCaptureBridge, visionCaptureBridge, DEFAULT_TIMEOUT_MS };
