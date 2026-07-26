"""Self-check for resolve_voice_ref's path-traversal fix (no pytest needed,
matching the rest of this project's lightweight test style). Run directly:

    python test_resolve_voice_ref.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))

from service import resolve_voice_ref, HERE  # noqa: E402


def run():
    references_dir = os.path.join(HERE, "references")
    os.makedirs(references_dir, exist_ok=True)

    # A bare name for a file that actually exists in the voice bank resolves.
    good_path = os.path.join(references_dir, "__test_voice__.wav")
    with open(good_path, "wb") as f:
        f.write(b"RIFF....WAVEfmt ")
    try:
        assert resolve_voice_ref("__test_voice__") == good_path
        assert resolve_voice_ref("__test_voice__.wav") == good_path
    finally:
        os.remove(good_path)

    # A bare name that tries to escape references/ via .. must NOT resolve
    # to whatever it points at outside the voice bank, even if that outside
    # file exists. The target lives directly in HERE (tts-service/) --
    # one level above references/ -- and gets a random name so it can't
    # coincidentally already exist relative to whatever the process's cwd
    # happens to be (which is what resolve_voice_ref's *intentional*
    # first branch, `os.path.exists(ref)`, checks against).
    outside_name = f"__escape_target_{os.getpid()}.wav"
    outside_path = os.path.join(HERE, outside_name)
    with open(outside_path, "wb") as f:
        f.write(b"not a real wav")
    try:
        traversal_ref = os.path.join("..", outside_name)
        assert not os.path.exists(traversal_ref), (
            "test setup bug: traversal_ref must not resolve relative to cwd, "
            "or this isn't actually testing the references_dir escape"
        )
        try:
            resolve_voice_ref(traversal_ref)
            raise AssertionError(
                "resolve_voice_ref should have rejected a path escaping references/"
            )
        except ValueError:
            pass  # expected: "Unknown voice reference"
    finally:
        os.remove(outside_path)

    # An absolute path to a real file is still accepted (documented,
    # intentional behavior for this local, single-user service).
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as absolute:
        absolute.write(b"not a real wav either")
        absolute_path = absolute.name
    try:
        assert resolve_voice_ref(absolute_path) == absolute_path
    finally:
        os.remove(absolute_path)

    print("resolve_voice_ref: all checks passed")


if __name__ == "__main__":
    run()
