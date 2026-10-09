const crypto = require("crypto");
const { getRequestAddress, isLoopbackAddress } = require("./admin-restart");

// #670 (Q23): being on this PC no longer makes a request admin -- every
// local program is "local" too. Admin routes also need a key, sent as
// x-admin-token (or Authorization: Bearer):
// - ADMIN_TOKEN from node-bot/.env: scripts, curl, remote admin.
// - MANA_LAUNCHER_KEY: a fresh random key the native launcher makes each
//   run, passes to the node-bot it starts and sends on its own requests.
//   It only counts from this PC.
// The launcher key is read once and removed from process.env so the tools,
// MCP servers and scripts node-bot starts don't inherit it.
const LAUNCHER_KEY = process.env.MANA_LAUNCHER_KEY || "";
delete process.env.MANA_LAUNCHER_KEY;

// Moved here from server-routes.js (#670), which still re-exports it.
function getSocketAddress(req) {
  return req?.socket?.remoteAddress || "";
}

function getFirstForwardedAddress(req) {
  const forwardedFor =
    typeof req.get === "function"
      ? req.get("x-forwarded-for")
      : req?.headers?.["x-forwarded-for"];
  const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return String(value || "")
    .split(",")[0]
    .trim();
}

// Loopback-only, and if a proxy claims the socket is loopback (e.g. a
// LAN tunnel terminating on the same box), an X-Forwarded-For header
// pointing elsewhere still disqualifies the request.
function isLocalRestartRequest(req) {
  const socketAddress = getSocketAddress(req);
  const requestAddress = getRequestAddress(req);
  const forwardedAddress = getFirstForwardedAddress(req);
  return (
    isLoopbackAddress(socketAddress || requestAddress) &&
    (!forwardedAddress || isLoopbackAddress(forwardedAddress))
  );
}

// req.headers, not req.get(): WebSocket upgrades are plain http requests.
function presentedKeys(req) {
  const auth = String(req.headers?.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return [req.headers?.["x-admin-token"], bearer].filter(Boolean);
}

function keyMatches(presented, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hasAdminKey(req, { local = false, adminToken = process.env.ADMIN_TOKEN } = {}) {
  return presentedKeys(req).some(
    (key) => keyMatches(key, adminToken) || (local && keyMatches(key, LAUNCHER_KEY)),
  );
}

// #1428: the launcher that started this backend, on its own key from this PC.
function hasLauncherKey(req) {
  return isLocalRestartRequest(req) && presentedKeys(req).some((key) => keyMatches(key, LAUNCHER_KEY));
}

const ADMIN_KEY_REQUIRED_ERROR =
  "admin-only: send ADMIN_TOKEN (node-bot/.env) as the x-admin-token header, or use the Mana launcher that started this backend";

// #842: the MANA_ADMIN_SECRET gate (server.js's checkAdminAuth and the
// capabilities' copies). With the secret set, its Bearer token is required,
// as before. Unset -- the default -- these routes used to be open to
// anything that could reach the port; now they need an admin key, like
// every other admin route.
function checkAdminSecret(req, res, secret) {
  if (secret) {
    const auth = String(req.get("authorization") || "");
    if (auth.startsWith("Bearer ") && keyMatches(auth.slice(7).trim(), secret)) return true;
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  if (hasAdminKey(req, { local: isLocalRestartRequest(req) })) return true;
  res.status(401).json({ ok: false, error: ADMIN_KEY_REQUIRED_ERROR });
  return false;
}

// Default deny: every route needs one of the admin keys above (ADMIN_TOKEN,
// the launcher's per-run key from this PC, or MANA_ADMIN_SECRET) unless
// it's listed here. Routes still keep their own, stricter checks on top.
// Everything listed either has its own auth or must answer without a key:
const PUBLIC_ROUTES = new Set([
  // Liveness probes: the launchers, doctor.js and the service scripts.
  "GET /health",
  // Mobile companion (mobile-routes.js): unlock with the passcode, pair
  // with a one-time code, then a session token (requireAuth) or device
  // token. The admin mobile routes check hasAdminKey themselves.
  "GET /mobile/health",
  "POST /mobile/auth/unlock",
  "POST /mobile/pair/complete",
  "GET /mobile/ping",
  "POST /mobile/chat/text",
  "POST /mobile/chat/audio",
  "POST /mobile/synthesize",
  "GET /mobile/summaries",
  "POST /mobile/summaries",
  // API-key routes (authMiddleware): the OpenAI-style API and Obsidian.
  "POST /v1/chat/completions",
  "POST /v1/embeddings",
  "GET /v1/models",
  "GET /api/memory",
  "GET /api/memory/notes",
  // The context-push browser extension, which has no way to hold a key.
  // Loopback only (plugins/context-push), and off unless I enable it.
  "POST /context/push",
  // Admin pages a browser opens by URL; their API calls send the key.
  "GET /admin/token-cache-ui",
  "GET /admin/background-memory-ui",
  "GET /admin/accounts-ui",
  "GET /admin/plugins-ui",
  "GET /admin/plugins/install",
]);
// Static files: the mobile PWA and the admin pages' folder.
const PUBLIC_STATIC_PREFIXES = ["/mobile/app/", "/admin/mobile-devices/"];

function isPublicRoute(method, routePath) {
  const verb = method === "HEAD" ? "GET" : method;
  if (PUBLIC_ROUTES.has(`${verb} ${routePath}`)) return true;
  return verb === "GET" && (routePath === "/mobile/app" || PUBLIC_STATIC_PREFIXES.some((p) => routePath.startsWith(p)));
}

function presentsAdminKey(req, env = process.env) {
  const secret = env.MANA_ADMIN_SECRET || process.env.MANA_ADMIN_SECRET;
  return (
    hasAdminKey(req, { local: isLocalRestartRequest(req), adminToken: env.ADMIN_TOKEN || process.env.ADMIN_TOKEN }) ||
    presentedKeys(req).some((key) => keyMatches(key, secret))
  );
}

function requireAdminKeyByDefault(env = process.env) {
  return (req, res, next) => {
    if (isPublicRoute(req.method, req.path) || presentsAdminKey(req, env)) return next();
    return res.status(401).json({ ok: false, error: ADMIN_KEY_REQUIRED_ERROR });
  };
}

module.exports = {
  ADMIN_KEY_REQUIRED_ERROR,
  checkAdminSecret,
  hasAdminKey,
  hasLauncherKey,
  isLocalRestartRequest,
  isPublicRoute,
  presentsAdminKey,
  requireAdminKeyByDefault,
};
