#!/usr/bin/env python3
"""
A small FastAPI retrieval microservice that loads an Annoy index and returns top-k hits.

Usage (from your Python venv):
  pip install fastapi uvicorn sentence-transformers annoy nbformat
  uvicorn tools.retriever_service:app --host 127.0.0.1 --port 9000

Endpoints:
  POST /retrieve  { query: str, k: int }
    returns JSON array [{ score: float, meta: { id, path, abs_path, start_char, end_char, preview } }, ...]

Environment variables:
  VECTOR_STORE_DIR - path to index directory (default: ../tools/vector_store relative to repo root)
  EMBEDDING_MODEL - sentence-transformers model (default: all-MiniLM-L6-v2)
"""

import json
import os
from pathlib import Path

import numpy as np
from annoy import AnnoyIndex
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

try:
    import tiktoken

    TIKTOKEN_AVAILABLE = True
except Exception:
    tiktoken = None
    TIKTOKEN_AVAILABLE = False


class RetrieveRequest(BaseModel):
    query: str
    k: int = 5
    model: str | None = None


app = FastAPI(title="Mana Vector Retriever")

# Globals loaded at startup
INDEX = None
METADATA = None
CONFIG = None
EMBED_MODEL = None
DIM = None

# Service state for readiness
STATE = {
    "index_loaded": False,
    "model_loaded": False,
    "tokenizer_type": "heuristic",
}


def load_store(index_dir: str, embedding_model: str):
    global INDEX, METADATA, CONFIG, EMBED_MODEL, DIM, STATE
    index_dir = Path(index_dir)
    if not index_dir.exists():
        raise FileNotFoundError(f"Index dir not found: {index_dir}")
    CONFIG = json.load(open(index_dir / "config.json", "r", encoding="utf-8"))
    DIM = CONFIG.get("dim")
    INDEX = AnnoyIndex(DIM, CONFIG.get("annoy_metric", "angular"))
    INDEX.load(str(index_dir / "index.ann"))
    METADATA = json.load(open(index_dir / "metadata.json", "r", encoding="utf-8"))
    # mark index loaded before loading model to reflect progress
    STATE["index_loaded"] = True
    EMBED_MODEL = SentenceTransformer(embedding_model)
    # mark model loaded
    STATE["model_loaded"] = True


@app.on_event("startup")
def startup_event():
    index_dir = os.environ.get("VECTOR_STORE_DIR")
    if not index_dir:
        # assume repository root is one level up from tools
        index_dir = Path(__file__).resolve().parent.parent / "tools" / "vector_store"
        index_dir = str(index_dir)
    embedding_model = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

    # detect tokenizer availability
    if TIKTOKEN_AVAILABLE:
        STATE["tokenizer_type"] = "tiktoken"

    try:
        load_store(index_dir, embedding_model)
        print(f"Retriever: loaded index from {index_dir} using model {embedding_model}")
    except Exception as e:
        print("Retriever startup warning: failed to load index/model:", str(e))
        # keep service running; callers can handle missing index


@app.post("/retrieve")
async def retrieve(req: RetrieveRequest):
    if INDEX is None or METADATA is None or EMBED_MODEL is None:
        raise HTTPException(
            status_code=503, detail="Retriever index or model not loaded"
        )
    if not req.query or not req.query.strip():
        raise HTTPException(status_code=400, detail="query is required")
    qvec = EMBED_MODEL.encode([req.query], convert_to_numpy=True)[0].astype(np.float32)
    ids, distances = INDEX.get_nns_by_vector(qvec, req.k or 5, include_distances=True)
    results = []
    for i, dist in zip(ids, distances):
        meta = METADATA[i]
        results.append({"score": float(dist), "meta": meta})
    return results


class TokenizeRequest(BaseModel):
    text: str
    model: str | None = None


@app.post("/tokenize")
async def tokenize(req: TokenizeRequest):
    text = req.text or ""
    if not text:
        return {"tokens": 0}

    # If tiktoken is available, use it for accurate counts
    if TIKTOKEN_AVAILABLE and tiktoken:
        try:
            # try to infer encoding from model if provided
            if req.model:
                try:
                    enc = tiktoken.encoding_for_model(req.model)
                except Exception:
                    enc = tiktoken.get_encoding("cl100k_base")
            else:
                enc = tiktoken.get_encoding("cl100k_base")
            tokens = len(enc.encode(text))
            return {"tokens": tokens}
        except Exception:
            pass

    # fallback heuristic: 1 token ~ 4 chars
    tokens = max(1, (len(text) + 3) // 4)
    return {"tokens": tokens}


@app.get("/health")
async def health():
    # Return 200 when model loaded; 503 otherwise. Include state details.
    if not STATE.get("model_loaded"):
        from fastapi import Response, status

        return Response(
            content=json.dumps(
                {
                    "status": "unhealthy",
                    "details": "Embedding model still loading",
                    **STATE,
                }
            ),
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            media_type="application/json",
        )
    return {"status": "healthy", "details": "Ready to process requests", **STATE}


if __name__ == "__main__":
    import uvicorn

    # Run the FastAPI app directly to avoid module import path issues on Windows
    uvicorn.run(app, host="127.0.0.1", port=9000, log_level="info")
