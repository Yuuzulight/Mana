const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { MAX_TEXT_CHARS, createMatrixBridge, createMatrixClient, syncOnce } = require("../matrix-bridge");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-matrix-"));
}

// --- createMatrixBridge / pairing gate (mirrors telegram-bridge.test.js) ---

test("an unapproved room's message gets back a pairing code, not a real reply", async () => {
  const bridge = createMatrixBridge({ dataDir: createTempDir() });
  const reply = await bridge.handleIncomingMessage({ roomId: "!abc:example.org", text: "hi", senderName: "@alice:example.org" });

  assert.match(reply, /^This chat isn't paired with Mana yet\..*: [A-Z0-9]{6}$/);
  assert.equal(bridge.isApproved("!abc:example.org"), false);
  assert.equal(bridge.listPending().length, 1);
  assert.equal(bridge.listPending()[0].name, "@alice:example.org");
});

test("the same unapproved room reuses its existing pairing code across messages", async () => {
  const bridge = createMatrixBridge({ dataDir: createTempDir() });
  const first = await bridge.handleIncomingMessage({ roomId: "!room2:example.org", text: "one" });
  const second = await bridge.handleIncomingMessage({ roomId: "!room2:example.org", text: "two" });
  assert.equal(first, second);
});

test("approvePairing moves a room from pending to approved and returns its roomId", async () => {
  const bridge = createMatrixBridge({ dataDir: createTempDir() });
  const reply = await bridge.handleIncomingMessage({ roomId: "!room3:example.org", text: "hi" });
  const code = reply.match(/: (\w{6})$/)[1];

  const roomId = bridge.approvePairing(code);
  assert.equal(roomId, "!room3:example.org");
  assert.equal(bridge.isApproved("!room3:example.org"), true);
  assert.equal(bridge.listPending().length, 0);
  assert.equal(bridge.listApproved().length, 1);
});

test("approvePairing returns null for an unknown code", () => {
  const bridge = createMatrixBridge({ dataDir: createTempDir() });
  assert.equal(bridge.approvePairing("NOPE12"), null);
});

test("an approved room's message routes through replyFn with a per-room sessionId", async () => {
  let received = null;
  const bridge = createMatrixBridge({
    dataDir: createTempDir(),
    replyFn: async (text, options) => {
      received = { text, options };
      return "a real reply";
    },
  });
  const code = (await bridge.handleIncomingMessage({ roomId: "!room4:example.org", text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const reply = await bridge.handleIncomingMessage({ roomId: "!room4:example.org", text: "what's the weather" });
  assert.equal(reply, "a real reply");
  assert.equal(received.text, "what's the weather");
  assert.equal(received.options.sessionId, "matrix-!room4:example.org");
});

test("handleIncomingMessage truncates to MAX_TEXT_CHARS and requires a roomId", async () => {
  const bridge = createMatrixBridge({
    dataDir: createTempDir(),
    replyFn: async (text) => text,
  });
  const code = (await bridge.handleIncomingMessage({ roomId: "!room5:example.org", text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const longText = "x".repeat(MAX_TEXT_CHARS + 500);
  const reply = await bridge.handleIncomingMessage({ roomId: "!room5:example.org", text: longText });
  assert.equal(reply.length, MAX_TEXT_CHARS);

  await assert.rejects(() => bridge.handleIncomingMessage({ text: "hi" }), /roomId is required/);
});

// --- createMatrixClient (mocked fetch, same convention as
// job-search-adzuna/adzuna-client.test.js and image-generation.test.js) ---

test("createMatrixClient requires a homeserver URL and an access token", () => {
  assert.throws(() => createMatrixClient({ accessToken: "tok" }), /homeserver URL is required/);
  assert.throws(() => createMatrixClient({ homeserverUrl: "https://example.org" }), /access token is required/);
});

test("sync sends a bearer token, a 30s timeout, and the since token when present", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ next_batch: "s1", rooms: {} }) };
  };
  const client = createMatrixClient({ homeserverUrl: "https://example.org/", accessToken: "secret-tok", fetchImpl });

  await client.sync();
  assert.match(requests[0].url, /^https:\/\/example\.org\/_matrix\/client\/v3\/sync\?timeout=30000$/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret-tok");

  await client.sync("s1");
  assert.match(requests[1].url, /since=s1/);
});

test("sync surfaces a non-ok response as an error without leaking the access token", async () => {
  const client = createMatrixClient({
    homeserverUrl: "https://example.org",
    accessToken: "secret-tok",
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(() => client.sync(), (err) => {
    assert.match(err.message, /sync failed: 401/);
    assert.doesNotMatch(err.message, /secret-tok/);
    return true;
  });
});

test("sync on a 429 carries retryAfterMs read from the Matrix-spec retry_after_ms body field", async () => {
  const client = createMatrixClient({
    homeserverUrl: "https://example.org",
    accessToken: "secret-tok",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      clone() {
        return this;
      },
      json: async () => ({ errcode: "M_LIMIT_EXCEEDED", error: "Too Many Requests", retry_after_ms: 2500 }),
    }),
  });
  await assert.rejects(() => client.sync(), (err) => {
    assert.match(err.message, /sync failed: 429/);
    assert.equal(err.retryAfterMs, 2500);
    return true;
  });
});

test("sync on a 429 falls back to the Retry-After header (seconds) when there's no retry_after_ms body", async () => {
  const client = createMatrixClient({
    homeserverUrl: "https://example.org",
    accessToken: "secret-tok",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === "retry-after" ? "3" : null) },
      json: async () => {
        throw new Error("no body");
      },
    }),
  });
  await assert.rejects(() => client.sync(), (err) => {
    assert.equal(err.retryAfterMs, 3000);
    return true;
  });
});

