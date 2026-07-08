const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// createApp from server
const { createApp } = require('../server');

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Helper to POST JSON
async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await resp.json().catch(() => ({}));
  return { response: resp, payload };
}

// Insert a mock retriever-index into require cache so server routes use it
function injectMockRetriever(mock) {
  const p = require.resolve('../tools/retriever-index');
  const mod = { id: p, filename: p, exports: mock };
  require.cache[p] = mod;
}

test('admin retriever endpoints call retriever-index', async () => {
  // mock implementation
  const mock = {
    loadIndexSync: () => ({ entries: [1] }),
    buildIndex: async (opts) => ({ builtAt: new Date().toISOString(), entries: [{ id: 'x', path: 'p' }] }),
    search: async (q, k) => [{ id: 'id1', path: 'p1', score: 3, snippet: 'SAMPLE SNIPPET' }],
  };
  injectMockRetriever(mock);

  const app = createApp();

  await withServer(app, async (baseUrl) => {
    // search endpoint
    const searchResp = await fetch(`${baseUrl}/admin/retriever/search?q=test&k=3`);
    assert.equal(searchResp.status, 200);
    const searchBody = await searchResp.json();
    assert.equal(searchBody.ok, true);
    assert.ok(Array.isArray(searchBody.results));
    assert.equal(searchBody.results.length, 1);
    assert.equal(searchBody.results[0].snippet, 'SAMPLE SNIPPET');

    // rebuild endpoint
    const { response, payload } = await postJson(`${baseUrl}/admin/retriever/rebuild`, {});
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.count, 'number');
    assert.ok(payload.count >= 0);
  });
});
