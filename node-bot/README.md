Node bot (Mana) — local backend

[... existing README content ...]

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