test("sync on a 429 with neither a usable body nor a Retry-After header leaves retryAfterMs unset", async () => {
  const client = createMatrixClient({
    homeserverUrl: "https://example.org",
    accessToken: "secret-tok",
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  await assert.rejects(() => client.sync(), (err) => {
    assert.equal(err.retryAfterMs, null);
    return true;
  });
});

test("a non-429 error never sets retryAfterMs, even without .clone()/.headers", async () => {
  const client = createMatrixClient({
    homeserverUrl: "https://example.org",
    accessToken: "secret-tok",
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => client.sync(), (err) => {
    assert.equal(err.retryAfterMs, undefined);
    return true;
  });
});

test("joinRoom POSTs to the encoded room path", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({}) };
  };
  const client = createMatrixClient({ homeserverUrl: "https://example.org", accessToken: "tok", fetchImpl });

  await client.joinRoom("!weird/id:example.org");
  assert.equal(requests[0].url, "https://example.org/_matrix/client/v3/rooms/!weird%2Fid%3Aexample.org/join");
  assert.equal(requests[0].options.method, "POST");
});

test("sendMessage PUTs an m.text event with a unique txnId per call", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({}) };
  };
  const client = createMatrixClient({ homeserverUrl: "https://example.org", accessToken: "tok", fetchImpl });

  await client.sendMessage("!room:example.org", "hello");
  await client.sendMessage("!room:example.org", "hello again");

  assert.equal(requests.length, 2);
  for (const req of requests) {
    assert.equal(req.options.method, "PUT");
    assert.match(req.url, /^https:\/\/example\.org\/_matrix\/client\/v3\/rooms\/!room%3Aexample\.org\/send\/m\.room\.message\//);
  }
  const txnId1 = requests[0].url.split("/").pop();
  const txnId2 = requests[1].url.split("/").pop();
  assert.notEqual(txnId1, txnId2);
  assert.deepEqual(JSON.parse(requests[0].options.body), { msgtype: "m.text", body: "hello" });
});

// --- syncOnce ---

function fakeClient({ syncResponses, joinRoom, sendMessage }) {
  let call = 0;
  return {
    async sync() {
      const response = syncResponses[Math.min(call, syncResponses.length - 1)];
      call += 1;
      return response;
    },
    joinRoom: joinRoom || (async () => {}),
    sendMessage: sendMessage || (async () => {}),
  };
}

test("syncOnce auto-joins a room seen in rooms.invite", async () => {
  const joined = [];
  const client = fakeClient({
    syncResponses: [{ next_batch: "s1", rooms: { invite: { "!newroom:example.org": {} } } }],
    joinRoom: async (roomId) => joined.push(roomId),
  });
  const bridge = createMatrixBridge({ dataDir: createTempDir() });

  await syncOnce({ client, bridge, botUserId: "@mana:example.org" });
  assert.deepEqual(joined, ["!newroom:example.org"]);
});

test("syncOnce filters out the bot's own messages", async () => {
  const client = fakeClient({
    syncResponses: [
      {
        next_batch: "s1",
        rooms: {
          join: {
            "!room:example.org": {
              timeline: {
                events: [
                  { type: "m.room.message", sender: "@mana:example.org", content: { msgtype: "m.text", body: "my own reply" } },
                ],
              },
            },
          },
        },
      },
    ],
  });
  const bridge = createMatrixBridge({ dataDir: createTempDir() });

  // If the bot's own message were routed, it would go through the pairing
  // gate and create a pending entry -- assert that didn't happen.
  await syncOnce({ client, bridge, botUserId: "@mana:example.org" });
  assert.equal(bridge.listPending().length, 0);
});

