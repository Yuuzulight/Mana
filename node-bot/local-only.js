const net = require("node:net");

// #670 (Q22): local-only mode, off by default. It keeps everything on
// this PC and the local network: cloud AI/TTS/STT providers can't be
// configured, and any connection node-bot would open to anywhere else fails
// with an explanation instead. On when either says so: MANA_LOCAL_ONLY=1
// (node-bot/.env or the environment), or the native launcher's Settings
// toggle, which it passes as MANA_LAUNCHER_LOCAL_ONLY=1 -- its own name, so
// a MANA_LOCAL_ONLY line in .env (which .env loading lets win) can't turn
// the toggle off.
function isLocalOnly(env = process.env) {
  return env.MANA_LOCAL_ONLY === "1" || env.MANA_LAUNCHER_LOCAL_ONLY === "1";
}

// This PC or the LAN: "localhost", loopback and private/link-local IPs
// (IPv4-mapped IPv6 included). Any other hostname counts as outside --
// telling needs a DNS lookup, so reach LAN machines by IP address.
const LOCAL_NETWORKS = new net.BlockList();
LOCAL_NETWORKS.addSubnet("127.0.0.0", 8);
LOCAL_NETWORKS.addSubnet("10.0.0.0", 8);
LOCAL_NETWORKS.addSubnet("172.16.0.0", 12);
LOCAL_NETWORKS.addSubnet("192.168.0.0", 16);
LOCAL_NETWORKS.addSubnet("169.254.0.0", 16);
LOCAL_NETWORKS.addAddress("::1", "ipv6");
LOCAL_NETWORKS.addSubnet("fc00::", 7, "ipv6");
LOCAL_NETWORKS.addSubnet("fe80::", 10, "ipv6");

function isLocalHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost") return true;
  const family = net.isIP(h);
  return family !== 0 && LOCAL_NETWORKS.check(h, family === 6 ? "ipv6" : "ipv4");
}

function localOnlyError(what) {
  return new Error(
    `Local-only mode is on (Settings > Connection, or MANA_LOCAL_ONLY=1 in node-bot/.env), so ${what} is blocked: it would leave this PC and your local network.`,
  );
}

// For tools whose first hop is local but whose whole job is the internet
// (web search through SearXNG, video downloads, the browser).
function refuseIfLocalOnly(what, env = process.env) {
  if (isLocalOnly(env)) throw localOnlyError(what);
}

function assertLocalUrl(url, what, env = process.env) {
  if (!isLocalOnly(env)) return;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // Unparseable: refused below.
  }
  if (!isLocalHost(host)) throw localOnlyError(`${what} ${host || url || "an unset address"}`);
}

// Every TCP connection in this process -- fetch, http(s), WebSocket, the
// Discord client, axios -- goes through net.Socket.prototype.connect, so
// one check there covers them all. The socket fails with an 'error' event
// (never a synchronous throw inside someone's request code). fetch is also
// wrapped so its callers see the explanation rather than "fetch failed".
// Child processes (MCP servers, git, yt-dlp, the browser) are outside
// this; the tools that start them check refuseIfLocalOnly themselves.
let installed = false;
function installLocalOnlyGuard() {
  if (installed) return;
  installed = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    // net.connect/tls.connect pass one pre-normalized [options, cb] array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host = null; // null: a named pipe, always local
    if (first && typeof first === "object") {
      if (!first.path) host = first.host || "localhost";
    } else if (typeof first === "number" || /^\d+$/.test(String(first))) {
      host = typeof args[1] === "string" ? args[1] : "localhost";
    }
    if (host !== null && !isLocalHost(host)) {
      process.nextTick(() => this.destroy(localOnlyError(`the connection to ${host}`)));
      return this;
    }
    return connect.apply(this, args);
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    assertLocalUrl(url, "the request to", { MANA_LOCAL_ONLY: "1" });
    return realFetch.call(this, input, init);
  };
}

module.exports = {
  assertLocalUrl,
  installLocalOnlyGuard,
  isLocalHost,
  isLocalOnly,
  refuseIfLocalOnly,
};
