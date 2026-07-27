// Issue #190: the backend base URL used to be hardcoded as
// "http://localhost:5005" in 32 places across this file, renderer.js,
// session-sidebar.js, and sidebar-nav.js. Loaded first (before those three)
// so BACKEND_BASE_URL is populated synchronously before any of them run --
// classic script, shared global scope, same pattern the other renderer
// files already use.
const { ipcRenderer } = require("electron");

// Read once at startup via a synchronous IPC call -- this is a connection
// setting that changes rarely, so every call site just references this
// module-level value directly rather than re-fetching it per request; a
// change made in Settings takes effect on next launch, not live.
let BACKEND_BASE_URL = ipcRenderer.sendSync("get-backend-url-sync");

async function setBackendBaseUrl(url) {
  await ipcRenderer.invoke("set-backend-url", url);
}
