#!/usr/bin/env python3
"""
Lightweight local embedding service for Mana

Usage:
  python local_embedder.py --port 9001 --model all-MiniLM-L6-v2 --http-secret SECRET

Endpoints:
  GET /health -> { ok: true, model: ..., device: ... }
  POST /embed -> JSON { inputs: [str, ...] } -> { ok: true, embeddings: [[float]] }

This uses sentence-transformers under the hood (all-MiniLM-L6-v2 by default).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List

try:
    import uvicorn
    from fastapi import FastAPI, HTTPException, Request
    from pydantic import BaseModel
    from sentence_transformers import SentenceTransformer
except Exception as e:
    print(
        "Missing dependencies: please pip install fastapi uvicorn sentence-transformers",
        file=sys.stderr,
    )
    raise

app = FastAPI()
model = None
MODEL_NAME = None
DEVICE = "cpu"
HTTP_SECRET = None


class EmbedRequest(BaseModel):
    inputs: List[str]


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    global HTTP_SECRET
    if HTTP_SECRET:
        auth = request.headers.get("authorization") or request.headers.get(
            "Authorization"
        )
        if not auth or not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="unauthorized")
        token = auth[len("Bearer ") :].strip()
        if token != HTTP_SECRET:
            raise HTTPException(status_code=401, detail="unauthorized")
    return await call_next(request)


@app.get("/health")
async def health():
    return {"ok": True, "model": MODEL_NAME, "device": DEVICE}


@app.post("/embed")
async def embed(req: EmbedRequest):
    global model
    texts = req.inputs or []
    if not isinstance(texts, list) or not texts:
        raise HTTPException(status_code=400, detail="inputs required")
    try:
        vecs = model.encode(texts, show_progress_bar=False)
        # Ensure JSON serializable floats
        out = [list(map(float, v)) for v in vecs]
        return {"ok": True, "embeddings": out}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def load_model(name: str, device: str):
    print(f"Loading embedding model {name} on device={device}")
    return SentenceTransformer(name)


def main():
    global model, MODEL_NAME, DEVICE, HTTP_SECRET
    p = argparse.ArgumentParser()
    p.add_argument(
        "--port", type=int, default=int(os.environ.get("RETRIEVER_EMBEDDER_PORT", 9001))
    )
    p.add_argument(
        "--model",
        type=str,
        default=os.environ.get("RETRIEVER_EMBEDDER_MODEL", "all-MiniLM-L6-v2"),
    )
    p.add_argument(
        "--device", type=str, default=os.environ.get("RETRIEVER_EMBEDDER_DEVICE", "cpu")
    )
    p.add_argument(
        "--http-secret",
        type=str,
        default=os.environ.get("RETRIEVER_EMBEDDER_SECRET", ""),
    )
    args = p.parse_args()

    MODEL_NAME = args.model
    DEVICE = args.device
    HTTP_SECRET = args.http_secret if args.http_secret else None

    try:
        model = load_model(MODEL_NAME, DEVICE)
    except Exception as e:
        print("Failed to load model:", e, file=sys.stderr)
        sys.exit(2)

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
