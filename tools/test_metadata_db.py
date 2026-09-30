"""Self-check for metadata_db (#809), no pytest needed. Run directly:

    python tools/test_metadata_db.py
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))

import metadata_db  # noqa: E402


def run():
    rows = [{"id": i, "path": f"f{i}.py", "text": "x" * (i * 37) + "\udc80 é \"]}"} for i in range(50)]
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "metadata.json")
        with open(src, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2)
        # A tiny buffer forces objects to straddle reads.
        assert list(metadata_db.iter_json_array(src, bufsize=7)) == rows

        db = os.path.join(d, metadata_db.DB_NAME)
        metadata_db.write(db, metadata_db.iter_json_array(src))
        conn = metadata_db.open_ro(db)
        try:
            assert metadata_db.get(conn, [49, 3, 999]) == {49: rows[49], 3: rows[3]}
            assert metadata_db.get(conn, []) == {}
        finally:
            conn.close()

    print("metadata_db: all checks passed")


if __name__ == "__main__":
    run()
