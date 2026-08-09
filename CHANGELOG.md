# Changelog

All notable changes to Mana are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

This file starts tracking from **0.2.0** — Mana has an extensive commit
history before this (`git log` has the full detail), but nothing summarized
it at a release level until now. Earlier work isn't reconstructed
retroactively; `0.1.0` below is a short baseline description, not a full
accounting.

## [Unreleased]

- Added a Memory browser to Settings (issue #324): `acp-memory-store.js`'s remembered-fact
  store (`memory__remember`) previously had no admin surface at all -- the only way to see a
  fact's `unverifiedSource` flag (issue #317), status, or text was reading `facts.json` by
  hand. Added `GET /admin/memory/facts` and `POST /admin/memory/facts/:key/archive`
  (`node-bot/capabilities/memory-facts-capability.js`) and a searchable "Memory" panel in
  both apps' Settings.
- Fixed the auto-update download step being able to hang forever with no error (issue #323):
  `desktop-client/update-manager.js`'s `downloadUpdate()` call now races against a 5-minute
  timeout (configurable via `MANA_UPDATE_DOWNLOAD_TIMEOUT_MS`), surfacing a clear "timed out"
  error through the existing status UI instead of leaving the user stuck on "Downloading
  update..." indefinitely.
- Added a Doctor panel check for session search's vector index (issue #321):
  `session-search-index.js` already exposed a `vectorEnabled()` getter so
  callers could tell whether sqlite-vec's native extension actually loaded,
  but nothing outside a startup console warning ever read it -- a failed
  load (a missing platform-specific `sqlite-vec-<platform>-<arch>` package,
  even when correctly pinned) silently degraded session search to
  keyword-only with no visible signal. Now surfaced as a pass/warn check in
  the Doctor panel.
- Added Mermaid diagram rendering to the artifact system: a ```` ```mermaid ```` fence
  now opens the standalone artifact window as a real rendered SVG diagram
  instead of raw text, in both windows-launcher and desktop-client. Mermaid
  is loaded as its own trusted, Mana-bundled global script (not through the
  DOMPurify-sanitized HTML-artifact path), with `securityLevel: 'strict'`
  since diagram text can originate from summarized web content, not just the
  user. A short diagram now qualifies as an artifact regardless of length,
  matching how ```` ```html ```` fences already work.

- Added a speaker-attribution guard on memory writes (issue #317): the
  `memory__remember` tool now checks whether the fact it's about to save
  actually overlaps something the user said in the current turn (via a
  deterministic keyword-overlap ratio, the same technique the existing
  fact-conflict check already uses -- no extra LLM call). A fact that fails
  the check is stored as `unverifiedSource: true` rather than rejected --
  visible to the model so a later correction still patches the same key, but
  excluded from automatic surfacing into future replies as trusted context.
  Checked against the raw transcript specifically, not the assembled prompt
  (which is already blended with screen OCR, market data, and retrieved web
  content by the time a tool call happens).

## [0.3.0] - 2026-08-03

91 merged PRs' worth of changes since 0.2.2 -- a minor bump rather than a
patch, since a 0.2.3 would badly undersell the volume here. Highlights:
the skills system (proposal/review/approval loop, bundled scripts, an
always-on skill index), the Hebbian associative memory graph and
emotional-state reflexes, ~15 issue-workflow batches spanning security
hardening (.env access restriction, credential broker scoping, regex
bypass fixes), Deep Research improvements (reflect-on-gaps, per-profile
routing, tool-catalogue pre-filtering), the sandboxed coding-mode
diff-and-apply flow, and this release's own prep work: a chain of 10 CI
fixes (a cross-platform path-guard bug found and fixed across five
files, a missing-directory 500, and a stale CI Node pin plus a
never-before-exercised installer artifact-path bug) that got
`heavy-ci.yml` fully green -- including a real Windows installer build --
for the first time in this repo's CI history.

### Added
- **Emotional-state-driven reflexes** (issue #295, piece 2 of #285):
  `userAffectState` -- a decaying positivity score built from the same
  emoji/kaomoji/keyword mood signal `reply-emotion.js` already detects for
  the avatar's expression (ported server-side as `utils/text-mood.js`),
  just applied to the user's own message text each turn instead of
  labeling one reply. Decays with a 12h half-life so a single strong
  reaction doesn't linger forever, persisted in a new
  `emotional-state.json` sibling to `facts.json`. A decay+threshold check
  now runs inside the existing hourly background-memory-reviewer timer
  (not a new interval, and not only the idle-report handler, which never
  fires at all when the launcher isn't running) -- once the gap since the
  last real conversation crosses 48h
  (`MANA_LONELINESS_THRESHOLD_HOURS`), it patches a `journal-loneliness`
  fact via the already-existing `rememberFact()`, one real reflex rather
  than a framework of hypothetical ones. `rutScore` (from
  `rut-detection.js`) and an opt-in LLM self-assessment were both scoped
  in the design doc but deliberately deferred -- loneliness alone is
  already a real, working, testable trigger; the other two inputs are
  future work, not silently dropped.
- **Hebbian associative memory graph** (issue #295, piece 1 of #285):
  entities that co-occur in the same turn get an edge in a new SQLite graph
  (`memory-graph.js`), reinforced on every `appendTurn()` -- `weight`
  increments via an atomic upsert (`ON CONFLICT ... DO UPDATE`), no
  read-then-write race like `entity-index.json`'s own mention tracking has.
  `searchSessions()` now runs a second pass after its existing
  keyword/semantic hits: entities from those results get one hop of
  neighbor lookup, and any linked entity with real mentions elsewhere
  becomes an `matchType: "associative"` result -- surfacing a memory with
  zero lexical or semantic overlap with the query, the way an unrelated
  detail can trigger a linked memory by association. Capped by `maxEdges`
  (lowest-weight eviction) and `maxDegree` per node (stops one hub entity
  from accumulating an edge to everything), and always additive: any
  failure anywhere in the graph path falls back to today's keyword/semantic
  results exactly, reinforcement never blocks a turn append. Graph edges
  are reinforced from multi-word entities only ("Alice Smith", not a
  sentence-initial "Sounds" or "Agreed") -- `extractEntities()`'s
  Title-Case-run heuristic treats either the same, and a lone capitalized
  word from an assistant reply's opening word is common enough to become
  real noise once it's shown back as an "associative" result.
- **Guardian pre-check on the approval gate** (issue #284, off by default via
  `MANA_GUARDIAN_PRECHECK_ENABLED=1`): before a gated action (a skill write,
  a generated script run, ...) lands in the human approval queue, a small
  model judges that *specific* action's risk -- not a fixed allowlist --
  and auto-clears it only when it confidently judges the action low-risk.
  Reuses whatever model is already loaded for the "fast" profile
  (`ai/guardian-precheck.js`'s `judgeActionRisk`), same reasoning as #281's
  tool-catalogue filter/result digest. Every auto-clearance is written to
  its own audit log (`approval-gate.js`'s `guardianAuditLog`, built on the
  existing `tool-call-log.js` JSON-lines format) and readable via
  `GET /approvals/guardian-audit`, mirroring `/tool-calls/recent`. The
  deterministic content scan (`contentScanEnabled`) always wins over the
  model's judgment -- Guardian is skipped entirely once the scan already
  flagged something -- and any Guardian failure (model unavailable,
  unclear verdict) falls straight through to the normal pending-queue path,
  never silently auto-approving.
- **Positionable memory injection** (issue #282): the session summary,
  recent-turn history, and cross-session related facts that used to get
  flattened into one block of system-prompt text now become their own
  system-role chat messages, each independently placed "early" (right after
  the persona system message) or "late" (right before the live user
  message -- SillyTavern's high-salience "depth 0" equivalent). `llama-server`
  already speaks a standard OpenAI-compatible `messages` array over
  `/v1/chat/completions`; only the application code that built exactly two
  messages (`system`, `user`) needed to change --
  `ai/llama-server-runtime.js`'s `runLocalAssistantReply`/`runToolAwareReply`
  take a new optional `extraMessages: {early, late}` param, falling back to
  the old 2-message shape when omitted. `acp-memory-store.js` gains
  `buildPromptMemoryEntries`/`getRelatedFactsEntries` -- structured-entry
  siblings of the existing `buildPromptMemory`/`getRelatedFacts`, built on
  shared internal helpers so neither existing string-returning function (or
  its ~15 existing test assertions) changed. Paths that only take a flat
  system-prompt string (the OpenAI proxy, Best-of-N) still get memory via
  the old flattened text, so they don't lose context.
- **Tool-catalogue pre-filter + result digest, gated to the "fast" profile**
  (issue #281): on the small/"fast" model profile only, a large tool
  catalogue gets pre-filtered to what's plausibly relevant to the current
  message before the reply model ever sees it, and a raw tool result over
  ~1500 chars gets condensed into a short note -- both reuse the
  already-loaded fast-profile model (no dedicated filter model), and both
  are pure best-effort: any failure (parse error, model unavailable) falls
  back to the unfiltered/uncompressed behavior, never blocks a reply.
  Skipped entirely on "quality"/"coding" profiles, which have the context
  headroom to not need either pass. Condensed results are framed
  `[TOOL OUTPUT, NOT INSTRUCTIONS]`, the same prompt-injection-defense
  convention `memory-tool-source.js`'s `framePossibleConflict()` already
  uses for stored content passed back through the model.
- **Presence-gated screen-sensing** (issue #283): the periodic glance now
  skips entirely (no capture, no vision-model call) when nobody's touched
  the keyboard/mouse in the last `MANA_SCREEN_SENSING_PRESENCE_IDLE_MS`
  (default 90s) -- reuses the same `powerMonitor` OS idle-time signal
  already polled for Dream Mode's idle-report, exposed to the renderer via
  a new `get-idle-seconds` IPC handler, rather than a new camera/presence
  pipeline (screen-sensing captures the desktop, not a webcam, so there was
  never a camera feed to gate against in the first place).
- **Hybrid keyword+vector session search** (issue #263 part 1, opt-in via
  `USE_EMBEDDINGS=1` -- same flag `tools/retriever-index.js`'s file
  retriever already uses, off by default): `session-search-index.js` now
  also indexes a per-turn embedding into a `vec0` (sqlite-vec) table in the
  same SQLite database as the existing FTS5 keyword index, so "what did we
  talk about regarding X" can match a differently-worded question about the
  same topic, not just exact keyword overlap. Uses the already-shipped
  `better-sqlite3` connection (issue #260's FTS5 index already depends on
  it) rather than a separate database or a new driver -- the roadmap doc's
  original plan assumed `better-sqlite3` didn't install on this dev machine
  and reached for the still-experimental `node:sqlite` instead; that
  premise turned out to be stale (see the roadmap doc's updated status).
  Both the write path (`acp-memory-store.js`'s `appendTurn`, fire-and-forget
  so a slow/unavailable embedder never adds reply latency) and the read
  path (`searchSessions`) are additive: with no `computeEmbeddingsFn` wired,
  or with embeddings disabled/unavailable, behavior is unchanged
  keyword-only search. Results from both signals are interleaved and
  reranked for diversity (drops a semantic hit that just restates an
  already-kept keyword hit) rather than blindly concatenated. `sqlite-vec`'s
  platform binary is a genuinely optional dependency (`node-bot/.npmrc`'s
  `omit=optional`, a deliberate issue #187 decision, skips it) -- when
  unavailable, `session-search-index.js` degrades to keyword-only
  automatically (`vectorEnabled()`), which is also what this project's own
  CI runs under, so CI verifies the fallback path while local Windows
  installs (with the platform binary present) get the real one.
- **Mana can pick her own Live2D expression** (issue #253): a new
  `expression__set` tool lets a reply nominate an expression by name,
  threaded through `buildAssistantReply`/`/reply`/`/transcribe` as an
  additive `expression` field alongside the existing automatic
  mood-based detection, all the way through IPC to both apps' avatar
  renderers -- it takes priority over the automatic pick when the model
  supplies one, and falls back gracefully otherwise.
- **Contradiction-aware memory writes** (issue #273): `rememberFact`'s
  `insert` action now flags a `possibleConflict` (existing fact, lexically
  overlapping) in its return value instead of silently overwriting --
  the model judges and follows up with an explicit `patch` if it agrees.
- **Memory `archive` action** (issue #277): a fact can now be marked
  `archived` (still true, just deprioritized from automatic surfacing)
  distinct from `remove` (no longer true) -- same `memory__remember` tool,
  new `action` value.
- **Parameterized skill recipes** (issue #278): a skill can declare named
  inputs via a fenced ` ```skill-inputs ` block (mirroring the existing
  ` ```skill-script ` convention); `skill__view` surfaces them and
  `skill__run` accepts a matching `inputs` object, threaded into the
  sandboxed script as `inputs.<name>`.
- **Sandboxed diff-and-apply for coding-mode** (issue #276): a new
  `coding__propose_edit` tool drafts a proposed file change as a `.diff`
  file in a scratch location and hands back its path -- reuses the
  existing editor-workspace/edit-proposal machinery
  (`zed-integration.js`) that already backs the `/editors/*` admin routes,
  but never calls the file-writing `approveEditProposal` step itself, so
  node-bot never mutates a real source file through this path.
- **MFCC-based viseme lip-sync** (issue #275): `lip-sync.js` (both apps)
  now extracts real MFCCs (mel filterbank + DCT) from the same
  AnalyserNode data the old spectral-centroid heuristic used, and
  classifies each frame into a small "aa"/"ee"/"oo"/neutral viseme set
  from typical adult vowel formant bands -- drives Live2D's mouth-form
  parameter with priority over the older centroid-based heuristic
  (which stays as the fallback).
- **Ambient screen-sensing with an attention gate** (issue #272, off by
  default -- `plugins/screen-sensing`, `MANA_SCREEN_SENSING_ENABLED=1` in
  windows-launcher): a periodic (not continuous) screen glance routes
  through the existing local vision model for a one-sentence summary,
  discards the image immediately, and an attention gate skips near-duplicate
  glances, gaming mode, and enforces a cooldown -- only a genuinely new,
  worth-mentioning glance gets surfaced into the real chat log as a
  proactive message.
- **`.env`/credential-file access blocked from `read_file`** (issue #268
  part 1): the model-facing `read_file` tool's default `allowedRoot` is the
  repo root, which is exactly where `.env` lives -- a prompt-injected
  `read_file` call (hidden in a page Mana read or a doc she was asked to
  summarize) could otherwise read and exfiltrate real secrets through an
  otherwise-legitimate tool call. `ai/tool-policy.js` now refuses `.env`
  (and `.env.*` variants, excluding `.sample`/`.example`/`.template`),
  `credentials.json`, SSH private keys, and `.pem`/`.pfx`/`.p12` files
  regardless of `allowedRoot`. Part 2 (a local credential broker design for
  a future OAuth-gated plugin) is scoping-only --
  `docs/roadmap/issue-268-credential-broker-scoping.md`.
- **LLM-judgment dedup for `memory__remember`** (issue #264): the tool's
  description now includes a live snapshot of existing fact keys+previews
  (`acp-memory-store.js`'s new `listFactKeys()`), rebuilt fresh per reply,
  with an explicit instruction to reuse an existing key (`action: "patch"`)
  for an already-covered fact instead of always inserting a new one for a
  rephrased version of the same thing.
- **Deep Research subtask model-profile routing** (issue #269, opt-in): the
  short/structured `decompose`/`reflect` calls can now run on the `fast`
  profile instead of always matching `synthesize`/`compress`'s `quality`
  profile -- gated behind `MANA_DEEP_RESEARCH_SUBTASK_PROFILES=1`, off by
  default, since llama-server's model swap is multi-second and a
  reflect-cycle pass alternates enough that switching by default could
  cost more time than it saves on typical hardware.
- **Cursor-based re-summarization** (issue #263 part 2): session memory
  compaction now tracks a `lastSummarizedTurnIndex` cursor and only
  re-summarizes turns added since the last successful compaction, instead of
  always re-deriving from a fixed last-10-turn window regardless of what had
  already been compacted. Also fixes a pre-existing bug in the rolling
  `summary` field's truncation direction: it was keeping the *start* of the
  accumulated string, silently dropping the newest turn once the summary
  overflowed its char cap, instead of keeping the most recent content.
  Part 1 (hybrid keyword+vector search) remains deferred --
  `docs/roadmap/issue-263-hybrid-retrieval-scoping.md`.
- **ComfyUI split-loader workflow support** (issue #271): a second bundled
  ComfyUI workflow graph (`workflows/comfyui-txt2img-split.json`) for
  split-checkpoint models (FLUX, Qwen-Image, Mage-Flow -- separate
  `UNETLoader`/`CLIPLoader`/`VAELoader` instead of one combined
  checkpoint), selected via `MANA_IMAGE_COMFYUI_WORKFLOW=split` alongside
  the new `MANA_IMAGE_COMFYUI_UNET`/`_CLIP`/`_CLIP_TYPE`/`_VAE` env vars.
- **Shared `ChannelPlugin` pairing logic** (issue #265): extracted the
  near-identical pending/approved pairing-code store that
  `telegram-bridge.js` and `discord-bot.js` had each independently copied
  into `plugins/shared/channel-pairing-bridge.js`. Both plugins now
  delegate to it with zero behavior change (verified against their
  existing test suites); the actual messaging mechanism (Telegram
  long-polling vs. Discord's Gateway websocket) stays separate, since
  forcing that into one shape would be speculative generality, not a real
  simplification.
- **One generic tool-source composer** (issue #267): `ai/tool-source.js`'s
  `buildToolPolicy(basePolicy, toolSources)` replaces server.js's
  sequential `buildToolPolicyWithMcp` → `WithMemory` → `WithSessionSearch`
  → `WithSkillCreate` → `WithBrowserAutomation` chain with one call over
  an array. Each tool source now exposes `isKnownToolName` as an alias for
  its existing prefix-check export, so the next tool source needs no new
  `buildToolPolicyWithX` function at all. The individual `buildToolPolicyWithX`
  functions and their own tests are untouched for backward compatibility.
- **Real windows-launcher screenshot** (issue #137): `docs/images/windows-launcher-main.png`
  is now a genuine capture of the running app (via CDP `Page.captureScreenshot`
  against a real `windows-launcher` instance) instead of a hand-built HTML
  mockup, showing the actual Live2D avatar (Hiyori, Live2D's free sample
  model -- explicitly cleared for public use in `desktop-client/AVATAR_NOTICE.md`)
  and a seeded demo conversation.
- **Real desktop-client screenshot** (issue #137): `docs/images/desktop-client-main.png`
  is likewise now a real capture (same CDP technique, same Hiyori avatar,
  same seeded demo conversation), replacing its own mockup.

### Fixed
- **`heavy-ci.yml`'s `Collect installers` step looked for `.\dist` at the
  repo root instead of `.\desktop-client\dist`** (found immediately after
  the Node-version bump above let `Build installer` succeed for the first
  time ever in this repo's CI history -- so this step had simply never run
  successfully before, and the bug was never exposed). `electron-builder`
  runs from `working-directory: ./desktop-client` and writes its output to
  `desktop-client/dist`, but the next step has no `working-directory`
  override, so `Get-ChildItem -Path .\dist` resolved from the repo root and
  always came up empty (`Cannot find path 'D:\a\Mana\Mana\dist'`). Fixed the
  path to `.\desktop-client\dist`. Verified against this machine's own
  `desktop-client/dist` from an earlier real local build (issue #104-108),
  confirming that's genuinely where electron-builder places its output.
- **`heavy-ci.yml`'s `build-windows` job failed with `ERR_REQUIRE_ESM`
  because its Node pin was stale relative to `desktop-client`'s toolchain**
  (found right after the `tool-policy.js` fix above finally got
  `heavy-node-tests` fully green on `main` for the first time this session --
  a different, unrelated problem one stage further down the pipeline).
  `desktop-client`'s `electron-builder@26.15.3` pulls in `@noble/hashes@2.x`,
  which ships ESM-only; requiring it under the workflow's pinned Node
  `18.18.0` throws `ERR_REQUIRE_ESM`, and the `npm ci` log was full of
  `EBADENGINE` warnings for transitive deps now declaring `engines.node`
  requirements as high as `>=22.12.0`. Bumped both `actions/setup-node`
  `node-version` pins in `heavy-ci.yml` (the `heavy-node-tests` job and the
  `build-windows` job) from `'18.18.0'` to `'22'`. Left the *bundled* Node
  runtime version (`fetch_node_bin.ps1 -Version 18.18.0`, the Node that
  ships inside the packaged app to run `node-bot`) untouched -- that's a
  separate, deliberate product decision, not the CI toolchain's own version.
- **`tool-policy.js`'s `resolveWithinRoot`/`createToolPolicy` used native
  `path` on Windows-style test roots** (found immediately after merging the
  `pending-writes` fix above: `heavy-ci.yml` failed a *seventh* time on
  `main`, in `tool-policy.test.js` -- back to the same cross-platform-path
  bug class as the first five fixes in this chain). Unlike those, this
  module's real default root (`path.join(__dirname, "..", "..")`) is
  genuinely host-native and gets exercised by `server.js` on every test file
  that requires it, so blindly switching to `path.win32` everywhere risked
  breaking that real default on the Linux CI host. Instead, added a
  `pathImplFor(root)` helper (the same `WIN_DRIVE_OR_UNC_RE` foreign-path
  detection used in the very first fix, `acp-autonomous-loop.js`'s
  `resolveWithinRepo()`): if the root string looks like a Windows drive/UNC
  path, resolve it with `path.win32`; otherwise fall through to the host's
  own `path`, preserving the untouched default-root behavior exactly.
  `resolveWithinRoot`, `createToolPolicy`'s root resolution, and its
  `readFile`'s credential-basename check all route through this. Verified:
  full `node-bot` suite (89 files) passes locally, including `server.js`'s
  own `createToolPolicy({})` call with the real default root untouched.
- **`/admin/pending-writes/:id/approve` and `/reject` 500'd on a fresh
  checkout because `PENDING_DIR` was never created before writing into it**
  (found immediately after merging the `mana-acp-agent.js` fix above:
  `heavy-ci.yml` failed a *sixth* time on `main`, in
  `pending-writes-path-safety.test.js` -- a genuinely different, unrelated
  bug from the Windows-path chain above it). `node-bot/data/` is gitignored,
  so `PENDING_DIR` only existed on this dev machine because a year of local
  testing had already created it; a clean CI checkout has no such directory.
  The sibling `GET /admin/pending-writes` route already does `mkdir(PENDING_DIR,
  { recursive: true })` before reading it, but `/approve` and `/reject` went
  straight to `fs.promises.writeFile()`, so their very first real write threw
  `ENOENT` and got caught by the generic try/catch as a 500. Added the same
  `mkdir` call to both handlers. Verified by moving `data/pending_writes`
  aside locally to reproduce a clean-checkout state (test failed exactly as
  on CI), applying the fix, and confirming both tests pass with the
  directory absent; full `node-bot` suite (89 files) passes locally with the
  real local data directory restored afterward.
- **`mana-acp-agent.js`'s Zed config generator and agent path-limit parser
  used native path handling for Windows-only data** (found immediately after
  merging the `llama-server-runtime.js` fix above: `heavy-ci.yml` failed a
  *fifth* time on `main`, this time in `mana-acp-agent.test.js`, once
  `run_tests.js`'s alphabetical fail-fast finally got past the `l*` files).
  Two separate instances of the same bug class: `buildZedAgentServerConfig()`
  joined a Windows `repoRoot` with native `path.join` (the Zed editor
  external-agent config this generates is always consumed on the user's own
  Windows machine); and `getAgentLimits()` called `parseAllowedPathList()`
  (from the `acp-path-guard.js` fix earlier in this chain) without its
  `platform` argument, silently defaulting to `process.platform` -- on the
  Linux runner that meant splitting `MANA_AGENT_ALLOWED_PATHS` on `:`
  instead of `;`, so a single Windows path like `C:\Shared` got split into
  two bogus entries at its own drive-letter colon. Fixed by switching to
  `path.win32.join` and passing `platform: "win32"` explicitly, matching
  every other fix in this chain. Verified: full `node-bot` suite (89 files)
  passes locally.
- **`llama-server-runtime.js`/`local-llama-runtime.js` decomposed a Windows
  executable path with native `path.dirname`** (found immediately after
  merging the `acp-path-guard.test.js` fix above: `run_tests.js` exits on
  the first failing test file, so every earlier `heavy-ci.yml` run in this
  chain stopped at the `acp-*` files before ever reaching
  `llama-server-runtime.test.js` -- fixing those unmasked this pre-existing,
  fourth instance of the same bug class). `findLlamaServerBin()` built a
  candidate path via `path.join(path.dirname(env.LLAMA_BIN), ...)`, and
  `startServer()` passed the resolved binary's path to
  `path.dirname(bin)` for the spawned process's `cwd` -- both native calls,
  even though `LLAMA_BIN`/the binary path always names a Windows `.exe`
  (this module only supports the bundled Windows/CUDA llama-server build,
  never a cross-platform one). On the Linux CI runner, native
  `path.dirname("C:\\llama\\llama-cli.exe")` doesn't recognize `\` as a
  separator and returns `"."`, so the derived candidate stopped matching the
  real file and `findLlamaServerBin()` failed to find it. Twin-checked
  `local-llama-runtime.js`'s analogous `spawnSync(..., { cwd:
  path.dirname(llamaBin) })` and found the identical gap (confirmed via its
  own test's `LLAMA_BIN: "C:\\llama\\llama-cli.exe"` fixture, which would
  fail the same way once CI got that far). Switched all three sites to
  `path.win32.dirname`/`path.win32.join`, matching how these paths are
  always meant to be interpreted regardless of host OS. Verified: full
  `node-bot` suite (89 files) passes locally.
- **`acp-path-guard.test.js` built its own expected values with native
  `path.resolve`/`path.join`** (found immediately after merging the
  `acp-path-guard.js` fix above: the merge's push-event `heavy-ci.yml` run
  failed a *third* time, on `main`, right after the second fix had just gone
  green on its own PR). The module fix above made `acp-path-guard.js` itself
  correctly use `path.win32` for `platform: "win32"` -- but the test file's
  assertions still compared that against values built with the host-native
  `path`, so on the Linux runner the "expected" side stayed POSIX-resolved
  while the (now-correct) "actual" side was genuinely Windows-resolved. Two
  tests that happened to be *consistently* wrong on both sides before (so
  they passed by accident) started failing once only one side got fixed.
  Switched every `path.join`/`path.resolve` in this test file to
  `path.win32.join`/`path.win32.resolve`, matching the `platform: "win32"`
  every test in the file already declares. Verified: full `node-bot` suite
  (89 files) passes locally; this file's own 5 tests build no host-dependent
  strings anymore, so they should read identically on the CI Linux runner.
- **`acp-path-guard.js` claimed a testable `platform` option but only honored
  it for splitting `allowedPaths`** (found immediately after merging the
  `acp-autonomous-loop.js` fix above: that merge triggered a real push-event
  `heavy-ci.yml` run on `main`, which failed again -- a second, previously
  undiscovered instance of the same bug class in a different module). Its
  `isInsideRoot()`/`resolveAllowedPath()` called the global, host-native
  `path.resolve`/`isAbsolute`/`relative` directly instead of respecting the
  `platform` constructor option, so `platform: "win32"` only worked by
  accident when the actual host also happened to be Windows -- on the Linux
  CI runner, 3 of 5 `acp-path-guard.test.js` tests failed (Windows-style
  absolute paths misread as relative, so an outside path silently resolved
  as if it were nested inside the workspace/allowed root). Switched all path
  operations in the module to `path.win32`/`path.posix` based on `platform`
  (`pathImpl()` helper), matching what `parseAllowedPathList()` already did
  -- makes the module's behavior deterministic regardless of host OS, as its
  own `platform` option always implied it should be. Not yet wired into any
  production code path (`createAcpPathGuard`/`isInsideRoot` are currently
  only exercised by their own test file), so this has no runtime behavior
  change today, only fixes the test-vs-CI-host mismatch. Verified: full
  `node-bot` suite (89 files) passes locally.
- **`acp-autonomous-loop.js`'s `file_read`/`file_write`/`dir_scan` path guard
  accepted foreign-OS absolute paths as if they were relative** (found while
  preparing a release: `heavy-ci.yml`'s full test suite had been failing on
  every push to `main` since before this file's Unreleased section started,
  silently blocking the Windows installer build job that depends on it).
  `path.isAbsolute()` only recognizes the *host OS's own* absolute-path
  syntax -- on a POSIX CI runner, a model-supplied path like
  `C:\Windows\system.ini` isn't recognized as absolute, so it fell through
  to the "treat as relative" branch and got silently joined onto
  `REPO_ROOT` instead of being rejected as foreign/absolute. Since these
  paths come from untrusted model tool-call output, the guard needs to
  reject cross-platform absolute-path syntax regardless of which OS
  actually runs it, not just the host's own -- added a shared
  `resolveWithinRepo()` helper (replacing three copies of the same
  vulnerable inline logic) that explicitly rejects Windows drive-letter/UNC
  syntax the host doesn't recognize natively, used by all three tools plus
  `dir_scan`'s pagination-token `root` field (same class of gap). Verified:
  full `node-bot` suite (89 files), `windows-launcher` (129 tests),
  `desktop-client` (26 tests), and `plugins/**` (287 tests) all pass.
- **windows-launcher's research-progress indicator ignored its own
  `hidden` attribute** (issue #137, found while capturing real README
  screenshots): `#researchProgress { display: flex; ... }` in
  `renderer/index.html` outranks the browser's built-in
  `[hidden] { display: none }` rule, so the "Researching... / Cancel"
  status bar rendered permanently regardless of whether a research job
  was actually running. Added `#researchProgress[hidden] { display: none; }`
  so the element actually respects being hidden.
- **desktop-client's startup screen hung forever on "AI: Starting..."**
  (issue #137, found capturing the desktop-client screenshot): Electron
  defaults `sandbox: true` for any window with a preload script regardless
  of `contextIsolation`, which restricts the preload's own `require()` to a
  small built-in allowlist. `preload.js`'s `require('./renderer/markdown-render')`
  (and the artifact window's `dompurify`/`markdown-render` requires) threw
  `module not found` under that restriction, silently aborting
  `contextBridge` setup before `window.electronAPI` was ever exposed --
  every renderer call depending on it (including the startup sequence)
  then failed with `Cannot read properties of undefined`. This has likely
  been broken since the Electron 26 -> 39 bump earlier in this file, which
  predates sandbox defaulting to true for preload-bearing windows. Fixed
  by setting `sandbox: false` on both the main and artifact `BrowserWindow`s
  in `main.js`, restoring the preload script's normal Node module
  resolution while leaving `contextIsolation`/`nodeIntegration` (the
  renderer's own isolation) untouched.

### Investigated, no code change
- **Issue #197** (Deep Research reflect-on-gaps step): already fully
  implemented and on `main` (`tools/deep-research.js`'s reflect-cycle loop,
  commit `c4598e5`) -- closed as done.
- **Issue #266** (subagent result delivery mechanism): reviewed
  `tools/subagent-delegation.js`'s bounded-concurrency runner against the
  issue's own friction checklist -- stable position-based result delivery,
  total task isolation, already reused cleanly by #197's reflect cycle, no
  existing event-bus to piggyback on. No real friction found; closed with
  findings instead of a scope-creep redesign.
- **Issue #263** (hybrid keyword+vector memory retrieval + cursor
  resummarization): both parts now implemented -- see Added, above. The
  storage-scale question from the original scoping is also answered
  directly: SQLite stays sufficient at Mana's actual scale (issue #220's
  verified benchmark).
- **Issue #258**: a deliberately-parked "not scheduled" reference issue that
  already contains its own complete investigation write-up (mobile app
  architecture scoping). Confirmed correctly camped in Backlog, left as-is.

### Security
- Cleared all 98 open Dependabot alerts: bumped `multer` (1.x -> 2.x),
  `electron-builder`/`app-builder-lib`/`builder-util-runtime` (24.x -> 26.x),
  `esbuild`, `requests`, `python-multipart`; overrode the dead-weight
  `gh-pages` transitive dep pulled in by `pixi-live2d-display` and the
  unreachable `@hono/node-server` pulled in by `@modelcontextprotocol/sdk`.
  (`torch` was initially left pinned to `2.6.0` here because
  `chatterbox-tts==0.1.7` hard-required that exact version -- see below,
  since removed, so this no longer applies.)
- Fixed all 70 open CodeQL alerts: added an app-wide rate limiter
  (`express-rate-limit`) covering every node-bot route; gated the
  editor/workspace-control routes (`/zed/*`, `/editors/*`) behind admin auth
  after finding they were reachable unauthenticated with CORS wide open;
  added path-traversal validation to the pending-writes admin routes and
  `resolve_voice_ref` (tts-service); fixed a genuine ReDoS-shaped ambiguous
  regex in the mobile auth header parser and three others; fixed a real
  double-unescaping bug in `web-access.js`'s HTML-entity decoding; switched
  `auth-store.js`'s API-key hashing to salted scrypt with a migration path
  for existing accounts; added explicit `permissions:` blocks to all GitHub
  Actions workflows; and more (see PR for the full list).
- Bumped `electron` from 26.x to 39.8.10 in both `windows-launcher` and
  `desktop-client`, closing the remaining 34 Dependabot alerts. Verified by
  launching both apps and checking for real errors, and a full
  `electron-builder` packaging build for `desktop-client`.

### Removed
- **Chatterbox TTS provider**, at the user's request: deleted
  `tts-service/service.py` and `start.ps1`, and every `chatterbox`
  reference across `tts-runtime.js`, `server.js`, `doctor.js`, the
  `windows-launcher` process-management/UI code, and docs. This also
  freed `tts-service/requirements.txt`'s `torch`/`torchaudio` pins
  entirely (nothing else there needed them -- `kokoro-onnx` only needs
  `onnxruntime`), which is what was blocking the remaining torch
  Dependabot alerts.

### Fixed
- **`tools/script-runner.js`'s vm sandbox was not actually a security
  boundary** (found reviewing the new `skill__run` tool, but the bug
  predates it and affects every script run through this primitive since
  issue #142): any object or function value injected into the sandbox --
  the `tools` proxy, `console`, `setTimeout`/`clearTimeout`, the previously-
  injected `Promise` -- kept its outer-realm `.constructor` chain, so
  `injectedValue.constructor.constructor("return process")()` compiled and
  ran code in the real parent process with full `require`/`fs`/`process`
  access, completely outside the vm context. Verified empirically (a PoC
  script returned the real `process` object) before landing the fix:
  `script-runner-worker.js` now recursively strips the prototype off every
  value crossing into the sandbox (including the sandbox object itself, to
  close the same escape via `this`/`globalThis`) and no longer injects the
  outer `Promise` at all (a fresh vm context already has its own). New
  regression tests exercise the exact escape pattern against the real
  forked worker, not a mock.
- **Skill-write review, closed for real** (multi-pass review of #270):
  `skill__create` (the conversational tool) no longer auto-decides itself
  -- a model-drafted skill is the model's own inference of what the user
  meant, not their verbatim words, and auto-approving it was the one place
  "approval-gated" and "not actually gated" diverged, especially with
  browser-automation live in the same tool policy. The idle-triggered
  autonomous proposal pass now uses its own `skill-write-idle` action type
  (an "always-allow" on a manual write no longer silently disables review
  for proposals nobody's looked at), skips re-proposing a pattern that's
  already sitting pending, and neuters literal `BEGIN/END SUMMARIES` text
  inside a session summary before it reaches the prompt. `serializeSkillFile`
  now rejects embedded line breaks in name/description/category (previously
  unescaped, so LLM-generated content could inject bogus frontmatter keys),
  and `createSkill`'s duplicate check compares the actual target filename
  instead of the exact display name, closing a case-insensitive
  silent-overwrite bug ("Restart SearXNG" vs "restart searxng" both
  slugify to the same file). Settings > Skills now has a pending-review
  list (Approve/Deny) for anything that stays genuinely pending, visible
  errors on save/delete instead of console-only, a `touch:false` option so
  opening Edit and cancelling doesn't silently un-stale a skill, and
  `runSkillProposal`'s core logic moved to its own module
  (`skill-proposal.js`) specifically so it's directly unit tested instead
  of only reachable through a fully-mocked route -- which caught a real
  latent bug in the process: eager construction exposed that `runOpenAIReply`
  was never actually in scope where the idle pass called it, a
  ReferenceError that would have crashed the remote-AI path the first time
  it fired.
- **Skill-write review, round 3** (further review of #270): `approval-gate.js`'s
  `decide()` no longer deletes a pending entry until its executor actually
  succeeds, so a failing "skill-write" write (disk full, bad payload) leaves
  the request retriable instead of silently disappearing. The idle proposal's
  duplicate check now also compares against pending *manual* `skill-write`
  requests, not just other idle ones. `PATCH /skills/:name` 400s when
  `category` is neither a string nor `null` instead of silently no-op'ing.
  `contentScanEnabled` (the optional shell/fs/credential-pattern flagger) is
  now a real opt-in via `MANA_APPROVAL_CONTENT_SCAN_ENABLED=1`, still off by
  default. Settings > Skills now polls the pending-review list every 15s in
  both apps, so a proposal staged while the panel just sits open actually
  shows up. Added an integration test that boots the real `createApp()` and
  drives `/skills/propose` and the real `skill-write-idle` executor end to
  end -- the exact kind of test that would have caught the `runOpenAIReply`
  scope bug above without needing a live server to notice it.

### Added
- **Skills, closer to how Claude's own Skills feature works** (comparison
  review of #270): a small always-visible `[AVAILABLE SKILLS]` index
  (name+description of every active skill) is now injected straight into
  the system prompt, independent of `contributePluginPromptContext`'s
  "first plugin wins" contest -- the existing keyword-match full-body
  auto-injection stays as a fallback, unchanged. A new `skill__view` tool
  lets Mana pull a matched skill's full body on demand instead of relying
  only on the keyword heuristic to guess relevance for her. A skill's body
  can now optionally embed one fenced ` ```skill-script ` block --
  deterministic code for the procedure's mechanical part -- and a new
  `skill__run` tool executes it through `tools/script-runner.js`'s existing
  sandbox (no filesystem/network access of its own) instead of the model
  re-deriving the same steps by reasoning every time. Both the idle
  proposal prompt and `skill__create`'s description field now explicitly
  ask for a specific, assertive "when to use this" sentence instead of a
  vague summary, since that description is the only thing the new index
  shows. Skills also track `useCount` now (bumped whenever `skill__view` is
  called, or a skill's script actually runs via `skill__run`; note the
  Settings UI's own Edit panel deliberately does *not* bump it, same
  `touch=false` reasoning as browsing without un-staling) so an
  approved-but-never-used proposal is visibly flagged `(unused)` in both
  apps' skill picker instead of being indistinguishable from a genuinely
  useful one.

### Added
- **Conversational skill creation** (issue #262 follow-up): a new
  `skill__create` model tool lets Mana save a skill when the user directly
  asks mid-conversation ("make a skill that does X"), distinct from the
  idle-triggered autonomous proposal pass below. Stays genuinely pending
  for review in Settings > Skills, same as the idle pass -- see Fixed,
  above, for why this doesn't auto-decide. The tool's description also
  asks Mana to quote the saved skill back in a fenced markdown block in
  her reply -- no new backend plumbing needed, that's exactly what issue
  #148's existing
  renderable-artifacts detection already turns into an openable preview.
- **Settings > Skills UI** (issue #262 follow-up): create, edit, and delete
  skills directly from Settings in both windows-launcher and desktop-client,
  backed by the new `updateSkill`/`deleteSkill` methods on `skills-store.js`
  and matching `PATCH`/`DELETE /skills/:name` routes. Unlike `POST /skills`,
  these direct edits/deletes aren't approval-gated -- a Settings form
  submission already is the human decision the gate exists to require for
  agent-authored writes. Creating a skill still goes through the same
  `approval-gate.js` path the idle-triggered proposal pass uses; since a
  human is right there filling out the form, a "pending" response is
  auto-approved client-side instead of surfacing a second confirmation step.
- **Idle-triggered skill proposal** (issue #262): a new pass in
  `triggerIdleConsolidation` reviews recent session summaries for a
  genuinely reusable, repeated multi-step workflow and stages -- never
  writes directly -- a new skill proposal through the existing
  `approval-gate.js` skill-write path (issue #152). Closes the gap where
  skill creation existed in storage/approval form but nothing ever
  triggered it. Conservative by design: skipped when fewer than 5 recent
  session summaries exist, skipped when an existing skill already covers
  the pattern (reuses `findMatchingSkill`), and disableable via
  `MANA_SKILL_PROPOSAL_MODE=off`. Manual trigger at `POST /skills/propose`
  mirrors the existing `/skills/prune` pattern for Doctor-panel/test use.
- **Full-text session search** (issue #260): new `session-search-index.js`
  -- a SQLite FTS5 index over
  every past conversation turn's raw text, independent of the curated
  summary `acp-memory-store.js` already kept. Wired into `appendTurn()`
  (fire-and-forget; an indexing failure never breaks the actual
  conversation), exposed as `acpMemoryStore.searchSessions()` and a new
  `session_search` tool the model can call mid-reply for "what did I say
  about X" / "where did we leave off with Y" questions the curated summary
  doesn't cover. Requires the new `better-sqlite3` dependency.

### Changed
- **Memory writes now stage for approval, same as skill writes** (issue
  #260, follow-up to #152/#198): the model-initiated `memory__remember`
  tool used to write directly; skill writes already staged for human
  approve/reject via `approval-gate.js`. Now memory writes go through the
  same gate when one is wired in (callers/tests that don't wire a gate keep
  writing immediately, unchanged).
- **Background memory review runs on a separate, cheaper model profile**
  (issue #260): `runBackgroundReviewer` always called the local model on
  the same `"default"` profile as a live reply. New `background` entry in
  `LLAMA_MODEL_PROFILES` (prefers the smallest available model, same
  preference list as `fast` but a distinct concern from it -- a low-RAM
  main-brain choice and a background-only choice aren't the same thing
  even when they happen to pick the same model file). Overridable via
  `MANA_BACKGROUND_REVIEW_PROFILE`.
- Investigated (not adopted) Honcho, a pluggable "dialectic" user-modeling
  memory backend -- full pros/cons in
  `docs/roadmap/issue-260-honcho-vs-manas-memory.md`. Recommendation:
  Mana's current memory design plus the new FTS5 search already covers the
  gap Honcho would fill, with far less operational complexity; revisit
  only if keyword search proves insufficient for real recall (in which
  case local embeddings -- issue #195 already evaluated a backend for this
  -- are the better next step, not an external service).
- **VRM avatar parity fixes, ported from Project AIRI's stage-ui-three**
  (issue #257): the VRM renderer had no auto-blink, instant (unblended)
  expression snaps, no idle eye movement, frustum culling left on, and no
  FPS cap. Added a manually-timed blink (VRM has no built-in blink manager
  the way Cubism/Live2D does), a 300ms eased expression crossfade
  (replacing an instant zero-then-one snap that AIRI's own history cites
  fixing for the same "too raw" complaint), idle eye saccades reusing the
  exact same randomized-interval distribution already shipped for Live2D,
  disabled frustum culling (an always-animated character's rest-pose
  bounding box goes stale once bones move), a VRM-version facing-direction
  correction, and multi-shape mouth blending (aa/ih/ou) reusing the
  spectral-centroid signal from the Live2D mouth-form work instead of a new
  wlipsync dependency. Also capped VRM's render loop to the same
  `MANA_AVATAR_FPS` Live2D already respects -- it had no cap at all
  previously. No VRM model is present in this checkout to visually verify
  against; every new pure function has full unit test coverage instead.
- **Live2D model reference validation, ported from Project AIRI** (issue
  #255, follow-up to #253): a broken/incomplete model (missing texture,
  deleted Moc, a typo'd Expression path) now produces a clear "here's
  what's missing" list before `Live2DModel.from()` fails deep inside
  pixi-live2d-display. New `validateModelReferences` checks every file
  model3.json references -- Moc/Textures are fatal (falls back to sprites,
  same as "no model found"); Physics/Pose/DisplayInfo/individual
  Expression/Motion files are non-fatal (logged as a warning, model still
  loads). AIRI's own validator also checks zip-upload-specific concerns
  (basename collisions, case-sensitivity from a zip's stored paths) that
  don't apply to Mana's folder-based model discovery -- only the portable
  existence-check part was ported.
- **Switched the default avatar model from `huohuo2` to Live2D's official
  free Hiyori sample** in `windows-launcher` (`desktop-client` was already
  on Hiyori). `huohuo2` was never committed to the repo; moved to a new
  gitignored `avatar/model-disabled/` rather than deleted, so it's
  recoverable. Checked whether Project AIRI itself ships a distinct "AIRI"
  character model -- it doesn't; their own default avatar is the same
  Live2D free Hiyori sample.
- **Live2D idle saccades and mouth shape, inspired by Project AIRI** (issue
  #252): the idle "looking around" drift was a fixed-period sine wave that
  read as mechanical over a long idle stretch; replaced with AIRI's
  `eye-motions.ts`-style randomized saccade timing (mostly quick 0-800ms
  glances, tailing into rarer longer holds, modeled on real human
  microsaccade statistics). Also added a spectral-centroid-driven
  `ParamMouthForm` signal (new `mouthFormParam`/`mouthFormGain` tuning
  knobs, default gain 0.6) so talking varies mouth *shape*, not just
  openness -- reuses the `AnalyserNode` the lip-sync pipeline already
  creates for RMS rather than adding AIRI's `wlipsync` WASM dependency,
  after finding AIRI's own Live2D integration only consumes a single mouth-
  open scalar too. Landed in both `windows-launcher` and `desktop-client`.
  Also added a PixiJS render-loop guard (found in the same AIRI review) so a
  bad frame stops the ticker cleanly with a log line instead of a silent
  crash loop. Beat-sync head-sway, an LLM-callable expression-tool system,
  and a Live2D model validator were also found in AIRI's code but scoped
  out as future ideas (issue #253), not implemented here.
- **Enabled `torch.compile` for the Fish Speech TTS service** (issue
  #213): `start_fish_speech_wsl.sh` now passes `--compile` (an existing
  upstream flag Mana never enabled). Measured on the dev machine (RTX
  3070 Ti): ~2.5 tokens/sec baseline vs ~31 tokens/sec steady-state --
  roughly 12x, at negligible extra VRAM cost. Trade-off: `torch.compile`
  is lazy, so the first generation *request* after each service (re)start
  pays a one-time ~4 minute compile trace. Requires a C compiler for
  Triton's codegen (`sudo apt-get install -y build-essential` in the WSL
  distro if missing). Not yet surfaced in the startup loading screen --
  tracked separately.
- `desktop-client`'s sidebar had Avatar/Web access/Market watch/Vision/
  Model/Doctor as top-level buttons alongside Settings; moved them inside
  Settings (a new "Status" section) to match `windows-launcher`, where
  they'd already been nested there since the issue #138 UI overhaul.
- **Redesigned the Mana Crystal mark** (issue #238): the flat, evenly-lit
  3-triangle mark is now a smaller gem surrounded by 8 small drifting
  motes (concept "AG" from an extended multi-round concept review with the
  user, including live research into Obsidian's own logo technique).
  Updated everywhere it appears -- both apps' sidebar logo and startup/
  shutdown overlays, the runtime window/tray icon, the packaged `.exe`
  icon, and the README banner. The gem still uses each file's theme
  accent variables where applicable; only the motes are fixed-color.
- **Upgraded the Mana Crystal gem to an organic low-poly render** (issue
  #240, follow-up to #238): the gem's 3 flat triangles were still
  obviously simple vector shapes at larger sizes. Now a ~24-facet
  deterministic mesh with per-facet brightness variation and a soft blurred
  highlight bloom instead of crisp stroke lines, so it reads as an actual
  cut gem. The sidebar/startup/shutdown markup uses
  `color-mix(in srgb, var(--accent), black/white N%)` per facet instead of
  fixed colors, so shading stays correct on both the dark and light theme
  presets (plain opacity dimming would have inverted on light backgrounds).

### Added
- **Graceful quit with a closing progress screen** (issue #228,
  `windows-launcher`): quitting used to be silent and instant --
  `app.on("quit", ...)` just called `.kill()` on every child process with
  no UI, and by the time that handler ran the window was already gone.
  Now intercepts both the window's own close (the X button) and
  `before-quit` (the tray's "Quit" item, `window-all-closed`), reuses the
  exact same startup-screen markup in reverse ("Closing Mana" /
  "Shutting down...", Backend/Voice/Web search/Local AI rows going from
  Stopping to Stopped), and holds the app open until each service actually
  exits -- gracefully, via node-bot's existing `POST /admin/shutdown`
  route for Backend/Local AI (releases llama-server's VRAM/RAM before it
  exits, since Windows can't deliver a catchable signal via a plain
  `kill()` and would otherwise orphan `llama-server.exe`), and kill+wait
  for Voice/Web search. Bounded overall (15s) so a hung process can't
  leave the app stuck open. Ports `desktop-client`'s already-shipped
  version of this same feature; along the way, fixed two real pre-existing
  bugs found while researching it: `desktop-client/main.js` was passing
  `process.env.ADMIN_SECRET` (never set by anything) instead of the actual
  `MANA_ADMIN_SECRET` node-bot checks, silently 401ing every graceful
  shutdown attempt for any user who'd actually configured that secret; and
  `windows-launcher`'s own old quit handler referenced an undeclared
  `fallbackTtsProcess` variable, throwing partway through and meaning
  `retrieverProcess`/`fallbackKokoroProcess`/`searxngProcess`/
  `embedderProcess` never actually got killed via that path.
- **Voice barge-in, phase 1: hotkey interrupt** (issue #219): a global
  hotkey (`Control+Alt+I` by default, `MANA_INTERRUPT_HOTKEY` to change or
  `off` to disable) lets the user cut Mana off mid-speech in
  `windows-launcher`. `listenLoop()` deliberately pauses mic recording while
  Mana is speaking (avoids the mic hearing Mana's own voice through the
  speakers), so a manual interrupt is the low-risk way to let the user cut
  in without needing real echo cancellation. Reuses the existing
  `stopReplyAudio()` renderer function; `desktop-client` has no
  speech/listening loop so this is windows-launcher-only.
- **Voice barge-in, phase 2: talk-over-Mana interrupt** (issue #219, on by
  default -- `MANA_BARGE_IN_VOICE=0` to fall back to hotkey-only): while
  Mana is speaking, watches the mic (reusing the same stream and Silero VAD
  as normal listening) and interrupts her once real speech has held for
  `MANA_BARGE_IN_HOLD_MS` (350ms default) continuously, via the same
  `stopReplyAudio()` phase 1 uses. Leans on `getUserMedia`'s default
  echo-cancellation constraint (already active today for every mic capture)
  plus the hold-time gate to reject echo/pop blips rather than adding new
  echo-cancellation code. Not verified against real speakers/mic in this
  session -- there's no way to drive live audio hardware here, only to
  verify the wiring and the pure hold-time logic (new tests in
  `voice-endpointing.test.js`). Shipped opt-in at first for that reason;
  turned on by default at the user's request -- if Mana ever cuts herself
  off on her own echo, raise `MANA_BARGE_IN_HOLD_MS` first.
- **Compress retriever-index.js search snippets instead of flat
  char-truncation** (issue #211, follow-up from #208): `search()`'s three
  branches (tf-fallback, embedding-similarity, embedding-query-failure
  fallback) each did their own duplicated read-file-then-`slice(0, 800)`
  work -- now one shared `buildSnippets()` helper, reusing #208's own
  `buildCompressPrompt`/`parseCompressedExcerpts` so both surfaces share
  the same batching/parsing logic. Wired into the coding-mode
  repo-retrieval block in `server.js` (the one real model-facing consumer
  of these snippets); `retriever-admin-capability.js`'s debug route is
  left untouched since a human debugging the index wants the raw
  ground-truth snippet, not a query-shaped summary.
- **Compress Deep Research excerpts instead of flat char-truncation**
  (issue #208, follow-up from #200): a new opt-in `compress` step condenses
  each newly-read source's excerpt down to what's relevant to the research
  question, one batched LLM call per search cycle covering every source
  read in that cycle rather than one call per source. Falls back to the
  original (flat-truncated) excerpt if `compress` isn't provided, doesn't
  cover a given source, or the call itself fails -- a research pass never
  breaks over a compression failure.
- **Explicit hot-path memory tool + update policies** (issue #198): a new
  `memory__remember` tool-calling action (`{key, text?, action?}`) lets
  Mana explicitly save, patch, or forget a specific fact mid-reply --
  distinct from the passive automatic entity-mention index and idle
  consolidation, which only ever inferred and inserted, never updated or
  removed anything. New `acp-memory-store.js` explicit-facts store
  (`data/acp-memory/facts.json`) with a real `insert`/`patch`/`remove`
  lifecycle (soft-delete via a `stale` status, not hard deletion); active
  facts surface under a new "Remembered:" block in the existing
  `getRelatedFacts()` injection point alongside entity mentions. Wired
  into the same tool-merge chain (#169/#188) and audit log (#188) every
  other tool source already uses.
- **Reflect-on-gaps step for Deep Research** (issue #197): after the
  initial report synthesizes, an opt-in `reflect` step asks the model for
  a structured decision -- one specific search query to close a genuine
  gap, or "NONE" -- and, if a gap is found, runs one more bounded
  search-and-read cycle (capped at `maxReflectCycles`, default 1, hard cap
  2) before re-synthesizing, rather than the old single-pass-only loop.
  Each source is now tagged with which cycle found it. Inspired by
  `langchain-ai/local-deep-researcher`'s search-reflect-repeat loop, not a
  LangGraph/LangChain adoption.
- **Real GGUF metadata parsing** (issue #196): a new `GET /models/gguf-metadata`
  route (on-demand, kept separate from the frequently-polled
  `/models/status` since real header parsing is real file I/O) uses
  `@huggingface/gguf` to read a model's actual architecture, quantization,
  context length, and computed parameter count, instead of only validating
  the 4-byte magic bytes as before. The magic-byte check (issue #125)
  stays the fast first-pass gate, unchanged.
- **Evaluated text-embeddings-inference (TEI) as the local embedder backend**
  (issue #195) -- **not adopted**: TEI has no official native Windows
  build (Homebrew binary is Apple-Silicon-only, everything else is Docker
  or a from-source CUDA-kernel compile), which doesn't fit Mana's
  Windows-native, no-Docker-dependency toolchain. The investigation still
  surfaced a real, low-risk fix: `computeEmbeddings()` in
  `tools/retriever-index.js` now accepts either the wrapped
  `{embeddings: [...]}` shape `local_embedder.py` returns or a bare
  `[[float,...],...]` array (TEI's actual shape, and a more common
  convention generally) -- previously it silently returned nulls against
  anything but the wrapped shape.
- **Passive web context** (issue #189, `context-push` plugin +
  `context-push-extension` browser extension, both off by default): a new
  Manifest V3 Chrome/Edge extension reads the current page's text (and,
  on YouTube, visible captions) and pushes it to a new loopback-only
  `POST /context/push` route, so Mana can answer "what does this page say"
  or "what am I watching" when asked -- ephemeral only (2-minute expiry,
  never written to memory), and only contributed to a reply when the
  message actually references the current page/video. Always-on once
  enabled, with a non-negotiable indicator (toolbar icon color swap,
  green/grey) and a one-click, restart-persistent off switch, plus a
  first-install onboarding page explaining the behavior before capture
  ever starts.
- **Speech recognition accuracy improvements** (issue #4): fuzzy wake-word
  matching catches close Whisper mis-transcriptions of "Mana" (e.g. "Manaa",
  "Mona") the exact word list can't enumerate; a new microphone gain step
  boosts quiet clips before Whisper sees them, rescuing soft-spoken speech
  without loosening noise-rejection thresholds; those thresholds
  (`MANA_MIN_SPEECH_RMS`/`MANA_MIN_SPEECH_PEAK`/`MANA_MAX_CLICKY_ZCR`) and a
  new `WHISPER_MODEL_PROFILE` (tiny/base/small/medium) knob are now
  configurable via env vars; and a per-session `speech-debug.log` persists
  transcription debug events to disk for after-the-fact diagnosis.
- **Discord voice channel support** (issue #187, `discord-bot` plugin): send
  `!join <channelId>` in an already-paired DM and Mana joins that voice
  channel, transcribes each speaker with Whisper (a new async,
  FIFO-serialized `whisper-queue.js`, since the existing `/transcribe`
  route's `runWhisper` is blocking and unsafe to share), replies through the
  same pipeline DM text already uses, and speaks the reply back with full
  TTS (provider switching, VTube reactions, captions -- newly exposed via
  `capabilityContext.synthesizeReply`). Barge-in comes free from Discord's
  own speaking-start signal (stop in-progress playback the moment a new
  speaker starts) rather than needing new detection logic. Also corrects a
  wrong assumption in the issue's own original scope: `@discordjs/voice`
  already provides silence-based endpointing
  (`EndBehaviorType.AfterSilence`), so no custom VAD needed to be built.
  Along the way, found and fixed an npm optional-peer-dependency trap where
  `prism-media` silently pulled in `@discordjs/opus`'s unpatched critical
  CVE chain even after switching to `opusscript`; `.npmrc`'s `omit=optional`
  plus a fresh lockfile closed it (`npm audit --omit=dev`: 0
  vulnerabilities).
- **Unified tool-execution audit/approval layer** (issue #188): every tool
  call Mana makes during a reply -- local `read_file`, browser-automation,
  or a remote MCP tool (#169) -- now shares one audit trail
  (`GET /tool-calls/recent`, JSON-lines on disk) regardless of source.
  `browser-automation`'s navigate/click/type/snapshot are now also
  available as tool-calling actions (not just HTTP routes), gated behind a
  one-time approval the first time they're used as a tool -- after that,
  calls execute immediately, same as any other already-trusted approval-
  gate action.
- **Outbound MCP client** (issue #169): Mana can now connect *outward* to
  third-party MCP servers and use their tools, not just expose her own
  capabilities as a server (`mcp-server.js`). New `mcp-client-registry.js`
  -- per-server tool allowlisting, an env-var allowlist for stdio-spawned
  servers (starts from the SDK's safe default environment, never
  `process.env`), and registration routed through the approval gate
  (#152) with a uniquely-scoped decision per server. Also fixes a real bug
  found while wiring this in: the tool-calling loop
  (`runToolAwareReply`) called `executeTool()` without awaiting it --
  harmless for the one existing synchronous tool, but would have silently
  corrupted every async MCP tool result into the literal string
  `"[object Promise]"`.
- **Configurable backend URL** (issue #190, `windows-launcher`): the
  hardcoded `http://localhost:5005` (32 occurrences across `main.js` and
  three renderer files) is now a persisted setting (Settings >
  Connection) -- the first step toward pointing the Electron client at a
  remote `node-bot` instead of only a co-located one. `main.js` no longer
  spawns a local `node-bot` child process when the configured backend is
  remote. Takes effect on next launch, not live.
- **"Use Remote AI" brain provider**: a toggle under Model Selection (both
  apps) opening a provider dropdown (OpenAI/OpenRouter/Groq/Ollama/LM
  Studio/Custom, sourced from `GET /models/brain-providers` so the two
  apps' dropdowns can't drift apart), an API key field, and a "Connect"
  button that actually tests the endpoint (`POST /models/brain-provider/test`)
  before saving. `shouldUseRemoteAi` already exempted local/LAN endpoints
  from the remote-AI consent gate; this is the Settings UI for it.
- **`document-reader` plugin**: ingest a local PDF or a specific web page
  into Mana's existing memory retriever, so she can recall and cite it in
  replies. Reuses the retriever end-to-end (no new vector store) and
  `web-access.js`'s SSRF-guarded `fetchPage` for URL ingestion.
- Subtle idle "looking around" drift (head + eyes) for the Live2D avatar,
  in both apps -- separate, independently-configurable knob from the
  existing sleepy idle-tilt (`idleGazeDeg`/`idleGazePeriodMs` in
  `mana-avatar.json`, 0 opts out).
- `acp-memory-store.js`'s `getRelatedFacts()` (issue #141): a bounded,
  on-demand lookup that surfaces facts from *other* sessions when the
  current message names an entity previously discussed elsewhere, reusing
  the existing entity index (issue #78). Capped independently
  (`MANA_RELATED_FACTS_MAX_ENTITIES`/`MANA_RELATED_FACTS_MAX_CHARS`) so it
  never grows with total memory volume -- the on-demand half of the
  two-tier memory design alongside the existing always-injected summary.
- **`tools/script-runner.js`** (issue #142): a general-purpose primitive
  for running a generated script in an isolated child process with a
  whitelisted set of tool functions it can call (round-tripped over IPC to
  the real implementations) -- no `require`/`fs`/network access of its
  own. Not yet wired into a specific capability; see the roadmap doc for
  why Deep Research (the issue's suggested first caller) didn't need it.
- **`persona.js`** (issue #143): Mana's identity now lives in exactly one
  place (`MANA_PERSONA`), replacing four drifting hand-copies scattered
  across `local-llama-runtime.js` and three separate per-mode prompts in
  `server.js`. Adds a session-scoped temporary override
  (`POST /persona/override` / `POST /persona/override/clear`) for a
  one-off mode switch that reverts cleanly without editing the base file.
- **`cron-scheduler` plugin** (issue #144): run a script action or a full
  agent prompt on a fixed interval or daily-at-time schedule, independent
  of chat or idle activity. Results deliver as a chat turn via the
  existing `acpMemoryStore.appendTurn`, visible in the Sessions list UI
  with no new frontend work. Off by default -- enable in Settings > Plugins.
- **`tools/subagent-delegation.js`** (issue #145): a flat, capped-concurrency
  task-delegation primitive. Deep Research's source-reading step now reads
  up to `maxConcurrency` (default 3) sources at once instead of strictly
  one at a time, with citation numbering staying stable regardless of
  which read finishes first.
- **Whisper hallucination filter** (issue #147, `windows-launcher`): known
  short "phantom" transcriptions ("thank you", "please subscribe",
  "subtitles by", ...) are filtered when the recorded clip was very short
  -- a real utterance with the same wording, spoken normally, is trusted.
- **Voice-pipeline crash logging** (issue #147, `windows-launcher`): a
  failed recording attempt now writes a timestamped entry (error, audio
  backend, input device, app state) to a local `voice-crash.log` under
  the app's `userData` directory instead of console-only.
- **Renderable artifacts** (issue #148, both apps): chat replies render as
  sanitized markdown (`marked` + `DOMPurify`) instead of raw text; a large
  or ```` ```html ```` fenced block opens in its own window instead of
  dominating a chat bubble. **Sanitization could not be visually verified
  this session** (Browser pane was unresponsive) -- worth an explicit
  script-injection click-through before/soon after this ships.
- **`image-generation` plugin** (issue #149): text-to-image and
  image-editing, local-first via an Automatic1111-compatible HTTP API
  (`MANA_IMAGE_BACKEND_URL`), with an opt-in external API fallback
  (`MANA_IMAGE_API_KEY`), never a default. No dedicated chat UI needed --
  a result renders inline through issue #148's markdown pipeline. Off by
  default -- enable in Settings > Plugins. No local SD backend was
  available to verify against a live generation this session; the
  Automatic1111 request/response shape is verified via mocked HTTP calls.
- **`browser-automation` plugin** (issue #150): navigate/click/type/read a
  live page for a specific site interaction, distinct from `web-access.js`'s
  search-and-extract. Launches Edge by default (ships on every Windows
  install) via `playwright-core`, no bundled browser download. Ref-based
  element addressing (`data-mana-ref`), text-mode reads by default,
  local-only routes. Off by default -- enable in Settings > Plugins. No
  real browser was launched to verify this session (no Windows/Edge on CI,
  Browser pane unresponsive) -- verified against a fake page-like object.
- **`telegram-bridge` plugin** (issue #151): message Mana remotely over
  Telegram via long-polling (no webhook, nothing exposed to the internet),
  gated by a one-time pairing code so a stranger's DM can't reach her
  without approval (`POST /telegram/approve`). DM-only, text-only. Off by
  default -- enable in Settings > Plugins and set
  `MANA_TELEGRAM_BOT_TOKEN`. No real bot token was available to verify
  against the live Telegram API this session -- verified via a fake
  `getUpdates`/`sendMessage` client.
- **`discord-bot` plugin** (issue #185): a second remote-messaging option
  alongside `telegram-bridge`, added rather than replacing it. Uses
  `discord.js`'s Gateway `Client` (a websocket, since Discord has no
  long-poll equivalent to Telegram's `getUpdates`) with the same
  pairing-code approval gate (`POST /discord/approve`). DM-only,
  text-only. Off by default -- enable in Settings > Plugins and set
  `MANA_DISCORD_BOT_TOKEN`. No real bot token was available to verify
  against the live Discord API this session -- verified via a fake
  `message` object matching `discord.js`'s real `Message` shape.
- **Approval gate for agent-authored content** (issue #152): a shared
  primitive (`approval-gate.js`) both the skills layer (#140) and
  programmatic tool calling (#142) can call into before trusting content
  Mana wrote herself. `POST /skills` now pauses for approval
  (`allow-once`/`always-allow`/`deny` via `POST /approvals/:id/decide`)
  instead of writing immediately; `always-allow` persists per action type
  so it doesn't nag once trusted. Optional off-by-default keyword/pattern
  content scan flags a pending request for the approver's attention.
- **Session trajectory export** (issue #153): `GET /sessions/:id/export`
  writes a session's full turn history as ShareGPT-style JSONL (tool calls
  included as `function_call`/`observation` entries); a new "Export
  (ShareGPT JSONL)" entry in windows-launcher's session sidebar context
  menu saves it via a native dialog. Tool-call metadata is now also
  persisted on each turn going forward (`acp-memory-store.js`'s
  `appendTurn`) -- previously it was only ever logged to console, never
  stored, so there was nothing for an export to preserve.
- **`video-watch` plugin** (issue #154): download (`yt-dlp`) or accept a
  local video, pull captions or fall back to local Whisper transcription
  (both free -- no external API key needed), extract a duration-scaled
  set of frames (keyframe-only by default), and answer a question
  grounded in what's actually shown/said via the existing local vision
  pipeline. New `POST /video/watch` route. Off by default -- enable in
  Settings > Plugins. `yt-dlp` is a new external dependency. No real
  video/binaries were exercised this session -- verified via injected
  fake process calls.
- **Conversational rut detection** (issue #159): a cheap n-gram-similarity
  check (`rut-detection.js`) flags when a reply is too similar to Mana's
  own recent replies. Wired into both Best-of-N's candidate selection
  (prefers a less-repetitive already-generated candidate over the judge's
  blind pick) and the general reply path (one regeneration with a "say
  this differently" nudge). A per-session cooldown stops it from
  triggering constant regeneration once a rut is broken.
  `MANA_RUT_DETECTION_ENABLED` (default on), `MANA_RUT_LOOKBACK`,
  `MANA_RUT_SIMILARITY_THRESHOLD`, `MANA_RUT_COOLDOWN_REPLIES` tune it.
- **Anti-formulaic-phrasing rewrite pass** (issue #160): a hand-curated
  lexicon of Mana's known catchphrases/openers/kaomoji
  (`phrasing-variation.js`) catches one recurring within the last few
  replies and asks the model for one alternate phrasing of just that
  fragment -- not a full regeneration, and never a content/meaning
  change. Pairs with windows-launcher's existing `reply-emotion.js`
  rather than replacing it. `MANA_PHRASING_VARIATION_ENABLED` (default
  on), `MANA_PHRASING_LOOKBACK` tune it.
- **VRM (3D) avatar support** (issue #161): a second avatar renderer
  alongside Live2D (`three` + `@pixiv/three-vrm`), driven by the exact
  same lip-sync/emotion signal pipeline (`avatar/lip-sync.js`, extracted
  and shared between both renderers). VRM is preferred when a `.vrm`
  model is configured (drop it in `windows-launcher/avatar/model/`, or
  set `MANA_VRM_MODEL`); falls back to Live2D otherwise, same as Mana
  already degrades when the Live2D model is missing. Wired into both
  windows-launcher avatar surfaces (the overlay and the inline chat-
  window avatar); `desktop-client` doesn't have it yet, following the
  same incremental path Live2D itself took. See
  `docs/vrm_avatar_setup.md`. No real VRM model/GPU rendering was
  exercised this session -- verified via unit tests on the pure logic and
  confirming the new dependencies load correctly.
- **Multi-round tool-calling loop** (issue #183): `runToolAwareReply` was
  a fixed two-call sequence -- one round of tool calls, then a forced
  final answer, with any *further* tool calls the model requested in that
  final response silently ignored. Now loops (bounded by
  `MANA_TOOL_CALLING_MAX_ROUNDS`, default 4) so a tool's results can
  inform another tool call -- the actual prerequisite for issue #169's
  outbound MCP client support. New caps: per-round tool-call limit
  (`MANA_TOOL_CALLING_MAX_CALLS_PER_ROUND`), a wall-clock budget
  (`MANA_TOOL_CALLING_MAX_MS`), and a consecutive-tool-error backstop --
  hitting any of them forces one final `tool_choice: "none"` completion so
  the reply is always something the model actually generated, never a
  blank or synthetic fallback.

### Fixed
- **Banner crystal's halo read as a flat circle with a hard edge** (issue
  #242, follow-up from #240): the `crystalHalo` radial gradient used
  `r="62%"`, so it hit fully transparent before the ellipse's actual edge
  -- SVG's default `spreadMethod="pad"` then held that flat transparent
  value out to the true boundary instead of continuing to fade, which read
  as a hard edge rather than a soft glow. Extended the gradient to
  `r="100%"` so the fade reaches the real edge, plus added a real
  `feGaussianBlur` as a second guarantee. Also standardized
  `banner-light.svg`'s halo to the same gradient stops as
  `banner-dark.svg`, rather than keeping two separately-tuned intensities.
- **Blank taskbar/tray icon and a stray native menu bar** (issue #230,
  `windows-launcher`): the tray icon loaded `sprites/sprite-idle.png`, a
  file deleted from the repo a while ago (issue #45/#46 purged the whole
  `sprites/` folder) -- `nativeImage.createFromPath()` doesn't throw on a
  missing file, it silently returns an empty image, which is why this
  never surfaced as a crash, just a blank icon. The main window had no
  `icon:` option at all either, so it fell back to Electron's default for
  both the taskbar entry and title bar. Fixed by rasterizing the existing
  Mana Crystal SVG (same design as the sidebar logo/startup screen) into
  `windows-launcher/assets/icon.png` and wiring it into both. Also added
  `Menu.setApplicationMenu(null)` -- the default File/Edit/View/Window/Help
  bar was never intentionally added, just never explicitly removed.
- **Packaged .exe/installer had no app icon configured** (issue #232,
  follow-up from #230): #230 only fixed the *runtime* window/tray icon --
  the packaged binary is controlled by a completely separate electron-builder
  `build.icon` config, which neither app had set. `windows-launcher` had no
  `build` section in its `package.json` at all; `desktop-client` had one but
  no `icon` key, and no icon file existed anywhere under either app's
  `build/` folder. Added a 512x512 Mana Crystal PNG at `build/icon.png` in
  both apps and pointed `build.icon` at it (electron-builder generates the
  multi-resolution `.ico` from a single square PNG automatically).
- **Loading screen stuck forever, whole renderer script silently dead**
  (issue #226): `backend-config.js` and `renderer.js` both declared
  `const { ipcRenderer } = require("electron");` at top level -- since
  `index.html` loads them (plus `session-sidebar.js`/`sidebar-nav.js`) as
  sibling classic `<script>` tags sharing one lexical scope (deliberately,
  so those files can reference things like `appendChatMessage` as bare
  identifiers), the duplicate threw `SyntaxError: Identifier 'ipcRenderer'
  has already been declared` and killed the entire `renderer.js` script
  before a single line ran -- including the loading screen's own
  `startup-progress`/`startup-complete` listeners. The main process's side
  of startup (spawning services, resizing the window) was unaffected, which
  is why the window still grew to full size while the overlay stayed stuck
  on top of it. Found live while smoke-testing issue #219's barge-in
  default-on change, unrelated to barge-in itself. Fixed by removing
  `renderer.js`'s duplicate (`backend-config.js` loads first, so its
  binding is already in scope); added a regression test
  (`renderer-script-scope.test.js`) that scans every sibling script
  `index.html` actually loads for duplicate top-level `const`/`let` names.
- **Deep Research/retriever excerpt compression (issue #211) had zero
  effect in the common case** (issue #217, follow-up from #211/#208): the
  coding-mode repo-retrieval block in `server.js` has a vector-store-direct
  fast path that returns early whenever a vector store has entries --
  exactly the common case once one's built -- with its own duplicated
  read-file-then-`slice(0, 800)` loop that never went through #211's
  compression at all. Now calls the same shared `buildSnippets()` helper
  #211 built, so whichever path actually produces hits gets compressed.
  Same dedupe applied to `retriever-admin-capability.js`'s debug route
  (with `compress: null` there on purpose -- that route intentionally
  stays raw ground truth).
- **Fish Speech's first reply after each restart could silently use the
  wrong voice** (issue #215, follow-up from #213): enabling
  `torch.compile` made the first real generate() call after each restart
  take ~4 minutes, but nothing warned callers -- that first call was
  whatever the user's first real chat message triggered, which blew past
  `fishTtsTimeoutMs` (20s) and silently fell back to Kokoro for one
  reply. `server.js` now fires a throwaway warmup synthesis eagerly at
  startup (on its own much longer timeout) whenever Fish Speech is the
  configured provider, so the compile trace happens before any real
  reply needs it. Status (`idle|warming|ready|skipped|failed`) surfaces
  on `GET /health` and as a new Doctor popup check ("Voice warmup") in
  both apps -- not on the startup loading screen, since both apps' rows
  are a fixed list that must all reach a terminal state before the
  overlay hides, and an open-ended ~4 minute wait doesn't fit there
  without blocking startup.
- Session-level conversation memory (`buildPromptMemory`) was computed on
  every turn but never actually appended to the prompt -- `memoryBlock`
  was built and then silently discarded, so Mana's own session summary
  never reached the model. Fixed by appending it to the system prompt,
  matching how `BACKGROUND_MEMORY_BLOCK` was already injected (issue #141).
- `runOpenAIReply` referenced removed `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
  `OPENAI_MODEL` consts left over from the brain-provider refactor above --
  would have thrown at runtime the moment remote AI was actually used.
- The `windows-launcher` overlay always rendered a static SVG sprite first
  and only switched to the Live2D model once/if it finished loading;
  removed the sprite fallback entirely so only the Live2D model ever
  renders, and deleted the leftover placeholder assets.
- The compact 440x460 startup window showed a horizontal scrollbar because
  the underlying sidebar+chat layout (hidden behind the startup overlay,
  but still occupying flex space) didn't shrink below the overlay's width;
  added `overflow-x: hidden` in both apps.
- Model-file loading now checks the actual GGUF magic bytes, not just the
  `.gguf` extension, before handing a file to llama-server; brain-provider
  `baseUrl` is now restricted to `http/https` (was any URL scheme).
- **`video-watch` plugin (issue #154), found via real manual testing**:
  the original frame budget (12-30 frames, up to 100 for long videos) was
  carried over from the reference implementation's cloud-model
  assumptions and never checked against a local vision model's context
  window -- a full-resolution frame costs ~1210 prompt tokens against
  llama-server's default 4096-token context, so even a short test video
  failed with "exceeds context size." Fixed by downscaling extracted
  frames to 336px wide by default (~88 tokens/frame) and lowering the
  frame budget to 8-20. Separately, a long video's transcript had no
  length cap before being embedded in the vision prompt (YouTube's
  auto-captions repeat most lines 2-3 times across overlapping windows,
  so a 20-minute video's transcript ran to 70k+ characters) -- now
  truncated to 4000 chars for the model-facing prompt only; the full
  transcript is still returned to the API caller. Both fixes verified
  against two real YouTube videos end-to-end (real `yt-dlp`/`ffmpeg`/
  `whisper-cli`/`llama-server`), closing the manual-verification gap
  disclosed when this plugin first shipped.

### Docs
- **Issue #220 investigation**: benchmarked two GitHub-sourced candidates
  found via a broad survey for Mana improvements. `--cache-ram` (llama-
  server's prompt cache): already active by default on Mana's installed
  build -- real benchmark confirmed a ~94% prompt-processing time cut on
  repeated system prompts, exactly matching Mana's actual usage pattern,
  with zero configuration needed. `sqlite-vec`: the assumed `better-
  sqlite3` pairing fails to install on this dev machine (needs a native
  compile, no usable VS C++ toolchain); found and verified a working
  alternative via Node 22's built-in `node:sqlite` + `loadExtension()`
  instead, but a real benchmark showed no meaningful speed difference at
  Mana's actual retriever scale (2,000 entries) -- not adopted.
- **Issue #200 investigation**: compared `langchain-ai/context_engineering`'s
  compression notebook against Mana's actual memory/retriever code.
  Correction to the issue's own premise: `acp-memory-store.js` already has
  real LLM summarization-on-write for the rolling session summary (issue
  #141's `summarizeFn`) -- not truncation-only as assumed. The real gap:
  neither `retriever-index.js`'s search snippets nor Deep Research's
  per-source read excerpts are ever summarized, only flat char-truncated
  (800 / 2000 chars respectively) -- filed as issue #208.
- **Issue #199 investigation**: compared Deep Research's issue #145
  "parallel subagent delegation" against `langchain-ai/deep_research_from_scratch`'s
  supervisor/subagent pattern. Finding: Mana's #145 delegates concurrent
  *I/O* (page fetches via a bounded worker pool), not concurrent *LLM
  reasoning* -- there's no `ConductResearch`/`ResearchComplete`-style
  handoff contract and no context-isolation boundary before the final
  synthesis call. This is a reasonable adaptation to Mana's single local
  `llama-server` instance (true parallel LLM subagents would contend for
  the same model), not an oversight. No code changes; the one concrete
  gap (pre-synthesis context isolation) folds into issue #200's already-
  scoped compression investigation rather than a new issue.
- **Issue #146 investigation**: Mana has no outbound MCP *client*
  capability today (`mcp-server.js` is server-only) -- but the already-
  installed `@modelcontextprotocol/sdk` ships a full client module, so
  building one needs no new dependency. Scoped, not built, since it
  depends on the tool-calling loop (issue #51) supporting more than one
  tool/round first; follow-up tracked as issue #169.

## [0.2.2] - 2026-07-27

This release exists primarily to verify the auto-update mechanism
(issue #120) end-to-end against a real published GitHub Release -- it also
folds in everything else that had accumulated on `main` since 0.2.1 but
never shipped in a tagged release.

### Added
- **Auto-update checking for `desktop-client`** via `electron-updater`
  against GitHub Releases. Both download and install are gated behind their
  own confirmation dialog, never automatic; `MANA_AUTO_UPDATE_ENABLED=0`
  disables checks entirely (issue #120).
- **First-run setup wizard for `desktop-client`** (issue #123).
- **Portable Python bundled into the packaged installer**, so a system
  Python install is no longer required (issue #127).
- **Per-plugin enable/disable settings**, exposed in Settings (issue #131).
- **`desktop-client`**: closing screen, session browser, local model picker,
  and plugin toggle UI (issue #134 area).
- **Silero VAD** replaces the RMS-threshold speech/silence heuristic in
  `windows-launcher`'s continuous-listening loop, with a graceful fallback
  if the model is unavailable (issue #135).
- **`windows-launcher` UI overhaul**: popup info bubbles for
  Avatar/Web access/Vision/Model/Doctor, a redesigned horizontal Doctor
  panel, a startup loading screen, the Mana Crystal logo, a fuller Settings
  menu (Logs/Plugins), and a themed scrollbar (issue #138).
- A legally-clean default sample Live2D avatar (`npm run fetch-sample-avatar`),
  downloaded at setup time from Live2D's own CDN under their Free Material
  License -- not bundled into the installer, since that license doesn't
  permit redistribution.

### Changed
- `desktop-client`'s local data relocated out of the install directory,
  so an uninstall/reinstall doesn't touch user data in-place
  (issue #121).
- `desktop-client`'s avatar renderer rewritten to be context-isolation-safe
  (issue #122).
- `desktop-client` reskinned; sidebar nav wired to real functionality
  instead of placeholders.
- `plugins/` bundled into the packaged `desktop-client` build so the
  installed app can actually boot standalone (issue #124).
- Root README brought up to date with the actual current feature set,
  including a real screenshot instead of placeholder art.

### Fixed
- Several small backend/desktop-client reliability bugs (issue #129).
- `vector-rebuild-audit` test no longer clobbers the real audit log.
- Plugin test scripts fixed to survive a Node version change.
- Live2D avatar sizing and startup-timing bugs in `windows-launcher`.

### Docs
- Code-signing options documented for the desktop-client installer
  (groundwork for issue #119; signing itself isn't implemented yet -- builds
  are still unsigned, so both install and update still trigger a SmartScreen
  warning).

## [0.2.1] - 2026-07-14

### Removed
- **Sprite artwork removed from the public repo.** `sprites/` (all rights
  reserved, see `LICENSE-ARTWORK`) is no longer tracked — it's gitignored
  going forward, and its history was purged from the repository entirely.
  The desktop app degrades gracefully without it (the same pattern already
  used for the Live2D avatar model/runtime). This release supersedes
  `v0.2.0`, which has been deleted.

## [0.2.0] - 2026-07-12

### Added
- **Live2D avatar ported into `desktop-client`** (the installer-packaged
  app): same driver as `windows-launcher`, with emotion-reactive states and
  RMS lip sync wired into the reply/audio flow, plus a zoom control and an
  always-visible in-app disclaimer banner. Clearly marked as a temporary
  testing placeholder, not the final avatar — see
  `desktop-client/AVATAR_NOTICE.md` for the miHoYo/HoYoverse attribution.
  Required temporarily enabling `nodeIntegration` for the desktop client's
  main window (documented tradeoff, scoped to this feature).
- **Setup automation script** (`tools/setup-mana.ps1`) for first-run npm
  installs across all three subprojects, `.env` scaffolding, model/binary
  directory creation, and a doctor report.
- **Built-in Live2D avatar** (`windows-launcher`): renders a Cubism model
  directly in the desktop UI instead of requiring VTube Studio. Drives
  emotion-appropriate motions/expressions from reply text (including
  kaomoji/emoji, not just English mood words), real-time lip sync, natural
  randomized blinking, a fixed-width zoom control (whole body / waist-up /
  bust-up), and an idle-tilt correction for models whose idle motion pitches
  back sharply. Every tuning knob (mouth gain, eye-open scale, blink/smile/
  brow parameter ids, idle tilt angles, state→motion/expression mapping) is
  configurable per-model via `mana-avatar.json`, so swapping the model
  folder is a drop-in operation — see `docs/live2d_avatar_setup.md`.
- **Silence-based voice endpointing**: Mana waits for an actual pause
  (~2.2s, tunable) before treating speech as a finished prompt, instead of
  cutting a long sentence off at a fixed duration.
- **Multilingual TTS**: automatic language detection with per-language
  Kokoro voice profiles (English, Chinese, Japanese, Korean), instead of
  always speaking in English regardless of reply language.
- **Speech text normalization**: emoji/kaomoji become short spoken words
  ("smile", "sniff") instead of long Unicode names being read aloud,
  vowel-less interjections get pronounceable spellings, and a trailing "~"
  stretches the last vowel instead of being narrated as "tilde".
- **GPT-SoVITS** wired as an opt-in trial voice-cloning provider alongside
  Kokoro/Chatterbox/Fish Speech.
- **Self-hosted web access**: search, wiki lookups, and reading a page Mana
  is pointed at, backed by a local, single-user SearXNG instance rather than
  a public instance or third-party search API.
- **Persistent llama-server runtime** with CLI fallback, replacing
  spawn-per-request `llama-cli` calls; background memory-indexing jobs now
  run hourly, skip via content hash when nothing changed, and pause while a
  watched game has focus.
- **Local vision support**: screen/image description via a local
  Qwen2.5-VL model (`POST /vision/describe`, `image` field on `POST /reply`).

### Changed
- **Relicensed from PolyForm Noncommercial 1.0.0 to Apache License 2.0**
  for the code, so GitHub's license picker/badge recognizes it. This
  permits commercial use of the code by others, a deliberate tradeoff for
  recognizability. Artwork (`sprites/`, `windows-launcher/avatar/model/`)
  is unaffected — still fully proprietary/all-rights-reserved under
  `LICENSE-ARTWORK`, independent of the code license either way.

### Fixed
- Closed two real gitignore gaps: personal voice-audition/reference audio
  was only untracked by luck (nothing actually ignored it), and Python
  `__pycache__` bytecode had been committed.

## [0.1.0] - 2026 (baseline)

Initial local-first voice assistant: wake-word listening, local speech
transcription (whisper.cpp), local reply generation (llama.cpp + GGUF
models), local TTS playback (Kokoro/Chatterbox), and the Windows Electron
launcher.
