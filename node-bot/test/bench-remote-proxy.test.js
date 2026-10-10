const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createProxy } = require("../bench/remote/llama-proxy");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function get(port, path, init) {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: resp.status, text: await resp.text() };
}

test("the proxy adds the remote's key, answers /props with the local model path, and passes everything else through", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/props" ? JSON.stringify({ model_path: "/content/model.gguf", total_slots: 1 }) : JSON.stringify({ echoed: body }));
    });
  });
  const upPort = await listen(upstream);
  const proxy = createProxy({ remote: `http://127.0.0.1:${upPort}`, key: "k3y", modelPath: "D:\\models\\m.gguf" });
  const port = await listen(proxy);
  try {
    const props = JSON.parse((await get(port, "/props")).text);
    assert.equal(props.model_path, "D:\\models\\m.gguf");
    assert.equal(props.total_slots, 1);
    const chat = await get(port, "/v1/chat/completions", { method: "POST", body: '{"a":1}' });
    assert.deepEqual(JSON.parse(chat.text), { echoed: '{"a":1}' });
    assert.ok(seen.every((s) => s.auth === "Bearer k3y"));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("a remote that's down gives the bench a 502 it can read", async () => {
  const dead = http.createServer();
  const deadPort = await listen(dead);
  dead.close();
  const proxy = createProxy({ remote: `http://127.0.0.1:${deadPort}`, key: "x", modelPath: "m" });
  const port = await listen(proxy);
  try {
    const r = await get(port, "/health");
    assert.equal(r.status, 502);
    assert.match(r.text, /didn't answer/);
  } finally {
    proxy.close();
  }
});
