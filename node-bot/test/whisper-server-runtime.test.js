// #619: the persistent whisper-server. No real process is started -- spawn
// and fetch are fakes; the binaries, model and audio are empty temp files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createWhisperServer, belowNormal } = require("../ai/whisper-server-runtime");

function tempInstall({ withServer = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-whisper-"));
  const files = {
    cli: path.join(dir, "whisper-cli.exe"),
    server: path.join(dir, "whisper-server.exe"),
    model: path.join(dir, "ggml-base.bin"),
    audio: path.join(dir, "clip.wav"),
  };
  for (const [name, file] of Object.entries(files)) {
    if (name !== "server" || withServer) fs.writeFileSync(file, name === "audio" ? "RIFF" : "");
  }
  return files;
}

// A fake whisper-server: healthy once spawned; /inference answers with
// inference() (default: one line per segment, like the real one).
function fakeServer({ inference = async () => ({ ok: true, json: async () => ({ text: " Mana, can\n you hear me?\n" }) }) } = {}) {
  const calls = { spawn: [], requests: [] };
  let up = false;
  return {
    calls,
    spawn: (bin, args, opts) => {
      calls.spawn.push({ bin, args, opts });
      up = true;
      return { stderr: { on: () => {} }, on: () => {}, kill: () => (up = false) };
    },
    fetch: async (url, init) => {
      if (url.endsWith("/health")) return { ok: up };
      calls.requests.push({ url, body: init.body });
      if (url.endsWith("/load")) return { ok: true };
      return inference();
    },
  };
}

function make(server, files, env = {}, threads = () => 2, language = () => "en") {
  return createWhisperServer({
    env,
    spawn: server.spawn,
    fetch: server.fetch,
    sleep: async () => {},
    findCliBin: () => files.cli,
    findModel: () => files.model,
    threads,
    language,
    beamSize: "5",
    noSpeechThreshold: "0.45",
  });
}

function quietly(fn) {
  return async (t) => {
    const { warn, log } = console;
    console.warn = () => {};
    console.log = () => {};
    try {
      await fn(t);
    } finally {
      Object.assign(console, { warn, log });
    }
  };
}

test("transcribes through whisper-server on localhost, passing the prompt through", quietly(async () => {
  const files = tempInstall();
  const server = fakeServer();
  const whisper = make(server, files);

  const text = await whisper.transcribe(files.audio, { prompt: "Mana, Yuuzu", temperature: "0" });

  assert.equal(text, "Mana, can you hear me?");
  assert.equal(server.calls.spawn.length, 1);
  const { bin, args } = server.calls.spawn[0];
  assert.equal(bin, files.server);
  assert.deepEqual(args, [
    "-m", files.model, "--host", "127.0.0.1", "--port", "8093", "-t", "2", "-l", "en",
    "-bs", "5", "-bo", "5", "-nth", "0.45", "--carry-initial-prompt",
  ]);
  const [inference, load] = server.calls.requests;
  assert.equal(inference.url, "http://127.0.0.1:8093/inference");
  assert.equal(inference.body.get("prompt"), "Mana, Yuuzu");
  assert.equal(inference.body.get("temperature"), "0");
  assert.equal(inference.body.get("response_format"), "json");
  assert.equal(await inference.body.get("file").text(), "RIFF");
  // The model is reloaded after every request, so none sees another's state.
  assert.equal(load.url, "http://127.0.0.1:8093/load");
  assert.equal(load.body.get("model"), files.model);
}));

test("reuses the running server and waits for the reload before the next request", quietly(async () => {
  const files = tempInstall();
  const server = fakeServer();
  let finishLoad;
  const fetch = server.fetch;
  server.fetch = async (url, init) => {
    const resp = await fetch(url, init);
    if (url.endsWith("/load")) await new Promise((resolve) => (finishLoad = resolve));
    return resp;
  };
  const whisper = make(server, files);

  await whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  const second = whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.calls.requests.length, 2, "second request waits for the reload");
  finishLoad();
  assert.equal(await second, "Mana, can you hear me?");
  assert.equal(server.calls.spawn.length, 1);
  assert.deepEqual(server.calls.requests.map((r) => path.basename(r.url)), ["inference", "load", "inference", "load"]);
}));

test("restarts the server with the new thread count when a game starts or stops", quietly(async () => {
  const files = tempInstall();
  const server = fakeServer();
  let gaming = false;
  const whisper = make(server, files, {}, () => (gaming ? 2 : 8));
  const threadsOf = (i) => server.calls.spawn[i].args[server.calls.spawn[i].args.indexOf("-t") + 1];

  await whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  await whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  assert.equal(server.calls.spawn.length, 1, "same thread count: reused");
  assert.equal(threadsOf(0), "8");

  gaming = true;
  assert.equal(await whisper.transcribe(files.audio, { prompt: "", temperature: "0" }), "Mana, can you hear me?");
  assert.equal(server.calls.spawn.length, 2);
  assert.equal(threadsOf(1), "2");

  gaming = false;
  await whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  assert.equal(threadsOf(2), "8");
}));

