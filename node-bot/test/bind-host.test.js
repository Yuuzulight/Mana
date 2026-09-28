// Issue #670: the backend binds loopback by default (MANA_BIND_HOST).
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const test = require("node:test");

const { getBindHost, isLoopbackBindHost } = require("../doctor");
const { listenOnBindHost } = require("../server");

test("getBindHost defaults to 127.0.0.1 and strips IPv6 brackets", () => {
  assert.equal(getBindHost({}), "127.0.0.1");
  assert.equal(getBindHost({ MANA_BIND_HOST: "   " }), "127.0.0.1");
  assert.equal(getBindHost({ MANA_BIND_HOST: " 0.0.0.0 " }), "0.0.0.0");
  assert.equal(getBindHost({ MANA_BIND_HOST: "[::1]" }), "::1");
});

test("isLoopbackBindHost accepts only loopback hosts", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"]) {
    assert.equal(isLoopbackBindHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.50", "localhost.evil.com", "127.0.0.1.evil.com", ""]) {
    assert.equal(isLoopbackBindHost(host), false, host);
  }
});

function listen(env) {
  const server = http.createServer((req, res) => res.end("ok"));
  return new Promise((resolve) => {
    listenOnBindHost(server, 0, env).once("listening", () => {
      // the ::1 mirror starts inside the listening callback; let it bind
      setImmediate(() => resolve(server));
    });
  });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function firstExternalIpv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

test("default bind answers on 127.0.0.1 and ::1 but not on a LAN address", async (t) => {
  const server = await listen({});
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { address, port } = server.address();
  assert.equal(address, "127.0.0.1");

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await res.text(), "ok");

  // ::1 mirror: only checkable where the host has IPv6 loopback at all.
  const probe = net.createServer();
  const hasIpv6 = await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
  if (hasIpv6) {
    const v6 = await fetch(`http://[::1]:${port}/`);
    assert.equal(await v6.text(), "ok");
  }

  const lanIp = firstExternalIpv4();
  if (lanIp) assert.equal(await canConnect(lanIp, port), false);
});

// A fake server: really binding 0.0.0.0 here could pop a Windows Firewall
// prompt on a dev machine.
test("a non-loopback MANA_BIND_HOST is passed to listen and warns", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const calls = [];
  try {
    listenOnBindHost({ listen: (...args) => calls.push(args) }, 5005, {
      MANA_BIND_HOST: "0.0.0.0",
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls[0][0], 5005);
  assert.equal(calls[0][1], "0.0.0.0");
  assert.ok(warnings.some((w) => /MANA_BIND_HOST=0\.0\.0\.0/.test(w)));
});

test("a loopback MANA_BIND_HOST does not warn", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    listenOnBindHost({ listen: () => {} }, 5005, { MANA_BIND_HOST: "localhost" });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
});
