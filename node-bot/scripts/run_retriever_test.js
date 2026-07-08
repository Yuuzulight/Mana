const http = require('node:http');
const fetch = global.fetch || require('node-fetch');
const { createApp } = require('../server');

function injectMockRetriever(mock) {
  const p = require.resolve('../tools/retriever-index');
  const mod = { id: p, filename: p, exports: mock };
  require.cache[p] = mod;
}

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

(async () => {
  try {
    const mock = {
      loadIndexSync: () => ({ entries: [1] }),
      buildIndex: async (opts) => ({ builtAt: new Date().toISOString(), entries: [{ id: 'x', path: 'p' }] }),
      search: async (q, k) => [{ id: 'id1', path: 'p1', score: 3, snippet: 'SAMPLE SNIPPET' }],
    };
    injectMockRetriever(mock);

    const app = createApp();

    await withServer(app, async (baseUrl) => {
      console.log('server started at', baseUrl);
      const searchResp = await fetch(`${baseUrl}/admin/retriever/search?q=test&k=3`);
      console.log('search status', searchResp.status);
      const searchBody = await searchResp.json();
      console.log('search body', searchBody);

      const resp = await fetch(`${baseUrl}/admin/retriever/rebuild`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({}) });
      console.log('rebuild status', resp.status);
      const rebuildBody = await resp.json();
      console.log('rebuild body', rebuildBody);
    });
  } catch (e) {
    console.error('error in test script', e);
    process.exitCode = 2;
  }
})();
