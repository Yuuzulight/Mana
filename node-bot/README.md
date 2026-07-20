Node bot (Mana) — local backend

Local-first Express backend for Mana: transcription, chat replies, TTS
calls, screen OCR, mobile routes, and setup checks. Listens on
`http://localhost:5005` by default. See the root [README.md](../README.md)
for the full endpoint list, model stack, and Doctor checks — this file
covers the backend package itself: what's in it, how to run it, and how
to test it.

## Layout

- `server.js` / `server-routes.js` — Express app setup and the core
  chat/transcription/vision routes.
- `capabilities/` — self-contained feature modules (sessions, presets,
  deep research, background memory, retriever admin, web access, dir
  scanner) registered through `capabilities/registry.js`. See
  `capabilities/registry.js` for the registration/health/prompt-context
  hooks a capability can implement.
- `../plugins/` — optional plugins (FFXIV market/crafting, real-world
  stock market data) that follow the same shape as a capability but live
  outside `node-bot/` so they're independently testable packages; see
  [plugins/README.md](../plugins/README.md).
- `ai/` — local model runtime: the persistent `llama-server` runtime,
  the one-shot `llama-cli` fallback, and model-profile selection.
- `tools/` — Whisper/llama discovery helpers, the retriever/embedding
  index, deep research, and web access.
- `test/` — `node:test` files, one roughly per module; run individually
  or via `npm test`.
- `mcp-server.js` — exposes FFXIV market and web-access tools over MCP
  for local MCP clients (`npm run mcp`).
- `doctor.js` — local setup/readiness checks (`npm run doctor`).

## Run

```powershell
npm install
npm start
```

## Test

```powershell
npm test
```

Runs `run_tests.js`, which sets `NODE_ENV=test` (so `llama-server` and
other real processes never spawn from a test run) and executes
`test/*.test.js`. Plugins under `../plugins/*/test/` have their own
`npm test` and aren't included in this run — see
[plugins/README.md](../plugins/README.md).

For a large machine already running other heavy applications, prefer
running one test file at a time (`node --test test/<file>.test.js`)
rather than the full batch, so memory is released between files instead
of held for the whole run.

Local Embedding Service (optional, local-only)

To enable fully-local semantic retrieval without external APIs, run a small local embedding service and enable embeddings in Mana.

1) Install Python dependencies (recommended in a venv):

pip install sentence-transformers fastapi uvicorn

Note: If you have a GPU and torch with CUDA, sentence-transformers will use it automatically for faster embeddings.

2) Start the local embedder:

# optional: set a secret for admin safety
export RETRIEVER_EMBEDDER_SECRET=mysecret
# start service (default port 9001)
python node-bot/tools/local_embedder.py --port 9001 --model all-MiniLM-L6-v2 --http-secret $RETRIEVER_EMBEDDER_SECRET

On Windows PowerShell use:
$env:RETRIEVER_EMBEDDER_SECRET="mysecret"
python node-bot\tools\local_embedder.py --port 9001 --model all-MiniLM-L6-v2 --http-secret $env:RETRIEVER_EMBEDDER_SECRET

3) Enable embeddings in Mana (Node):

# set to true to enable embeddings; the retriever will prefer the local embedder at RETRIEVER_EMBEDDER_URL
export USE_EMBEDDINGS=1
export RETRIEVER_EMBEDDER_URL=http://127.0.0.1:9001
export RETRIEVER_EMBEDDER_SECRET=mysecret

4) Trigger embeddings build:

# call admin endpoint (use MANA_ADMIN_SECRET if configured)
curl -X POST -H "Authorization: Bearer $MANA_ADMIN_SECRET" http://127.0.0.1:5005/admin/retriever/embeddings/rebuild

Check status:
curl -H "Authorization: Bearer $MANA_ADMIN_SECRET" http://127.0.0.1:5005/admin/retriever/embeddings/status

5) Notes
- Embeddings are stored inside `node-bot/data/retriever_index.json` under each entry.embedding.
- For large repositories, consider a vector DB (FAISS/Chroma) to store vectors efficiently.
- Tests run with NODE_ENV=test and will not attempt to use the embedder; this keeps CI deterministic.