test("restarts the server with -l auto when the language setting changes (#926)", quietly(async () => {
  const files = tempInstall();
  const server = fakeServer();
  let language = "en";
  const whisper = make(server, files, {}, () => 2, () => language);
  const languageOf = (i) => server.calls.spawn[i].args[server.calls.spawn[i].args.indexOf("-l") + 1];

  await whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  language = "auto";
  await whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  assert.equal(server.calls.spawn.length, 2);
  assert.deepEqual([languageOf(0), languageOf(1)], ["en", "auto"]);
}));

test("belowNormal lowers a spawned process's priority and tolerates one without a pid", () => {
  const { spawn } = require("node:child_process");
  const child = belowNormal(spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]));
  try {
    assert.equal(os.getPriority(child.pid), os.constants.priority.PRIORITY_BELOW_NORMAL);
  } finally {
    child.kill();
  }
  const noPid = {};
  assert.equal(belowNormal(noPid), noPid);
});

test("returns null (whisper-cli fallback) when a request fails", quietly(async () => {
  const files = tempInstall();
  for (const inference of [
    async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError("not JSON"); } }),
    async () => ({ ok: true, json: async () => ({ error: "failed to read audio" }) }),
    async () => { throw new Error("ECONNRESET"); },
  ]) {
    let failed = false;
    const server = fakeServer({
      inference: async () => (failed ? { ok: true, json: async () => ({ text: " hi\n" }) } : ((failed = true), inference())),
    });
    const whisper = make(server, files);
    assert.equal(await whisper.transcribe(files.audio, { prompt: "", temperature: "0" }), null);
    // The failed server was stopped; the next request gets a fresh one.
    assert.equal(await whisper.transcribe(files.audio, { prompt: "", temperature: "0" }), "hi");
    assert.equal(server.calls.spawn.length, 2);
  }
}));

test("returns null while another request is in flight", quietly(async () => {
  const files = tempInstall();
  let answer;
  const server = fakeServer({ inference: () => new Promise((resolve) => (answer = resolve)) });
  const whisper = make(server, files);

  const first = whisper.transcribe(files.audio, { prompt: "", temperature: "0" });
  assert.equal(await whisper.transcribe(files.audio, { prompt: "", temperature: "0" }), null);
  while (!answer) await new Promise((resolve) => setImmediate(resolve));
  answer({ ok: true, json: async () => ({ text: " hi\n" }) });
  assert.equal(await first, "hi");
}));

test("returns null without spawning when the server isn't installed, won't start, or under test", quietly(async () => {
  const missing = tempInstall({ withServer: false });
  let server = fakeServer();
  assert.equal(await make(server, missing).transcribe(missing.audio, { prompt: "", temperature: "0" }), null);
  assert.equal(server.calls.spawn.length, 0);

  const files = tempInstall();
  server = fakeServer();
  assert.equal(await make(server, files, { NODE_ENV: "test" }).transcribe(files.audio, { prompt: "", temperature: "0" }), null);
  assert.equal(server.calls.spawn.length, 0);

  // Exits right away: never healthy.
  server = fakeServer();
  server.spawn = (bin, args) => {
    server.calls.spawn.push({ bin, args });
    return { stderr: { on: () => {} }, on: (event, fn) => event === "exit" && fn(1), kill: () => {} };
  };
  assert.equal(await make(server, files).transcribe(files.audio, { prompt: "", temperature: "0" }), null);
  assert.equal(server.calls.spawn.length, 1);
  assert.equal(server.calls.requests.length, 0);
}));

test("WHISPER_SERVER_BIN and WHISPER_SERVER_PORT override the defaults", quietly(async () => {
  const files = tempInstall({ withServer: false });
  const bin = path.join(path.dirname(files.cli), "custom-server.exe");
  fs.writeFileSync(bin, "");
  const server = fakeServer();
  const whisper = make(server, files, { WHISPER_SERVER_BIN: bin, WHISPER_SERVER_PORT: "18093" });

  assert.equal(await whisper.transcribe(files.audio, { prompt: "", temperature: "0" }), "Mana, can you hear me?");
  assert.equal(server.calls.spawn[0].bin, bin);
  assert.equal(server.calls.requests[0].url, "http://127.0.0.1:18093/inference");
}));
