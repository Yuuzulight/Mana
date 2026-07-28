# Issue 220: Benchmark llama-server `--cache-ram` and `sqlite-vec`

## Status: Investigation complete, no code changes (per issue scope)

## Part 1: llama-server `--cache-ram` -- already active, verified with real numbers

**Finding: this is already on by default on Mana's exact installed llama-server
build (b9436) -- there was nothing to enable.**

`llama-server.exe --help` on the real binary Mana ships
(`tools/llama/llama-b9436-bin-win-cuda-12.4-x64/llama-server.exe`) shows
`--cache-ram` defaults to 8192 MiB, and the real startup log confirms it:

```
srv    load_model: prompt cache is enabled, size limit: 8192 MiB
srv    load_model: use `--cache-ram 0` to disable the prompt cache
```

`--kv-unified` also defaults to enabled when the slot count is auto-detected
(confirmed: Mana doesn't set `-np`/`--slots` anywhere, and the startup log
shows `n_slots = 4` auto-detected).

**Real benchmark** (started llama-server with Mana's exact real args --
`-m Qwen3-4B-Q4_K_M.gguf -ngl 99 -c 4096`, no other flags, matching
`llama-server-runtime.js`'s `buildServerArgs()` exactly -- against a
~2925-character/644-token system prompt, matching realistic persona-prompt
length):

| Call | prompt_n | prompt_ms | note |
|---|---|---|---|
| 1 (cold) | 644 | 8443.8 | full system prompt processed for the first time |
| 2 (same prefix, new question) | 17 | 512.1 | only the new suffix tokens processed |
| 3 (same prefix, new question) | 17 | 343.1 | cache reuse, even faster |

A ~94% reduction in prompt-processing time on the second call -- matching
the ~93% figure the original GitHub discussion cited, and already happening
today. Also verified across a realistic growing multi-turn conversation
(system + 4 back-and-forth turns): `prompt_n` stayed at ~60-65 tokens per
turn (just the newly-added turn) instead of reprocessing the whole growing
history each time.

**Conclusion: no code change recommended.** It's already working exactly as
intended, with zero configuration. `--cache-reuse` (still 0/off by default)
wasn't tested further -- Mana's actual usage pattern is append-only
conversation growth with an exact shared prefix, which unified-KV +
cache-ram already handles fully; `--cache-reuse`'s KV-shifting reuse
matters more for reordered/partially-overlapping prompts, not this case.

## Part 2: sqlite-vec -- works, but via a different pairing than assumed, and not currently justified by scale

**The originally-assumed pairing doesn't work on this machine.** `sqlite-vec`
itself installs cleanly (prebuilt binaries, confirmed). But `better-sqlite3`
(the SQLite driver it was assumed to pair with, since Electron apps
typically use it) **fails to install** -- it requires a native compile,
and `node-gyp` can't find a usable Visual Studio C++ toolchain on this dev
machine (one is installed, but apparently missing the "Desktop development
with C++" workload or an unrecognized edition). This is a real Windows
friction point the original survey didn't check.

**A better-fitting pairing was found and verified instead**: Node 22's
built-in `node:sqlite` module (`DatabaseSync`, experimental but present,
prints a warning rather than requiring a flag as of Node 22.23) has a
`loadExtension()` method, and `sqlite-vec`'s prebuilt `vec0.dll` loads into
it directly -- **zero native compilation anywhere in the chain**:

```js
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:", { allowExtension: true });
db.loadExtension(require("sqlite-vec").getLoadablePath());
db.prepare("select vec_version() as v").get(); // -> v0.1.9
```

Caveat: `node-bot/package.json` has no `engines` field pinning a minimum
Node version, so adopting this would need Node >=22.5 (when `node:sqlite`
landed) documented/enforced, and `node:sqlite` remains explicitly
experimental per Node's own warning.

**Real performance/correctness benchmark** (`node:sqlite` + sqlite-vec vs.
the current JS brute-force cosine loop in `tools/vector-store.js`'s
`makeFallbackStore`, real 384-dim vectors -- a typical small local embedder
size):

| N vectors | JS brute-force search | sqlite-vec search | Result match |
|---|---|---|---|
| 2,000 (Mana's actual default `RETRIEVER_INDEX_MAX_FILES` cap) | ~1-3ms | ~1-3ms | identical top-5 |
| 50,000 (25x Mana's real cap) | ~40-57ms | ~22-25ms | identical top-5 |

At Mana's actual current operating scale (2,000 entries), **there is no
meaningful performance difference** -- both are already sub-3ms. The ~2x
edge for sqlite-vec only shows up at a scale well beyond what Mana's own
default cap allows today. Search correctness matched exactly at both
scales (same top-5 IDs as the brute-force ground truth). Bulk insert is a
real one-time cost (~1.4s per 50k rows) but not a per-query one.

**Conclusion: a real, working option (via `node:sqlite`, not
`better-sqlite3`), but not currently justified by performance at Mana's
actual scale.** The genuine advantage it would offer isn't raw query
speed today -- it's not needing to fully materialize the whole vector set
into one resident JS array/JSON blob (what `makeFallbackStore` does now),
which matters more for memory footprint than for search latency at this
size. Worth revisiting if `RETRIEVER_INDEX_MAX_FILES` is ever raised well
beyond 2,000, not adopted here.

## Out of scope

Adopting either candidate's code into `llama-server-runtime.js` or
`tools/vector-store.js` -- neither benchmark justified a change; this
issue's own scope was the test, not the build.
