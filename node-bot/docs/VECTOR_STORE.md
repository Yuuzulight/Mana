Vector Store — Local Semantic Retrieval (Mana)

Overview

Mana supports a local, pluggable vector store adapter for semantic search. The adapter attempts to use a native FAISS binding when available (USE_FAISS=1) and falls back to a safe JavaScript JSON store when native FAISS is not installed.

Default location

- Environment variable: VECTOR_STORE_DIR
- Default path: node-bot/tools/vector_store (relative to repo root)

What you'll find in the vector store directory

- meta.json / vector_store_meta.json — (added by build) small metadata file with fields such as lastBuilt, added, count.
- meta.json / vectors.json / meta.json (adapter-specific) — the JS fallback stores `vectors.json` and `meta.json`. If FAISS is used, the binding may write its own files; adapter still writes vectors/meta copies for inspection.
- vector_store.json (fallback adapter) — full array of stored items ({ id, vector, meta }). Large stores will be large JSON files — use FAISS for scale.

Server endpoints (admin)

- POST /admin/retriever/vector/rebuild
  - Triggers building the vector store from the current retriever index file (data/retriever_index.json). Responds with { ok, added, count }.
  - Requires admin Bearer token when MANA_ADMIN_SECRET is set.

- GET /admin/retriever/vector/status
  - Returns { ok, available, count, lastBuilt } when available; false/0 when not.
  - Uses the adapter to load the store and count entries.

- GET /admin/retriever/search?q=...&k=...
  - Admin search will prefer the populated vector store when present. Falls back to embedding-based or TF fallback search.

Admin UI

- The admin UI (node-bot/admin/background_memory_ui.html) has buttons to build the vector store and query its status. Use the admin secret field to provide the Bearer token when the server enforces it.

FAISS: enablement and notes

- To enable native FAISS usage, set environment variable USE_FAISS=1 before starting the server. The adapter will attempt to require a FAISS binding (commonly `faiss` or `faiss-node`). If the binding is not present it will fall back to the JS store.

- Platform/installation (brief):
  - Windows: FAISS bindings for Node are platform-specific and may require building from source or using prebuilt binaries. Check the binding's README (e.g. `faiss-node`) or use a Python-based FAISS service if needed.
  - Linux/macOS: use the binding recommended by your runtime. Installing FAISS and node bindings may be non-trivial; rely on the JSON fallback if you can't install a binding.

- If using FAISS, the adapter currently builds an in-memory index and writes `meta.json` + `vectors.json` for persistence. For production, consider building an IVF/PQ or other quantized index variant and tune parameters for speed and memory.

Inspecting and cleaning the store

- Quick inspection (JSON fallback):
  - Open node-bot/tools/vector_store/vector_store.json or vectors.json to view stored IDs and small sample vectors.
  - Open node-bot/tools/vector_store/meta.json or vector_store_meta.json for lastBuilt timestamp and counts.

- Clean / remove store (manual):
  1. Stop the Mana server.
  2. Remove or move the VECTOR_STORE_DIR (e.g. `rm -rf node-bot/tools/vector_store/*` on Unix or delete in Explorer on Windows).
  3. Restart the server and rebuild the vector store via POST /admin/retriever/vector/rebuild.

- Rebuild (safe):
  - Use the admin endpoint `POST /admin/retriever/vector/rebuild` to rebuild from the retriever index. This is the recommended path.

Performance & operational tips

- The JSON fallback is simple and convenient for development, but it does not scale to large corpora. For production usage (tens of thousands+ vectors), install a FAISS binding or use an external ANN service (FAISS, Chroma, Milvus, etc.).

- Embeddings must exist in `data/retriever_index.json` entries for the vector store to be populated. Use the embedding worker (`/admin/retriever/embeddings/rebuild`) to enqueue entries that need embeddings.

- The build endpoint writes a small metadata file (`vector_store_meta.json`) with `lastBuilt`, `added`, `count`. The admin UI reads this to show freshness.

- On Windows, long-running vector builds can be slow if the store is large; consider building off-line or on a dedicated machine.

Security

- The admin endpoints require the admin Bearer token when MANA_ADMIN_SECRET is set. Protect the vector store directory and any model binaries.

Troubleshooting

- "No vector store available" — ensure you have run a retriever index build (`POST /admin/retriever/rebuild`) and embeddings exist. Run `POST /admin/retriever/embeddings/rebuild` and wait for the worker to finish.

- "FAISS module not found" — either install a compatible FAISS binding (platform-specific) and set USE_FAISS=1, or leave USE_FAISS unset to use the JSON fallback.

- Corruption or partial builds — delete the vector store directory and rebuild.

Contact / notes

If you want, I can add:
- Streaming progress for vector rebuilds (NDJSON or websocket notifications).
- A small CLI script to inspect top-k nearest neighbors locally using the store files.
- Platform-specific FAISS install instructions for Windows and Ubuntu.

