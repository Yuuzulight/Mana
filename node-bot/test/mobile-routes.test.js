const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createMobileAuth, hashPasscode } = require("../mobile-auth");
const { createApp } = require("../server");

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("createApp exposes existing health route", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
  });
});

function makeMobileDeps() {
  const auth = createMobileAuth({
    passcodeHash: hashPasscode("2468", "test-salt"),
    sessionSecret: "unit-test-secret",
    now: () => 1000,
    sessionTtlMs: 60_000,
  });
  const summaries = [];
  const memoryStore = {
    listSummaries: (filter = {}) =>
      filter.direction
        ? summaries.filter((item) => item.direction === filter.direction)
        : summaries,
    saveSummary: (summary) => {
      const saved = {
        ...summary,
        createdAt: "2026-06-27T00:00:00.000Z",
      };
      summaries.push(saved);
      return saved;
    },
  };

  return {
    mobileAuth: auth,
    mobileMemoryStore: memoryStore,
    buildAssistantReply: async (text) => `Mana heard: ${text}`,
    synthesizeReply: async () => Buffer.from("fake-wav"),
    runWhisper: () => "voice message",
    normalizeUploadedAudio: (file) => ({ tmpPath: file.path, audioPath: file.path }),
    cleanupUploadedAudio: () => {},
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
}

async function unlock(baseUrl) {
  const { response, body } = await postJson(`${baseUrl}/mobile/auth/unlock`, {
    passcode: "2468",
  });

  assert.equal(response.status, 200);
  assert.equal(typeof body.token, "string");
  return body.token;
}

test("mobile unlock returns token and health reports configured auth", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/mobile/health`);
    const healthBody = await health.json();

    assert.equal(health.status, 200);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.authConfigured, true);

    const { response, body } = await postJson(`${baseUrl}/mobile/auth/unlock`, {
      passcode: "2468",
    });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.token, "string");
    assert.equal(body.expiresAt, 61_000);
  });
});

test("mobile chat and summaries require auth", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const chat = await postJson(`${baseUrl}/mobile/chat/text`, {
      text: "hello",
    });
    assert.equal(chat.response.status, 401);

    const saveSummary = await postJson(`${baseUrl}/mobile/summaries`, {
      id: "summary-1",
      summary: "Phone summary",
    });
    assert.equal(saveSummary.response.status, 401);

    const listSummaries = await fetch(`${baseUrl}/mobile/summaries`);
    assert.equal(listSummaries.status, 401);
  });
});

test("mobile text chat replies and summary sync persists", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const token = await unlock(baseUrl);
    const headers = { Authorization: `Bearer ${token}` };

    const chat = await postJson(
      `${baseUrl}/mobile/chat/text`,
      { text: "hello" },
      headers,
    );

    assert.equal(chat.response.status, 200);
    assert.equal(chat.body.reply, "Mana heard: hello");

    const saved = await postJson(
      `${baseUrl}/mobile/summaries`,
      {
        id: "phone-1",
        chatId: "chat-1",
        title: "Phone chat",
        summary: "The phone user asked Mana for help.",
      },
      headers,
    );

    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.summary.id, "phone-1");
    assert.equal(saved.body.summary.direction, "phone-to-pc");

    const list = await fetch(`${baseUrl}/mobile/summaries`, { headers });
    const listBody = await list.json();

    assert.equal(list.status, 200);
    assert.equal(listBody.summaries.length, 1);
    assert.equal(listBody.summaries[0].summary, "The phone user asked Mana for help.");
  });
});

test("mobile synthesis requires auth and returns wav audio", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const unauthorized = await postJson(`${baseUrl}/mobile/synthesize`, {
      text: "hello",
    });
    assert.equal(unauthorized.response.status, 401);

    const token = await unlock(baseUrl);
    const response = await fetch(`${baseUrl}/mobile/synthesize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    const audio = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^audio\/wav/);
    assert.equal(audio.toString("utf8"), "fake-wav");
    assert.ok(audio.length > 0);
  });
});