test("syncOnce skips m.room.encrypted events without crashing", async () => {
  const sent = [];
  const client = fakeClient({
    syncResponses: [
      {
        next_batch: "s1",
        rooms: {
          join: {
            "!room:example.org": {
              timeline: {
                events: [{ type: "m.room.encrypted", sender: "@alice:example.org", content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque" } }],
              },
            },
          },
        },
      },
    ],
    sendMessage: async (roomId, text) => sent.push({ roomId, text }),
  });
  const bridge = createMatrixBridge({ dataDir: createTempDir() });

  const nextSince = await syncOnce({ client, bridge, botUserId: "@mana:example.org" });
  assert.equal(nextSince, "s1");
  assert.equal(sent.length, 0);
  assert.equal(bridge.listPending().length, 0);
});

test("syncOnce routes an approved room's message to replyFn and sends the reply back", async () => {
  const sent = [];
  const client = fakeClient({
    syncResponses: [
      {
        next_batch: "s2",
        rooms: {
          join: {
            "!room:example.org": {
              timeline: {
                events: [{ type: "m.room.message", sender: "@alice:example.org", content: { msgtype: "m.text", body: "what's the weather" } }],
              },
            },
          },
        },
      },
    ],
    sendMessage: async (roomId, text) => sent.push({ roomId, text }),
  });
  const bridge = createMatrixBridge({
    dataDir: createTempDir(),
    replyFn: async () => "pong",
  });
  // Pre-approve the room so syncOnce exercises the real reply path.
  const code = (await bridge.handleIncomingMessage({ roomId: "!room:example.org", text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  await syncOnce({ client, bridge, botUserId: "@mana:example.org" });
  assert.deepEqual(sent, [{ roomId: "!room:example.org", text: "pong" }]);
});

test("syncOnce sends a pairing-code prompt (not a real reply) for an unapproved room", async () => {
  const sent = [];
  const client = fakeClient({
    syncResponses: [
      {
        next_batch: "s1",
        rooms: {
          join: {
            "!room:example.org": {
              timeline: {
                events: [{ type: "m.room.message", sender: "@alice:example.org", content: { msgtype: "m.text", body: "hi" } }],
              },
            },
          },
        },
      },
    ],
    sendMessage: async (roomId, text) => sent.push({ roomId, text }),
  });
  const bridge = createMatrixBridge({ dataDir: createTempDir() });

  await syncOnce({ client, bridge, botUserId: "@mana:example.org" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /This chat isn't paired with Mana yet/);
});

test("syncOnce does not crash on a malformed message event missing content.body", async () => {
  const client = fakeClient({
    syncResponses: [
      {
        next_batch: "s1",
        rooms: {
          join: {
            "!room:example.org": {
              timeline: {
                events: [{ type: "m.room.message", sender: "@alice:example.org", content: { msgtype: "m.text" } }],
              },
            },
          },
        },
      },
    ],
  });
  const bridge = createMatrixBridge({ dataDir: createTempDir() });
  const nextSince = await syncOnce({ client, bridge, botUserId: "@mana:example.org" });
  assert.equal(nextSince, "s1");
});

// #435 review: without a per-event try/catch, one event throwing would abort
// the whole batch before next_batch is returned -- the next sync would
// re-fetch and re-process the entire batch, including events already
// replied to, sending duplicate replies for those.
test("syncOnce continues to the next event in the batch when one event's send fails, and still advances since", async () => {
  const sent = [];
  const client = fakeClient({
    syncResponses: [
      {
        next_batch: "s1",
        rooms: {
          join: {
            "!room:example.org": {
              timeline: {
                events: [
                  { type: "m.room.message", sender: "@alice:example.org", content: { msgtype: "m.text", body: "first" } },
                  { type: "m.room.message", sender: "@alice:example.org", content: { msgtype: "m.text", body: "second" } },
                ],
              },
            },
          },
        },
      },
    ],
    sendMessage: async (roomId, text) => {
      if (text === "reply-to-first") throw new Error("homeserver 500");
      sent.push({ roomId, text });
    },
  });
  const bridge = createMatrixBridge({
    dataDir: createTempDir(),
    replyFn: async (text) => `reply-to-${text}`,
  });
  const code = (await bridge.handleIncomingMessage({ roomId: "!room:example.org", text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const nextSince = await syncOnce({ client, bridge, botUserId: "@mana:example.org" });

  assert.equal(nextSince, "s1", "the batch must be considered fully processed despite the first event's failure");
  assert.deepEqual(sent, [{ roomId: "!room:example.org", text: "reply-to-second" }]);
});

test("syncOnce's since token advances across calls and is passed to the next sync", async () => {
  const seenSince = [];
  const client = {
    async sync(since) {
      seenSince.push(since);
      if (seenSince.length === 1) return { next_batch: "batch-1", rooms: {} };
      return { next_batch: "batch-2", rooms: {} };
    },
    joinRoom: async () => {},
    sendMessage: async () => {},
  };
  const bridge = createMatrixBridge({ dataDir: createTempDir() });

  const first = await syncOnce({ client, bridge, botUserId: "@mana:example.org", since: undefined });
  assert.equal(first, "batch-1");
  const second = await syncOnce({ client, bridge, botUserId: "@mana:example.org", since: first });
  assert.equal(second, "batch-2");
  assert.deepEqual(seenSince, [undefined, "batch-1"]);
});

test("syncOnce handles the very first sync (no since token, empty rooms) without error", async () => {
  const client = fakeClient({ syncResponses: [{ next_batch: "s0", rooms: {} }] });
  const bridge = createMatrixBridge({ dataDir: createTempDir() });
  const nextSince = await syncOnce({ client, bridge, botUserId: "@mana:example.org", since: undefined });
  assert.equal(nextSince, "s0");
});
