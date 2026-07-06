#!/usr/bin/env python3
"""
Python Token-Count Caching Matrix

- Computes token estimates for Python source files.
- Caches results in node-bot/data/token_count_cache.json keyed by absolute path.
- Uses tiktoken if available for accurate counts, otherwise falls back to a fast heuristic.

CLI usage:
  python python_token_cache.py --path path/to/file_or_dir [--ext .py] [--rebuild]

Returns JSON on stdout when invoked for a single file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT.joinpath("node-bot", "data", "token_count_cache.json")


def ensure_cache_dir() -> None:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def load_cache() -> Dict[str, Any]:
    try:
        if not CACHE_PATH.exists():
            return {}
        with open(CACHE_PATH, "r", encoding="utf8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save_cache(cache: Dict[str, Any]) -> None:
    try:
        ensure_cache_dir()
        with open(CACHE_PATH, "w", encoding="utf8") as f:
            json.dump(cache, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def compute_fingerprint(path: Path, stat: os.stat_result) -> str:
    h = hashlib.sha256()
    # fingerprint depends on path, size, mtime
    h.update(str(path.resolve()).encode("utf8"))
    h.update(str(stat.st_size).encode("utf8"))
    # use mtime with limited precision to avoid tiny variations
    h.update(str(int(stat.st_mtime)).encode("utf8"))
    return h.hexdigest()


def _count_tokens_tiktoken(text: str) -> Optional[int]:
    try:
        import tiktoken

        # cl100k_base is the common encoding for most modern OpenAI/GGUF models
        enc = None
        try:
            enc = tiktoken.get_encoding("cl100k_base")
        except Exception:
            try:
                enc = tiktoken.encoding_for_model(
                    os.environ.get("TOKEN_MODEL", "gpt-4o-mini")
                )
            except Exception:
                enc = None
        if enc is None:
            return None
        toks = enc.encode(text)
        return len(toks)
    except Exception:
        return None


def estimate_tokens_heuristic(text: str) -> int:
    # Conservative heuristic: average 4 characters per token is a common rule of thumb
    # Use bytes length to account for non-ascii.
    b = text.encode("utf8")
    return max(1, (len(b) + 3) // 4)


def count_tokens(text: str) -> int:
    # Try the accurate tiktoken path first
    val = _count_tokens_tiktoken(text)
    if isinstance(val, int):
        return val
    # Fallback heuristic
    return estimate_tokens_heuristic(text)


def get_token_count_for_file(
    path: Path, cache: Dict[str, Any], rebuild: bool = False
) -> int:
    stat = path.stat()
    key = str(path.resolve())
    fp = compute_fingerprint(path, stat)
    entry = cache.get(key)
    if (
        not rebuild
        and entry
        and entry.get("fingerprint") == fp
        and isinstance(entry.get("tokens"), int)
    ):
        return entry["tokens"]

    text = path.read_text(encoding="utf8", errors="ignore")
    tokens = count_tokens(text)
    cache[key] = {
        "path": key,
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "fingerprint": fp,
        "tokens": tokens,
    }
    return tokens


def scan_and_update(
    root: Path, exts: List[str], rebuild: bool = False
) -> Dict[str, Any]:
    cache = load_cache()
    files = []
    if root.is_file():
        files = [root]
    else:
        for p in root.rglob("*"):
            if p.is_file():
                if not exts or p.suffix in exts:
                    files.append(p)
    files_sorted = sorted(files, key=lambda p: str(p))
    for p in files_sorted:
        try:
            get_token_count_for_file(p, cache, rebuild=rebuild)
        except Exception:
            # skip problematic files
            continue
    save_cache(cache)
    return cache


def cli(argv: List[str]) -> int:
    p = argparse.ArgumentParser(description="Python Token-Count Caching Matrix")
    p.add_argument("--path", "-p", default=".", help="file or directory to scan")
    p.add_argument(
        "--ext",
        default=".py",
        help="comma-separated extensions to include, e.g. .py,.txt",
    )
    p.add_argument(
        "--rebuild",
        action="store_true",
        help="rebuild token counts even if cache matches",
    )
    p.add_argument(
        "--json", action="store_true", help="print JSON cache for given path and exit"
    )
    args = p.parse_args(argv)

    root = Path(args.path)
    exts = [e.strip() for e in args.ext.split(",") if e.strip()] if args.ext else []
    cache = scan_and_update(root, exts, rebuild=args.rebuild)

    if args.json:
        # If a single file path was requested and exists, print its cache entry
        rp = root.resolve()
        key = str(rp)
        if key in cache:
            print(json.dumps(cache[key], indent=2))
            return 0
        # otherwise, print the whole cache (may be large)
        print(json.dumps(cache, indent=2))
        return 0

    # Default CLI prints a brief summary
    total_files = len(
        [k for k, v in cache.items() if not exts or Path(k).suffix in exts]
    )
    total_tokens = sum(
        v.get("tokens", 0)
        for k, v in cache.items()
        if not exts or Path(k).suffix in exts
    )
    print(
        f"Scanned {total_files} file(s). Total tokens (cached/estimated): {total_tokens}"
    )
    print(f"Cache stored at: {CACHE_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:]))
