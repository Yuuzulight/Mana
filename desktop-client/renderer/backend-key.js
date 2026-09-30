// Every backend route needs an admin key unless node-bot lists it as public
// (node-bot/admin-key.js). main.js hands node-bot this run's key when it
// starts it. Loaded before every other script, so each fetch() to the
// backend carries the key without touching the call sites.
(function sendBackendKey() {
  const key = window.electronAPI?.getBackendKey?.() || "";
  if (!key) return;
  const plainFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!String(url).startsWith("http://127.0.0.1:5005")) return plainFetch(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has("x-admin-token")) headers.set("x-admin-token", key);
    return plainFetch(input, { ...init, headers });
  };
})();
