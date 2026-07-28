# Issue 196: Real GGUF Metadata via @huggingface/gguf

## Goal

`model-management.js`'s `isValidGgufFile()` (issue #125's security
hardening) only checks the 4-byte "GGUF" magic bytes before ever handing a
file to llama-server -- it never parses the actual header. Let Mana read
real GGUF metadata (architecture, quantization, context length, parameter
count) instead of inferring everything from a filename.

## Status: Implemented (`node-bot/tools/gguf-metadata.js`, `GET /models/gguf-metadata`)

## What was verified before writing any code

Read `@huggingface/gguf`'s actual README rather than assuming its API
shape: the package exports an async `gguf(pathOrUrl, options)` function
returning `{ metadata, tensorInfos }`. `{ allowLocalFile: true }` is
required to read a local path (not supported in browsers, irrelevant here
since this only ever runs in `node-bot`). `metadata` is a flat object of
GGUF key-value pairs (`general.architecture`, `general.name`,
`general.file_type`, and architecture-namespaced keys like
`llama.context_length`/`qwen2.context_length`) -- there is **no direct
"total parameter count" field**; that's computed the same way llama.cpp's
own `gguf-dump.py` does, by summing the product of each tensor's shape
dimensions across every tensor in `tensorInfos`.

## Design

- **`tools/gguf-metadata.js`** -- `readGgufMetadata(filePath, options)`,
  an injectable `ggufFn` (defaults to the real `@huggingface/gguf` export)
  for testability. Extracts architecture, name, a human-readable
  quantization label (mapped from `general.file_type`'s numeric
  `ggml_ftype` value via a small lookup table of common quants -- falls
  back to `UNKNOWN_<n>` for anything not in the table rather than
  guessing), context length (architecture-namespaced key lookup), tensor
  count, and computed parameter count (returned as a string, since a large
  model's true parameter count can exceed `Number.MAX_SAFE_INTEGER` when
  computed as a BigInt sum). Returns `null` on any failure -- this is
  best-effort enrichment, never a hard requirement.
- **`GET /models/gguf-metadata?path=...`** -- a **new, separate** route
  from `GET /models/status`, deliberately not folded into it. Real GGUF
  parsing is real file I/O and CPU work; `/models/status` is a frequently
  polled endpoint (the launcher UI refreshes it regularly), so adding
  synchronous-feeling parse work to every poll would be a real performance
  regression for zero benefit most of the time. The new route is called
  on-demand -- when a user actually wants to see a specific model's real
  metadata (e.g. clicking to inspect a file), not on every status poll.
  Reuses `model-management.js`'s existing `isValidGgufFile()` magic-byte
  gate before ever attempting to parse -- same validation a path already
  goes through in `setModelPath`/`setVisionSettings`, now exported from
  `createModelManagement()`'s returned object so the route can reuse it
  rather than re-implementing the check.

## Deliberate simplifications

- **Recommender algorithm unchanged.** The issue asked for real metadata
  to "feed into" the hardware-aware model-profile recommender
  (`recommendModelProfile`), but that function currently decides purely
  from detected VRAM/RAM, not per-file data -- rewriting its decision
  logic to weigh real context-length/quant data without real hardware to
  validate the new logic against would be an unverifiable, risky change
  (the same caution issue #4 applied to Whisper model selection). This
  issue makes the real metadata available (via the new route); actually
  changing recommendation logic is separate, follow-up work once there's
  a way to validate it.
- **No new UI panel in windows-launcher/desktop-client.** The route exists
  and is ready to be called; building a model-info display panel in both
  Electron apps is a real, separate UI task not attempted here, matching
  the same "backend-first, defer UI polish" scoping issue #4 used for its
  own settings.

## Verified

- `node-bot/test/gguf-metadata.test.js` (7 tests, new): full metadata
  extraction, BigInt context-length handling, sparse-metadata graceful
  nulls, parser-failure returns null rather than throwing, parameter-count
  summation across tensors, empty/missing tensor info, quantization label
  mapping (known + unknown file_type values).
- `node-bot/test/server-routes.test.js` (+3 tests): invalid/missing path
  rejected before parsing, successful metadata round-trip, 422 when
  parsing fails for a path that passed the magic-byte gate.
- Full `node-bot` suite (one process per file): no regressions.
