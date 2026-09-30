// Issue #670: browser CSRF + DNS-rebinding guard.
//
// Any web page open in the user's browser can send requests to
// 127.0.0.1:5005. Two checks stop that without touching Mana's own clients:
// the native launcher, Node/Electron main processes, curl, the MCP server
// and ACP bridge send no Origin header at all, and neither does fetch() from
// the Electron launchers' file:// renderers (checked on Electron 43.4.0;
// their WebSockets send "file://").
//
// - Host: a DNS-rebinding page reaches us under the attacker's own hostname,
//   so only IP literals, "localhost", and hosts listed in MANA_ALLOWED_HOSTS
//   (or the tunnel URL) are accepted. The port isn't checked: rebinding
//   can't be told apart by port, and a tunnel or proxy may rewrite it.
// - Origin, on state-changing methods and WebSocket upgrades: same-origin
//   pages this backend serves (admin UI, mobile PWA), "file://" (Electron
//   renderers' WebSockets), browser extensions (the context-push extension;
//   installing one is already a trust decision), and MANA_ALLOWED_ORIGINS.
//   Chrome's own file:// pages and sandboxed iframes send "null", which
//   stays blocked.
//
// /v1/* and /api/memory* are exempt from the Origin check and allow any CORS
// origin: every route there demands a valid API key (authMiddleware), which
// a cross-site page doesn't have, and Obsidian (app://obsidian.md) calls them.
//
// On top of this, every route and WebSocket needs an admin key unless
// admin-key.js lists it as public, so an allowed Origin (a browser
// extension, say) still gets nothing else without the key.
const net = require("net");
const { presentsAdminKey } = require("./admin-key");

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/;
const API_KEY_PATHS = /^\/(v1\/|api\/memory(\/|$))/;

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

// "[::1]:5005" -> "::1", "LocalHost.:5005" -> "localhost"
function hostnameOf(hostHeader) {
  const host = String(hostHeader).trim().toLowerCase();
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (ipv6) return ipv6[1];
  return host.replace(/:\d+$/, "").replace(/\.$/, "");
}

function createRequestGuard(env = process.env) {
  const allowedHosts = new Set(["localhost", ...splitList(env.MANA_ALLOWED_HOSTS)]);
  for (const name of ["MANA_TUNNEL_URL", "CLOUDFLARE_TUNNEL_URL"]) {
    try {
      if (env[name]) allowedHosts.add(new URL(env[name]).hostname.toLowerCase());
    } catch {
      // not a URL -- nothing to allow
    }
  }
  const allowedOrigins = new Set(["file://", ...splitList(env.MANA_ALLOWED_ORIGINS)]);
  const warned = new Set();

  function isAllowedHost(req) {
    const header = req.headers.host;
    // Browsers always send Host, so a request without one isn't rebinding.
    if (header === undefined) return true;
    const hostname = hostnameOf(header);
    return net.isIP(hostname) !== 0 || allowedHosts.has(hostname);
  }

  function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const normalized = String(origin).trim().toLowerCase();
    if (allowedOrigins.has(normalized) || EXTENSION_ORIGIN.test(normalized)) {
      return true;
    }
    try {
      return new URL(normalized).host === String(req.headers.host || "").toLowerCase();
    } catch {
      return false; // "null" and other opaque origins
    }
  }

  function blockReason(req, { upgrade = false } = {}) {
    if (!isAllowedHost(req)) {
      return `Host "${req.headers.host}" is not allowed. Add it to MANA_ALLOWED_HOSTS if you reach Mana through that name.`;
    }
    const checkOrigin =
      upgrade || (STATE_CHANGING_METHODS.has(req.method) && !API_KEY_PATHS.test(req.path));
    if (checkOrigin && !isAllowedOrigin(req)) {
      return `Origin "${req.headers.origin}" is not allowed. Add it to MANA_ALLOWED_ORIGINS if it's your own client.`;
    }
    return null;
  }

  // ponytail: capped so a rebinding page cycling hostnames can't grow it.
  function warnOnce(reason) {
    if (warned.has(reason) || warned.size >= 100) return;
    warned.add(reason);
    console.warn(`[Mana] Blocked a request (#670): ${reason}`);
  }

  function middleware(req, res, next) {
    const reason = blockReason(req);
    if (!reason) return next();
    warnOnce(reason);
    return res.status(403).json({ error: reason });
  }

  // cors()'s per-request options form: reflect allowed origins only.
  function corsOptions(req, callback) {
    callback(null, { origin: isAllowedOrigin(req) || API_KEY_PATHS.test(req.path) });
  }

  // A WebSocket sends the admin key as a header, or -- browser WebSockets
  // (the Electron renderers) can't set headers -- as ?key=.
  function upgradeHasKey(req) {
    if (presentsAdminKey(req, env)) return true;
    let key = "";
    try {
      key = new URL(req.url || "/", "http://localhost").searchParams.get("key") || "";
    } catch {
      return false;
    }
    return Boolean(key) && presentsAdminKey({ headers: { ...req.headers, "x-admin-token": key }, socket: req.socket }, env);
  }

  // For the ws servers' 'upgrade' handlers: true if the socket was rejected.
  function rejectUpgrade(req, socket) {
    const reason = blockReason(req, { upgrade: true });
    if (reason) {
      warnOnce(reason);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return true;
    }
    if (upgradeHasKey(req)) return false;
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return true;
  }

  return { corsOptions, isAllowedHost, isAllowedOrigin, middleware, rejectUpgrade };
}

module.exports = { createRequestGuard };
