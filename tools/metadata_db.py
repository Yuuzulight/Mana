#!/usr/bin/env python3
"""
Chunk metadata for the Annoy index, kept on disk in SQLite (#809).

The retriever used to json.load the whole metadata.json at startup (~11 GB of
RAM for an 859k-chunk index). Now the rows stay in <store>/metadata.sqlite and
only the top-k hits are read per query.

One-time conversion of an existing store (streams the JSON, low RAM):
  python tools/metadata_db.py tools/vector_store
"""

import json
import sqlite3
import sys
from pathlib import Path

DB_NAME = "metadata.sqlite"


def write(path, rows):
    """Write an iterable of metadata dicts (each with an "id") to a new DB."""
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    conn = sqlite3.connect(tmp)
    try:
        conn.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, meta TEXT NOT NULL)")
        conn.executemany(
            "INSERT INTO chunks VALUES (?, ?)",
            # ASCII-escaped so a lone surrogate from the source can't fail the UTF-8 bind
            ((r["id"], json.dumps(r)) for r in rows),
        )
        conn.commit()
    finally:
        conn.close()
    tmp.replace(path)


def open_ro(path):
    if not Path(path).is_file():
        raise FileNotFoundError(f"{path} not found (convert with: python tools/metadata_db.py <store dir>)")
    # check_same_thread=False: FastAPI may serve requests off the loading thread;
    # the connection is only ever read from.
    return sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True, check_same_thread=False)


def get(conn, ids):
    """{id: metadata dict} for the ids that exist."""
    ids = [int(i) for i in ids]
    marks = ",".join("?" * len(ids))
    rows = conn.execute(f"SELECT id, meta FROM chunks WHERE id IN ({marks})", ids) if ids else []
    return {i: json.loads(m) for i, m in rows}


def iter_json_array(path, bufsize=1 << 20):
    """Yield the objects of a top-level JSON array of objects without loading it all."""
    dec = json.JSONDecoder()
    with open(path, "r", encoding="utf-8") as f:
        buf = f.read(bufsize)
        pos = buf.index("[") + 1
        while True:
            while pos < len(buf) and buf[pos] in " \t\r\n,":
                pos += 1
            if pos == len(buf):
                buf, pos = f.read(bufsize), 0
                if not buf:
                    raise ValueError(f"{path}: unterminated JSON array")
                continue
            if buf[pos] == "]":
                return
            try:
                obj, end = dec.raw_decode(buf, pos)
            except json.JSONDecodeError:
                # Object runs past the buffer (elements are objects, so a
                # cut-off one never decodes early): read more and retry.
                more = f.read(bufsize)
                if not more:
                    raise
                buf, pos = buf[pos:] + more, 0
                continue
            yield obj
            pos = end


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python tools/metadata_db.py <vector store dir containing metadata.json>")
    store = Path(sys.argv[1])
    write(store / DB_NAME, iter_json_array(store / "metadata.json"))
    print(f"Wrote {store / DB_NAME}; metadata.json is no longer read and can be deleted.")
