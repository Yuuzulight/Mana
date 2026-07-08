Summary
- Integrates a lightweight local retriever index into the assistant prompt-building path so repository snippets are retrieved quickly.
- Adds admin endpoints:
  - POST /admin/retriever/rebuild — build/rebuild the local index
  - GET /admin/retriever/search?q=...&k=... — search index
- Adds a unit test that mocks the index: node-bot/test/retriever-admin.test.js
- Hardened the Python token-count helper:
  - Added a JS fallback and short-circuited Python worker spawning during tests to avoid flaky child-process behavior.
  - Added a test-run helper to run individual test files.
- Tests: full node-bot test suite passed locally (36 / 36) under NODE_ENV=test.
- Files changed (high level): node-bot/server.js, node-bot/tools/retriever-index.js, node-bot/test/retriever-admin.test.js, node-bot/tools/python_token_cache.async.js, plus supporting test scripts.

Next recommended steps:
1. Consider a periodic index builder or a file-watcher that incrementally updates node-bot/data/retriever_index.json.
2. Optionally replace term-frequency scoring with embedding-based similarity and persist vectors in the index (longer task).
3. Add an admin UI button to trigger the retriever rebuild (endpoints are present).

Local test log: node-bot/full_test_output.log

This PR is a draft intended for review and iteration.