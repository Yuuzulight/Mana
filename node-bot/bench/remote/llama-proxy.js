// A llama-server on another machine (the Colab notebook in this folder), served to the bench as if it ran here: it listens
// on the bench's own llama-server port, adds the remote's API key, and answers /props with the local copy's path so the
// runtime adopts it (it adopts a server only when it serves the model it asked for; the notebook has already checked the
// remote file's SHA-256 against this one).
//
//   node bench/remote/llama-proxy.js --remote https://<name>.trycloudflare.com --key <api key> --model <local .gguf> [--port 8097]
//   node bench/self-work-bench.js --adopt --model <the same .gguf> --context 32768 ...
const http = require("node:http");
const https = require("node:https");

function createProxy({ remote, key, modelPath, upstream = { http, https } }) {
  const target = new URL(remote);
  const lib = target.protocol === "https:" ? upstream.https : upstream.http;
  return http.createServer((req, res) => {
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${key}` };
    delete headers["accept-encoding"];
    const out = lib.request({ hostname: target.hostname, port: target.port || undefined, path: req.url, method: req.method, headers }, (up) => {
      if (req.url.split("?")[0] === "/props" && up.statusCode === 200) {
        const parts = [];
        up.on("data", (c) => parts.push(c));
        up.on("end", () => {
          let body = Buffer.concat(parts);
          try {
            body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8")), model_path: modelPath }));
          } catch {}
          res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
          res.end(body);
        });
        return;
      }
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    out.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`the remote llama-server didn't answer: ${e.message}`);
    });
    req.pipe(out);
  });
}

module.exports = { createProxy };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name) => argv[argv.indexOf(name) + 1];
  const remote = opt("--remote");
  const key = opt("--key");
  const model = opt("--model");
  if (!remote || !key || !model) {
    console.error("usage: node bench/remote/llama-proxy.js --remote <url> --key <api key> --model <local .gguf> [--port 8097]");
    process.exit(2);
  }
  const port = Number(opt("--port")) || 8097;
  createProxy({ remote, key, modelPath: require("node:path").resolve(model) }).listen(port, "127.0.0.1", () => console.log(`Forwarding 127.0.0.1:${port} to ${remote}`));
}
