# Issue 195: Evaluate text-embeddings-inference (TEI) as the Local Embedder Backend

## Goal

Evaluate `huggingface/text-embeddings-inference` (TEI) as a replacement for
`node-bot/tools/local_embedder.py` (the Python/sentence-transformers service
`windows-launcher/main.js` spawns on port 9001 for the memory retriever's
embeddings).

## Status: Evaluated -- **not swapping** (real blocker found), one real improvement shipped

## What was actually verified (not assumed)

Read TEI's real README/install docs directly rather than trusting the
earlier survey's summary of it:

1. **Wire format**: TEI's `/embed` accepts `{"inputs": "text"}` or
   `{"inputs": [...]}"` (batched, `--max-client-batch-size` default 32) --
   compatible with what `tools/retriever-index.js`'s `computeEmbeddings()`
   already sends. Its **response**, however, is a **bare JSON array**
   (`[[float,...], ...]`), not the `{ok, embeddings: [...]}` wrapper
   `local_embedder.py` returns today -- a real, confirmed shape mismatch,
   not a hypothetical one.
2. **Windows deployment: no clean path.** TEI's own "Local Install" section
   only offers a prebuilt binary via Homebrew, and that's **Apple Silicon
   only**. Every other install path is either a Docker image (`cpu-1.9`,
   `cuda-1.9`, ARM64 variants) or building from source with
   `cargo install --path router -F candle-cuda`, which the README itself
   notes "might take a while as it needs to compile the CUDA kernels" --
   a Linux/Mac-oriented workflow, not a native Windows binary. **There is
   no official native Windows build or installer.**

## Why this rules out the swap (for now)

Mana's entire toolchain is deliberately Windows-native: `llama-server.exe`,
`whisper-cli.exe`, and `local_embedder.py` (a plain Python script, no
container) are all spawned directly as local processes -- no Docker
Desktop dependency exists anywhere in the current setup. Requiring Docker
Desktop just to run the embedder would be a meaningfully larger ask than
"swap one local process for a faster one," and isn't something to decide
unilaterally on the user's behalf. This is the honest result of actually
checking the deployment story, not a guess -- the original survey flagged
TEI based on its README's feature list and benchmark claims, without
having checked how it's actually distributed for the platform Mana
targets.

## What shipped instead: a real, low-risk compatibility fix

Even though the swap isn't happening now, the wire-format investigation
surfaced a genuine, worthwhile gap: `computeEmbeddings()` only recognized
`local_embedder.py`'s wrapped `{embeddings: [...]}` shape and would have
silently returned `null` for every embedding against any backend
returning a bare array -- including TEI, if someone tried pointing at it
manually, or any other future embedder with the same bare-array
convention. Fixed to accept either shape (`tools/retriever-index.js`):

```js
const embeddings = Array.isArray(j) ? j : Array.isArray(j?.embeddings) ? j.embeddings : null;
```

This is a real robustness improvement independent of the TEI decision --
`RETRIEVER_EMBEDDER_URL` already lets a user point at any local embedder
process; this just stops the retriever from silently failing against one
that returns the more common bare-array convention.

## Revisit when

- TEI ships an official native Windows build, or
- The user decides Docker Desktop is an acceptable dependency to add for
  this, in which case the actual swap (replacing `local_embedder.py`'s
  spawn in `windows-launcher/main.js` with a TEI container/binary spawn)
  is now unblocked wire-format-wise -- `computeEmbeddings()` already
  handles TEI's actual response shape correctly.

## Verified

- `node-bot/test/retriever-embeddings-local-shapes.test.js` (3 tests, new):
  wrapped `{embeddings: [...]}` shape, bare-array shape, and an unrecognized
  shape correctly falling through to nulls (not throwing).
- `node-bot/test/retriever-embeddings-openai-fallback.test.js`: still
  passes unmodified -- confirms the OpenAI-fallback path (a separate shape,
  `{data: [{embedding: [...]}]}`) is untouched by this change.
