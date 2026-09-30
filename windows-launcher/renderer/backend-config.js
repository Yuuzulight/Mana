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

// Every backend route needs an admin key unless node-bot lists it as public
// (node-bot/admin-key.js). main.js hands node-bot this run's key when it
// starts it; every fetch() to the backend from these renderer scripts
// carries it, without touching each call site.
const BACKEND_KEY = ipcRenderer.sendSync("get-backend-key-sync");
const fetchWithoutBackendKey = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!BACKEND_KEY || !String(url).startsWith(BACKEND_BASE_URL)) return fetchWithoutBackendKey(input, init);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (!headers.has("x-admin-token")) headers.set("x-admin-token", BACKEND_KEY);
  return fetchWithoutBackendKey(input, { ...init, headers });
};

async function setBackendBaseUrl(url) {
  await ipcRenderer.invoke("set-backend-url", url);
}
