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
    p.add_argument(
        "--serve-stdio",
        action="store_true",
        help="run as a simple line-delimited JSON stdin/stdout server",
    )
    p.add_argument(
        "--serve-http",
        action="store_true",
        help="run as an HTTP JSON API server (POST endpoints)",
    )
    p.add_argument(
        "--http-secret",
        default=None,
        help="optional shared-secret token for HTTP endpoints (Bearer)",
    )
    args = p.parse_args(argv)

    # Metrics (persisted)
    METRICS_PATH = ROOT.joinpath("node-bot", "data", "token_metrics.json")

    def ensure_metrics_dir():
        try:
            METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

    def load_metrics():
        try:
            if not METRICS_PATH.exists():
                return None
            with open(METRICS_PATH, "r", encoding="utf8") as f:
                return json.load(f) or None
        except Exception:
            return None

    def save_metrics(metrics):
        try:
            ensure_metrics_dir()
            with open(METRICS_PATH, "w", encoding="utf8") as f:
                json.dump(metrics, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    _HISTOGRAM_BUCKETS = [10, 50, 100, 200, 500, 1000, 5000]

    _METRICS = load_metrics()
    if not _METRICS:
        _METRICS = {
            "total_requests": 0,
            "latency_buckets_ms": {b: 0 for b in _HISTOGRAM_BUCKETS},
            "cache_hits": 0,
            "cache_misses": 0,
        }
        save_metrics(_METRICS)

    def _record_latency(ms):
        _METRICS["total_requests"] += 1
        for b in _HISTOGRAM_BUCKETS:
            if ms <= b:
                _METRICS["latency_buckets_ms"][b] = (
                    _METRICS["latency_buckets_ms"].get(b, 0) + 1
                )
                break
        save_metrics(_METRICS)

    def _record_cache_hit():
        _METRICS["cache_hits"] = _METRICS.get("cache_hits", 0) + 1
        save_metrics(_METRICS)

    def _record_cache_miss():
        _METRICS["cache_misses"] = _METRICS.get("cache_misses", 0) + 1
        save_metrics(_METRICS)

    if args.serve_stdio:
        # Run a line-delimited JSON server on stdin/stdout
        try:
            import sys
            import tempfile
            import time

            def handle_request(req: Dict[str, Any]) -> Dict[str, Any]:
                method = req.get("method")
                start = time.perf_counter()
                try:
                    if method == "count_text":
                        text = req.get("text", "")
                        ext = req.get("ext", ".py")
                        rebuild = bool(req.get("rebuild", False))
                        # write temp file and use get_token_count_for_file to update cache
                        tf = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
                        tf.write(text.encode("utf8"))
                        tf.flush()
                        tf.close()
                        try:
                            cache = load_cache()
                            key = str(Path(tf.name).resolve())
                            entry = cache.get(key)
                            if entry and not rebuild and entry.get("fingerprint"):
                                _record_cache_hit()
                                tokens = entry.get("tokens")
                            else:
                                tokens = get_token_count_for_file(
                                    Path(tf.name), cache, rebuild=rebuild
                                )
                                _record_cache_miss()
                            save_cache(cache)
                            return {"ok": True, "tokens": tokens}
                        finally:
                            try:
                                os.unlink(tf.name)
                            except Exception:
                                pass
                    elif method == "count_path":
                        pth = req.get("path")
                        rebuild = bool(req.get("rebuild", False))
                        if not pth:
                            return {"ok": False, "error": "missing path"}
                        try:
                            cache = load_cache()
                            key = str(Path(pth).resolve())
                            entry = cache.get(key)
                            if entry and not rebuild and entry.get("fingerprint"):
                                _record_cache_hit()
                                tokens = entry.get("tokens")
                            else:
                                tokens = get_token_count_for_file(
                                    Path(pth), cache, rebuild=rebuild
                                )
                                _record_cache_miss()
                            save_cache(cache)
                            return {"ok": True, "tokens": tokens}
                        except Exception as e:
                            return {"ok": False, "error": str(e)}
                    elif method == "scan_path":
                        pth = req.get("path")
                        exts = req.get("exts", [".py"]) or []
                        rebuild = bool(req.get("rebuild", False))
                        try:
                            res = scan_and_update(Path(pth), exts, rebuild=rebuild)
                            return {"ok": True, "cacheKeys": list(res.keys())}
                        except Exception as e:
                            return {"ok": False, "error": str(e)}
                    elif method == "shutdown":
                        return {"ok": True, "shutdown": True}
                    else:
                        return {"ok": False, "error": "unknown_method"}
                finally:
                    elapsed = (time.perf_counter() - start) * 1000.0
                    _record_latency(elapsed)

            for raw in sys.stdin:
                line = raw.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except Exception as e:
                    resp = {"ok": False, "error": f"invalid_json: {e}"}
                    print(json.dumps(resp), flush=True)
                    continue
                resp = handle_request(req)
                # echo id if present
                if isinstance(req, dict) and "id" in req:
                    resp["id"] = req["id"]
                print(json.dumps(resp), flush=True)
                if resp.get("shutdown"):
                    break
        except Exception:
            pass
        return 0

    if args.serve_http:
        # Start a simple HTTP server with JSON endpoints
        import threading
        import time
        from http.server import BaseHTTPRequestHandler, HTTPServer

        SECRET = args.http_secret or os.environ.get("PY_TOKEN_SERVER_SECRET")

        def check_auth(headers):
            if not SECRET:
                return True
            auth = headers.get("Authorization") or headers.get("authorization")
            if not auth or not isinstance(auth, str):
                return False
            if not auth.startswith("Bearer "):
                return False
            token = auth[len("Bearer ") :].strip()
            return token == SECRET

        class Handler(BaseHTTPRequestHandler):
            def _send_json(self, data, status=200):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode("utf8"))

            def _require_auth(self):
                if check_auth(self.headers):
                    return True
                self._send_json({"ok": False, "error": "unauthorized"}, 401)
                return False

            def do_POST(self):
                if not self._require_auth():
                    return
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length) if length else b""
                try:
                    obj = json.loads(body.decode("utf8") if body else "{}")
                except Exception as e:
                    self._send_json({"ok": False, "error": "invalid_json"}, 400)
                    return

                start = time.perf_counter()
                try:
                    if self.path == "/count_text":
                        text = obj.get("text", "")
                        ext = obj.get("ext", ".py")
                        rebuild = bool(obj.get("rebuild", False))
                        tf = None
                        try:
                            import tempfile

                            tf = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
                            tf.write(text.encode("utf8"))
                            tf.flush()
                            tf.close()
                            cache = load_cache()
                            key = str(Path(tf.name).resolve())
                            entry = cache.get(key)
                            if entry and not rebuild and entry.get("fingerprint"):
                                _record_cache_hit()
                                tokens = entry.get("tokens")
                            else:
                                tokens = get_token_count_for_file(
                                    Path(tf.name), cache, rebuild=rebuild
                                )
                                _record_cache_miss()
                            save_cache(cache)
                            self._send_json({"ok": True, "tokens": tokens})
                        except Exception as e:
                            self._send_json({"ok": False, "error": str(e)}, 500)
                        finally:
                            try:
                                if tf:
                                    os.unlink(tf.name)
                            except Exception:
                                pass
                        return
                    if self.path == "/count_path":
                        pth = obj.get("path")
                        rebuild = bool(obj.get("rebuild", False))
                        if not pth:
                            self._send_json({"ok": False, "error": "missing path"}, 400)
                            return
                        try:
                            cache = load_cache()
                            key = str(Path(pth).resolve())
                            entry = cache.get(key)
                            if entry and not rebuild and entry.get("fingerprint"):
                                _record_cache_hit()
                                tokens = entry.get("tokens")
                            else:
                                tokens = get_token_count_for_file(
                                    Path(pth), cache, rebuild=rebuild
                                )
                                _record_cache_miss()
                            save_cache(cache)
                            self._send_json({"ok": True, "tokens": tokens})
                        except Exception as e:
                            self._send_json({"ok": False, "error": str(e)}, 500)
                        return
                    if self.path == "/scan_path":
                        pth = obj.get("path")
                        exts = obj.get("exts", [".py"]) or []
                        rebuild = bool(obj.get("rebuild", False))
                        try:
                            res = scan_and_update(Path(pth), exts, rebuild=rebuild)
                            self._send_json({"ok": True, "cacheKeys": list(res.keys())})
                        except Exception as e:
                            self._send_json({"ok": False, "error": str(e)}, 500)
                        return
                    if self.path == "/shutdown":
                        if not check_auth(self.headers):
                            self._send_json({"ok": False, "error": "unauthorized"}, 401)
                            return
                        self._send_json({"ok": True, "shutdown": True})
                        threading.Thread(
                            target=os._exit, args=(0,), daemon=True
                        ).start()
                        return
                    self._send_json({"ok": False, "error": "unknown_endpoint"}, 404)
                finally:
                    elapsed = (time.perf_counter() - start) * 1000.0
                    _record_latency(elapsed)

            def do_GET(self):
                if not self._require_auth():
                    return
                if self.path == "/cache":
                    try:
                        cache = load_cache()
                        keys = list(cache.keys())
                        self._send_json({"ok": True, "keys": keys, "count": len(keys)})
                    except Exception as e:
                        self._send_json({"ok": False, "error": str(e)}, 500)
                    return
                if self.path == "/metrics":
                    try:
                        self._send_json({"ok": True, "metrics": _METRICS})
                    except Exception as e:
                        self._send_json({"ok": False, "error": str(e)}, 500)
                    return
                self._send_json({"ok": False, "error": "unknown_endpoint"}, 404)

        port = int(os.environ.get("PY_TOKEN_SERVER_PORT", "9000"))
        server = HTTPServer(("0.0.0.0", port), Handler)
        print(json.dumps({"ok": True, "server": "http", "port": port}))
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.shutdown()
        return 0

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
