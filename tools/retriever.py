#!/usr/bin/env python3
"""
Simple retriever that loads the Annoy index + metadata and returns top-k matching chunks.

Usage:
  python tools/retriever.py --index "C:\\ManaAI\\Mana\\tools\\vector_store" --query "how do I start the server" --k 5
"""

import argparse
import json
from pathlib import Path

import numpy as np
from annoy import AnnoyIndex
from sentence_transformers import SentenceTransformer


def load_store(outdir):
    outdir = Path(outdir)
    config = json.load(open(outdir / "config.json", "r", encoding="utf-8"))
    dim = config["dim"]
    index = AnnoyIndex(dim, config.get("annoy_metric", "angular"))
    index.load(str(outdir / "index.ann"))
    metadata = json.load(open(outdir / "metadata.json", "r", encoding="utf-8"))
    return index, metadata, config


def retrieve(outdir, query, k=5, embedding_model="all-MiniLM-L6-v2"):
    index, metadata, config = load_store(outdir)
    model = SentenceTransformer(embedding_model)
    qvec = model.encode([query], convert_to_numpy=True)[0].astype(np.float32)
    ids, distances = index.get_nns_by_vector(qvec, k, include_distances=True)
    results = []
    for i, dist in zip(ids, distances):
        meta = metadata[i]
        results.append({"score": float(dist), "meta": meta})
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--index",
        required=True,
        help="Index directory (contains index.ann, metadata.json)",
    )
    parser.add_argument("--query", required=True, help="Query text")
    parser.add_argument("--k", type=int, default=5, help="Top k")
    parser.add_argument("--model", default="all-MiniLM-L6-v2", help="Embedding model")
    args = parser.parse_args()
    out = retrieve(args.index, args.query, args.k, args.model)
    print(json.dumps(out, indent=2, ensure_ascii=False))
