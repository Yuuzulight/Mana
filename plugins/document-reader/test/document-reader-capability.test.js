const assert = require("node:assert/strict");
// This plugin always runs hosted inside node-bot's Express app in
// production (it never requires express itself -- node-bot hands it an
// already-built `app`); reaching back for express here only for the test's
// own throwaway app avoids vendoring a second copy of it just for tests.
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const documentReaderPlugin = require("../index");
const { withServer } = require("./helpers");

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test("POST /documents/ingest/url rejects when fetchPage isn't wired in", async () => {
  const app = express();
  app.use(express.json());
  documentReaderPlugin.registerRoutes(app, {});

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/documents/ingest/url`, {
      url: "https://example.com",
    });
    assert.equal(response.status, 400);
    assert.match(payload.error, /fetchPage dependency is required/);
  });
});

test("POST /documents/ingest/url ingests via the injected fetchPage, then GET/DELETE /documents manage it", async () => {
  const app = express();
  app.use(express.json());
  const fakeFetchPage = async (url) => ({
    url,
    title: "Route Test Page",
    text: "Content fetched through the route-level fetchPage dependency.",
    truncated: false,
  });
  documentReaderPlugin.registerRoutes(app, { fetchPage: fakeFetchPage });

  await withServer(app, async (baseUrl) => {
    const ingest = await postJson(`${baseUrl}/documents/ingest/url`, {
      url: "https://example.com/page",
    });
    assert.equal(ingest.response.status, 200);
    assert.equal(ingest.payload.sourceType, "url");
    const id = ingest.payload.id;

    const listResponse = await fetch(`${baseUrl}/documents`);
    const listPayload = await listResponse.json();
    assert.ok(listPayload.documents.some((d) => d.id === id));

    const deleteResponse = await fetch(`${baseUrl}/documents/${id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);

    const listAfterResponse = await fetch(`${baseUrl}/documents`);
    const listAfterPayload = await listAfterResponse.json();
    assert.ok(!listAfterPayload.documents.some((d) => d.id === id));
  });
});

test("POST /documents/ingest/pdf fails closed when approval is unavailable", async () => {
  const app = express();
  app.use(express.json());
  documentReaderPlugin.registerRoutes(app, {});

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/documents/ingest/pdf`, {
      filePath: "C:\\not\\a\\real.pdf",
    });
    assert.equal(response.status, 400);
    assert.match(payload.error, /Document approval is unavailable/);
  });
});

test('file-reading routes return pending without invoking extraction', async () => {
  const app = express();
  app.use(express.json());
  const purposes = [];
  documentReaderPlugin.registerRoutes(app, {
    documentAccess: { authorize: async (_file, options) => {
      purposes.push(options.purpose);
      return { status: 'pending', requestId: 'approval-id' };
    } },
  });
  await withServer(app, async baseUrl => {
    for (const route of ['/documents/extract', '/documents/ingest/file', '/documents/ingest/pdf']) {
      const result = await postJson(`${baseUrl}${route}`, { filePath: 'missing.txt' });
      assert.equal(result.response.status, 202);
      assert.equal(result.payload.requestId, 'approval-id');
    }
  });
  assert.deepEqual(purposes, ['extract', 'ingest', 'ingest-pdf']);
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(documentReaderPlugin.key, "documentReader");
  assert.equal(documentReaderPlugin.category, "Knowledge");
  assert.equal(typeof documentReaderPlugin.registerRoutes, "function");
  const health = documentReaderPlugin.getHealth();
  assert.equal(health.status, "configured");
});
