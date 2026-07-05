#!/usr/bin/env python3
"""
Ingest a codebase into an embedding + ANN index (Annoy).

Usage:
  python tools/ingest_codebase.py \
    --root "C:\\ManaAI\\Mana" \
    --out "C:\\ManaAI\\Mana\\tools\\vector_store" \
    --chunk-size 1500 \
    --chunk-overlap 200

This file writes:
  - <out>/index.ann
  - <out>/metadata.json
  - <out>/config.json
"""

import argparse
import json
import os
from pathlib import Path

import nbformat
import numpy as np
from annoy import AnnoyIndex
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

DEFAULT_EXTS = {
    ".py",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".java",
    ".c",
    ".cpp",
    ".cs",
    ".json",
    ".md",
    ".txt",
    ".html",
    ".css",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".sh",
    ".ps1",
    ".rs",
    ".go",
    ".php",
    ".sql",
}

# Default globs to always ignore: virtualenvs, node_modules, git, large tool/model folders
DEFAULT_IGNORE_GLOBS = [
    "**/.venv/**",
    "**/venv/**",
    "**/env/**",
    "**/node_modules/**",
    "**/.git/**",
    "**/__pycache__/**",
    "**/dist/**",
    "**/build/**",
    "**/*.egg-info/**",
    "**/tools/**/models/**",
    "**/tools/**/.venv/**",
    "**/tools/**/venv/**",
    "**/tools/**/node_modules/**",
]


def load_ignore_globs():
    """Load comma-separated ignore glob patterns from environment variable
    MANA_INDEX_IGNORE_GLOBS. If not set, return DEFAULT_IGNORE_GLOBS.
    """
    env_globs = os.environ.get("MANA_INDEX_IGNORE_GLOBS")
    if env_globs:
        # Split on commas and strip whitespace
        return [p.strip() for p in env_globs.split(",") if p.strip()]
    return DEFAULT_IGNORE_GLOBS


def is_ignored(path: Path, ignore_globs):
    for g in ignore_globs:
        if path.match(g):
            return True
    return False


def iter_files(root: Path, exts, ignore_globs):
    for p in root.rglob("*"):
        try:
            # Skip paths that raise on stat (permissions, broken symlinks, inaccessible mounts)
            if not p.exists():
                continue
            if p.is_file():
                if is_ignored(p, ignore_globs):
                    continue
                if p.suffix.lower() in exts:
                    yield p
                # treat ipynb specially
                if p.suffix.lower() == ".ipynb":
                    yield p
        except (OSError, PermissionError) as e:
            # log and continue
            print(f"Warning: cannot access {p}: {e}")
            continue


def read_file_text(p: Path):
    try:
        if p.suffix.lower() == ".ipynb":
            nb = nbformat.read(str(p), as_version=4)
            cells = []
            for cell in nb.cells:
                if cell.cell_type in ("code", "markdown"):
                    cells.append(cell.source)
            return "\n\n".join(cells)
        else:
            try:
                return p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                return p.read_text(encoding="latin-1")
    except Exception as e:
        print(f"Failed to read {p}: {e}")
        return ""


def chunk_text(text: str, chunk_size: int, overlap: int):
    if not text:
        return []
    text_len = len(text)
    start = 0
    chunks = []
    while start < text_len:
        end = start + chunk_size
        chunk = text[start:end]
        chunks.append((start, min(end, text_len), chunk))
        if end >= text_len:
            break
        start = max(0, end - overlap)
    return chunks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, help="Project root to index")
    parser.add_argument(
        "--out", required=True, help="Output directory to store index+metadata"
    )
    parser.add_argument(
        "--embedding-model",
        default="all-MiniLM-L6-v2",
        help="sentence-transformers model",
    )
    parser.add_argument(
        "--chunk-size", type=int, default=1500, help="Chunk size in characters"
    )
    parser.add_argument(
        "--chunk-overlap", type=int, default=200, help="Chunk overlap in characters"
    )
    parser.add_argument(
        "--exts",
        nargs="*",
        default=None,
        help="File extensions to include (with dot). Default common code/docs",
    )
    parser.add_argument(
        "--ignore-glob",
        nargs="*",
        default=load_ignore_globs(),
        help="Glob patterns to ignore (relative globs). Can also be set via env MANA_INDEX_IGNORE_GLOBS (comma-separated).",
    )
    parser.add_argument(
        "--n-trees",
        type=int,
        default=50,
        help="Annoy n_trees (higher = more accuracy, slower build)",
    )
    parser.add_argument(
        "--batch-size", type=int, default=64, help="Embedding batch size"
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    outdir = Path(args.out).resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    exts = set(DEFAULT_EXTS if args.exts is None else args.exts)

    print("Loading embedding model:", args.embedding_model)
    model = SentenceTransformer(args.embedding_model)
    dim = model.get_sentence_embedding_dimension()
    print("Embedding dim:", dim)

    items = []
    print("Scanning files...")
    for p in tqdm(list(iter_files(root, exts, args.ignore_glob))):
        text = read_file_text(p)
        if not text or len(text.strip()) == 0:
            continue
        chunks = chunk_text(text, args.chunk_size, args.chunk_overlap)
        for start_char, end_char, chunk in chunks:
            preview = chunk[:300].replace("\n", " ")
            items.append(
                {
                    "path": str(p.relative_to(root)),
                    "abs_path": str(p),
                    "start_char": int(start_char),
                    "end_char": int(end_char),
                    "text": chunk,
                    "preview": preview,
                }
            )

    print(f"Total chunks: {len(items)}")
    if len(items) == 0:
        print("No items found to index. Exiting.")
        return

    ann_index = AnnoyIndex(dim, "angular")
    metadata = []

    batch_size = args.batch_size
    for i in tqdm(range(0, len(items), batch_size), desc="Embedding batches"):
        batch = items[i : i + batch_size]
        texts = [it["text"] for it in batch]
        vectors = model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
        for j, vec in enumerate(vectors):
            idx = i + j
            ann_index.add_item(idx, vec.astype(np.float32))
            meta = {
                "id": idx,
                "path": batch[j]["path"],
                "abs_path": batch[j]["abs_path"],
                "start_char": batch[j]["start_char"],
                "end_char": batch[j]["end_char"],
                "preview": batch[j]["preview"],
            }
            # include the chunk text in metadata so retrievers can return full context
            meta["text"] = batch[j]["text"]
            metadata.append(meta)

    print("Building Annoy index (this can take a while)...")
    ann_index.build(args.n_trees)
    index_path = outdir / "index.ann"
    ann_index.save(str(index_path))
    print("Saved Annoy index to", index_path)

    meta_path = outdir / "metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    config = {
        "root": str(root),
        "embedding_model": args.embedding_model,
        "dim": dim,
        "n_items": len(metadata),
        "annoy_metric": "angular",
        "n_trees": args.n_trees,
    }
    with open(outdir / "config.json", "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print("Saved metadata and config to", outdir)
    print("Done.")


if __name__ == "__main__":
    main()
