# OSS Inspiration Survey: DIY AI / JARVIS-Style Assistants (2026-09)

## Method

A 50-agent parallel research workflow, each agent assigned an independent
angle across ten categories: JARVIS/Iron-Man-style clone projects, AI
companion/avatar frameworks, voice pipeline architecture (wake word, STT,
TTS, turn-taking, barge-in), memory architectures, agent/tool-calling
orchestration, hardware/embodiment, screen/vision awareness, community
hubs and ecosystems, named deep-dives on specific high-profile projects,
and public failure postmortems. Each agent rated its findings `borrow`
(adopt directly or near-wholesale), `borrow-narrow` (one specific
technique worth lifting, not the whole project), `stretch` (bigger lift
or narrower payoff, worth tracking but not now), `skip` (considered and
explicitly excluded), or `not-relevant`.

Across all 50 agents: **54 `borrow`, 180 `borrow-narrow`, 62 `stretch`,
12 `skip`, 12 `not-relevant`** — around 320 distinct named
projects/techniques surveyed in total. This document covers the full
`borrow` tier in detail, organized by theme rather than by agent, plus
the `borrow-narrow` and `stretch` items that add real signal beyond what
the `borrow` tier already covers. It does not restate ground already
covered by `docs/roadmap/oss-inspiration-survey-2026-08.md` (companion
personas, coding-agent tooling basics, and the Graphiti/mem0 memory
comparison already tracked there) except where this round found a
materially new angle on the same subject.

## How to read this

- **Bold recommendation tags** carry over the `borrow`/`borrow-narrow`/`stretch`/`skip` convention from the prior survey.
- Where a finding led to a filed issue, the issue number is given inline; the issue body is the authoritative scope, this document is the research backing.
- Full technical detail for every `borrow`-tagged finding (name, source, summary, and why it matters for Mana specifically) is preserved verbatim in this document's sections below — nothing was compressed away for the highest-confidence tier.

## Correction notice (2026-09-12)

This document's "Relevance to Mana" reasoning was written against the
CLAUDE.md architecture summary and prior conversation notes, not a fresh
read of the actual codebase. A follow-up fact-checking pass (5 agents
reading real code) found that **7 of the 8 filed issues overstated what
was missing**, and the same overclaims are baked into this document's own
prose in several places — most visibly the claim that Mana has no MCP
support at all (it already ships both a server and a client), that echo
cancellation is "conspicuously absent" (Electron already has it via
`getUserMedia`'s default `echoCancellation: true` — only the native
launcher lacks it), that Dream Mode is a single process needing to become
an extract/enrich pipeline (it already is one, six stages), and that
Mana's memory has no raw-conversation recall tier (a `session_search__query`
tool, FTS5 + semantic search over past sessions, already exists in
`node-bot/ai/session-search-tool-source.js`). Every paragraph below
affected by one of these corrections now carries an inline note citing
the real file/line evidence — this document was **not** rewritten from
scratch, only the specific false-negative claims were fixed. See the
corrected `docs/roadmap/issue-NNN-*.md` docs for the full per-issue
detail; this section only summarizes.

## Top recommendations

Ranked by expected impact relative to effort, given Mana's own
constraints (local-first, swappable per-role models, gaming-mode
resource backoff as a first-class constraint):

1. **Dedicated wake-word classifier ahead of continuous Whisper** — issue #618. Highest-leverage single change: replaces always-on full ASR inference with a near-zero-cost gate. (Confirmed accurate as filed — the only one of the eight that was.)
2. **Port echo suppression + turn-detection to the native launcher** — issue #619. Electron already has AEC (`getUserMedia`'s default `echoCancellation: true`), barge-in (#219, `BargeInGate.cs`/`voice-endpointing.js`), and a turn-detection heuristic (`silenceBufferMsForTranscript()`). Only `windows-native-launcher`'s `WasapiCapture()` lacks all three — this is a port, not new-from-scratch work.
3. **GBNF grammars for the plugin/tool-calling layer** — issue #621. MCP is already fully shipped (`node-bot/mcp-server.js`, `node-bot/mcp-client-registry.js`) — the genuinely missing piece is GBNF grammar-constrained decoding, which removes a whole class of malformed-tool-call failures for free (the grammar engine is already in llama.cpp).
4. **Adversarial LLM verification for the coding agent** — issue #622. A static verifier (`reply-verifier.js`) and a JSON-based checkpoint store (`snapshot-store.js`) already exist. The genuinely missing piece is an adversarially-prompted LLM sub-agent as a second, differently-shaped check.
5. **Extend memory-graph.js edges with fact-validity, building on #431/#432** — issue #620. Dream Mode is already a 6-stage pipeline (`triggerIdleConsolidation`), and bi-temporal fact validity (#431) plus typed-entity merging (#432) already ship. Only the raw Hebbian edges in `memory-graph.js` genuinely lack a validity window.
6. **LLM-emitted emotion tags for avatar expression** — issue #623. Electron already does per-sentence heuristic mood detection (`reply-emotion.js`'s `detectReplyEmotion()`); native has none. The genuinely missing piece is the LLM-tag mechanism itself plus a config-file mapping (current mapping is hardcoded) and porting detection to native.
7. **Wire existing accessibility-tree extraction into the ambient vision loop + pre-storage PII filtering** — issue #624. Accessibility-tree-first extraction already ships (#343, `readScreenContext()`) on the conversational path; it just isn't wired into the periodic glance loop, which still runs on a fixed timer. The PII filter is genuinely missing.
8. **Surface the existing hardware-fit recommendation + add backend auto-selection** — issue #625. `model-management.js` already detects GPU/RAM and computes a recommendation, exposed via `GET /models/status` — it's just never displayed in either launcher's UI. Backend (CUDA/Vulkan/ROCm) auto-selection is genuinely missing.

## Findings by theme

### Voice pipeline: wake word, echo, and turn-taking

This was the single most densely covered category, and the research
converges hard on one architectural point: **Mana's fuzzy-transcript
wake-word approach (running whisper.cpp continuously and pattern-matching
its output) is the outlier.** Nearly every comparable open project uses a
tiny dedicated classifier as a gate in front of STT instead.

**Continuous-STT-as-wake-word vs. dedicated trained classifier**
(architectural contrast, not a single project;
https://github.com/dscripka/openWakeWord) — Across the
openWakeWord/microWakeWord/livekit-wakeword ecosystem, the standard
architecture is: an always-on lightweight classifier (10s-100s of KB,
running on raw audio features at low duty cycle) that only wakes a full
STT pipeline on a positive detection. This is architecturally distinct
from running full continuous transcription and fuzzy-matching the
output, which requires the STT engine to be active at all times. Given
Mana's explicit gaming-mode resource-backoff constraint, this is the
highest-leverage finding from the entire survey. → **Issue #618.**

**openWakeWord's synthetic-TTS + real-voice-cloning training pipeline**
(https://openwakeword.com/train) — A one-command pipeline spins up a
Kokoro TTS container, generates ~13,000 positive wake-phrase samples from
67 synthetic voices (each at 0.7-1.3x speed for prosody variation), mixes
in 20-50 of the user's own recordings weighted 3x, and trains a ~400KB
ONNX model in 4-8 hours on a consumer GPU (negatives are deliberately
drawn from clearly different phrases, not near-miss ones — training
against phonetic neighbors was found to hurt accuracy). Mana already
runs local TTS with reference-audio voice cloning (Fish Speech) and could
reuse its own clone-voice output instead of Kokoro to synthesize the
user's wake phrase in many prosodic variations. **Borrow the whole
pipeline**, not just the technique. → **Issue #618.**

**ESPHome `voice_assistant` + `micro_wake_word`**
(https://esphome.io/components/voice_assistant.html) — The satellite
firmware pattern: audio streams to a "brain" only after a local
quantized TFLite-Micro wake-word model (~23KB tensor arena) fires on the
ESP32 itself. Relevant if Mana ever ships a satellite/wearable device,
less directly relevant to the host-PC case, but confirms the same
architecture at the extreme low-power end.

**ESP-SR (WakeNet / MultiNet / AFE)**
(https://github.com/espressif/esp-sr) — Espressif's on-chip speech stack
bundles AEC, VAD, blind source separation, and noise suppression as one
solved, vendor-tuned "Audio Front-End" layer underneath wake-word/STT.
Confirms AEC + noise suppression is a distinct, separately-solved layer
regardless of which wake-word engine is chosen.

**Stripping the assistant's own TTS output from the live transcript**
(porokka's JARVIS-OS devlog,
https://dev.to/porokka/i-built-a-local-ai-operating-system-over-easter-weekend-5b6j)
— Real-world voice handling (ambient noise, Whisper hallucinating on
silence) was harder than model selection for this Ollama+Claude
Code+Obsidian JARVIS clone. Fix: when the assistant's own TTS plays back,
whisper picks it up in the continuous transcript; instead of speaker
diarization, they string-match incoming segments against the
just-spoken TTS text and discard matches. Cheap, concrete, and a direct
hit on Mana's design — **though note Electron already mitigates this a
different way** (real AEC, not string-matching; see correction below) --
still directly relevant for `windows-native-launcher`, which has neither.
→ **Issue #619.**

**Mic muting / AEC during TTS playback**
(https://github.com/rhasspy/wyoming-satellite/issues/250) —
`wyoming-satellite` mutes mic input for a configurable window around
chime/TTS playback (`--mic-no-mute-during-awake-wav`,
`--mic-seconds-to-mute-after-awake-wav`); Home Assistant's own reference
hardware instead uses a dedicated XMOS XU316 DSP chip for real AEC so the
mic can stay open and be interrupted mid-speech. Electron already takes
the "real AEC" path (`getUserMedia`'s `echoCancellation: true`); this
mute-window fallback is relevant specifically for
`windows-native-launcher`, which currently has no AEC and no mute-window
mitigation either. → **Issue #619.**

**WebRTC AEC3 standalone acoustic echo cancellation for open-mic barge-in**
— AEC3 has been extracted from the full browser stack specifically so
non-browser voice-assistant projects can link just the echo canceller,
feeding it the outgoing TTS PCM as the far-end reference alongside the
live mic input. **Correction**: this is not absent from Mana's
architecture — `windows-launcher`/`desktop-client` already get real
WebRTC AEC for free via `getUserMedia({audio: true})`'s default
`echoCancellation: true`. It's absent specifically from
`windows-native-launcher`, whose `WasapiCapture()` capture path has no
AEC equivalent at all. → **Issue #619** (rescoped to the native launcher
only).

**Home Assistant Assist pipeline: staged, event-driven orchestration**
(https://developers.home-assistant.io/docs/voice/pipelines/) — A voice
interaction is a `PipelineRun` with explicit `start_stage`/`end_stage`
(wake_word → stt → intent → tts) so a run can skip stages (e.g. text-only
chat skips wake/stt/tts entirely). Each stage emits paired start/end
events bracketed by `run-start`/`run-end`, with per-stage timeouts.
Clients subscribe to the event stream to drive UI state. This is a clean,
reusable pattern for Mana's own orchestration: emit typed
stage-start/stage-end/error events over an internal bus that both the
Electron avatar and the WinForms overlay subscribe to, instead of each
surface hardcoding state transitions — and it naturally supports "skip
STT for typed chat input" which Mana likely already needs.

**Kyutai Unmute** (https://github.com/kyutai-labs/unmute) — A modular
cascaded STT/LLM/TTS pipeline wired over WebSockets, runnable on one
consumer GPU. Its "flush trick" — re-decoding the buffered audio tail at
~4x realtime once end-of-turn is detected, to finalize a transcript in
~125ms instead of waiting out the model's normal 500ms delay — is the
closest real-world analog to Mana's own cascaded architecture and the
most directly actionable latency reference.

**Kyutai STT semantic end-of-turn prediction**
(https://kyutai.org/stt/) — The same streaming model that transcribes
also predicts, per frame, the probability the user has actually finished
speaking (using content/intonation cues, not a silence timeout) — a
byproduct of the same model, no extra inference pass.

**Pipecat Smart Turn v3**
(https://github.com/pipecat-ai/smart-turn) — A small, BSD-2, fully open
(weights + training data + training script) model that takes raw
waveform and outputs turn-completion from prosody, ~12ms per inference on
CPU, decoupled from any specific STT/LLM/TTS. **Correction**: Electron
already has a turn-detection heuristic (`voice-endpointing.js`'s
`silenceBufferMsForTranscript()`), so this isn't filling total absence —
it would be a semantic upgrade over the existing silence-based heuristic,
and (separately) something `windows-native-launcher` needs ported or
built from scratch since it has neither. Cheap enough to keep running
even under gaming-mode GPU reservation either way. → **Issue #619.**

**Vocalis local speech-to-speech assistant**
— Faster-Whisper + local LLM + Orpheus/Kokoro TTS streamed in 10-50ms
chunks, built around low-latency interruption: a frontend VAD/Interrupt
Detector watches the mic during AI playback and sends an explicit
interrupt over WebSocket; the backend cancels LLM generation and TTS
synthesis and clears the pipeline, while the frontend clears its own
audio buffer. A concrete reference implementation for Mana's
windows-launcher-to-backend interrupt boundary.

**LocalAgreement-n stabilization policy**
(https://github.com/ufal/whisper_streaming) — Repeatedly re-decodes a
growing/sliding audio buffer; a text prefix is only "confirmed" once *n*
consecutive re-decodes agree, everything past that stays a mutable
partial. Confirmed prefixes trim the buffer. Mana already has the raw
ingredients (repeated re-decoding for wake-word matching) and could add
an explicit confirm/partial split to show a live, non-flickering "you're
saying..." caption instead of re-writing the whole hypothesis every
chunk.

**WhisperLive (Collabora) client/server streaming architecture**
(https://github.com/collabora/WhisperLive) — A persistent server owns the
model/VAD, clients stream PCM over WebSocket, server pushes back typed
partial/final JSON messages (plus word timestamps, hotword biasing,
diarization). Directly matches Mana's split between one inference layer
and multiple front ends (Electron, WinForms) — standardizing on a small
partial/final event schema would let both surfaces (and any future
mobile client, already planned via Cloudflare Tunnel) render live
captions consistently for free.

**interim/is_final convention with word-level confidence**
(Deepgram, Google Cloud STT, Azure Speech, Web Speech API) — Every major
streaming STT API converges on the same wire contract: each result
carries `is_final`; pre-final results are "interim" and may be rewritten.
Deepgram additionally attaches per-word confidence, commonly rendered as
dimmed/underlined low-confidence words. Worth adopting internally as a
stable interface between whisper.cpp and every consumer (wake-word
matcher, dictation UI, agent transcript logging) even though Mana's ASR
is fully local.

**Draft-styled interim text with full-replace-on-final rendering**
(Chrome/Android Live Caption convention) — Render interim text in a
visually distinct "draft" treatment; swap wholesale for committed text on
finalize rather than diffing/appending token-by-token, since incremental
append of a self-revising hypothesis produces visible stutter. The
concrete visual counterpart to the interim/final data contract above,
directly implementable in Mana's avatar window or overlay.

### Memory and Dream Mode consolidation

**Letta three-tier memory: core / recall / archival**
(https://docs.letta.com/guides/agents/memory-blocks/) — Core memory
blocks (small labeled chunks like persona/human, always injected
verbatim, each with a character limit); recall memory (the complete raw
conversation log, searchable via a `conversation_search` tool); archival
memory (arbitrary long-term facts in an external store, queried on
demand, never pinned to context). **Correction**: Mana already has a
recall-memory-equivalent tier, not just archival — `node-bot/ai/session-search-tool-source.js`
exposes a `session_search__query` tool (FTS5 keyword syntax plus
semantic matching, scoped to the current session or across all past
sessions) explicitly built to search raw past conversations when "the
curated MEMORY.md-style summary" (the file's own comment) isn't enough.
What's still a fair comparison: Letta's core-memory tier (a small,
always-injected, character-budgeted block the model edits directly via
tool calls) doesn't have an obvious Mana equivalent yet — the
`BACKGROUND_MEMORY_BLOCK` compaction output is closer to a summary than
a model-editable pinned block.

**mem0 v3: single-pass ADD-only extraction + immutable facts**
(https://docs.mem0.ai/migration/platform-v2-to-v3) — In an April 2026
rewrite, mem0 dropped its two-LLM-pass extract+merge/CRUD pipeline
entirely in favor of a single call that only ever adds new, immutable
facts; contradictory facts both stay in the store permanently, with
retrieval ranking (not deletion) deciding what surfaces. This is mem0's
own team abandoning the CRUD-mutation model Mana already evaluated and
skipped, converging instead toward the same non-destructive,
keep-both-and-rank-by-time posture Mana already borrowed from
Zep/Graphiti (2026-08 survey, tagged `borrow`). External validation, not
a new build item.

**Natural-language custom extraction include/exclude policy**
(mem0's `custom_fact_extraction_prompt` /
https://theneuralbase.com/mem0/learn/advanced/filtering-what-not-to-remember/)
— A user-configurable policy naming categories to always extract vs.
always exclude, applied *before* facts are written, not as a post-hoc
filter. Mana has an unusually broad sensor surface for a personal
companion (screen vision, browser automation, financial/job-search plugin
data, Discord/Telegram bridges) with no stated per-category
include/exclude control — a real, currently-missing privacy control that
fits Mana's local-first, user-owned-data posture directly.

**Graphiti bi-temporal edge model** (t_created/t_expired/t_valid/t_invalid)
— Already `borrow`-tagged in the 2026-08 survey and partially scoped as
#432. This round confirmed it via direct comparison against Mana's actual
`node-bot/memory-graph.js` code: the real memory graph is a Hebbian
associative graph over entity-co-occurrence pairs with a single scalar
weight and no fact semantics. **Correction**: bi-temporal validity
itself is *not* new to Mana — issue #431 already gave facts exactly this
pattern in `node-bot/acp-memory-store.js` (`validFrom`/`invalidatedAt`,
`applySupersedes()`, `getFactsValidAt(asOf)`). What's still true and
still the real scope of #620: `memory-graph.js`'s own edges don't have
it — bi-temporal validity is a genuinely distinct axis (association
strength vs. fact truth) that layers the *already-established* #431
pattern onto the Hebbian graph specifically, not a new mechanism to
invent. → **Issue #620.**

**Cognee `memify`: two-stage Extraction + Enrichment pipeline**
(https://docs.cognee.ai/core-concepts/main-operations/memify) — A
post-processing stage (never ingests raw data itself) built as a
composable chain of an Extraction task (pull a working set from the
existing graph) and an Enrichment task (process it, often via LLM, write
back). Built-ins include `consolidate_entity_descriptions`,
`cross_connect_entities`, `add_rule_associations`. **Correction**: this
doesn't map onto what Dream Mode *should be* doing — it maps onto what
Dream Mode *already does*. `triggerIdleConsolidation`
(`node-bot/server.js:1828-1897`) already runs 6 independent,
independently-failing stages, and one of them
(`runBackgroundEntityTyping`, line 1256) is already a real
extract-candidates → LLM-judge → merge pipeline structurally identical to
this pattern. The checklist item still genuinely open: derived-edge
synthesis and edge reweighting/pruning specifically on `memory-graph.js`'s
Hebbian edges (distinct from the entity-merge pipeline, which operates on
`acp-memory-store.js`'s typed entities). → **Issue #620.**

**`consolidate_entity_descriptions`: neighborhood-conditioned merging**
(https://github.com/topoteretes/cognee/blob/main/cognee/memify_pipelines/consolidate_entity_descriptions.py)
— **Correction**: this is not a "first implementable task" to build from
scratch — `runBackgroundEntityTyping` (`node-bot/server.js:1256`, logic in
`node-bot/entity-ontology.js`, issue #432) already does the extract
(untyped/candidate entities) + enrich (LLM classify and merge via
`findEntityMergeCandidates`/`buildEntityMergeJudgePrompt`/`setCanonicalAlias`)
shape this describes. The one thing not confirmed identical: whether the
existing pipeline rewrites a merged *description text* the way this
cognee pipeline does, or only collapses duplicate entities to a canonical
alias without touching description prose — worth checking before treating
this as fully redundant. → **Issue #620.**

**MemGPT / Letta — self-editing memory via OS-style paging**
— Explicit function-call tools let the model manage its own context like
virtual memory (core memory always resident, recall/archival paged in on
demand), the model itself deciding what to evict/fetch mid-conversation.
A live, in-conversation complement to Dream Mode's offline/batch
consolidation — give the running chat model tool-calls to pull specific
memory-graph nodes into context or push a fact to long-term storage right
when it decides it's relevant, rather than waiting for the next Dream
Mode cycle.

**Right-sizing components for concurrent local-GPU pipelines**
— A recurring pattern across the local-AI tooling space: purpose-built
lightweight components (a ~126MB-VRAM TTS model, embedding+reranker pairs
sized to coexist with an LLM) exist because the common failure mode is
each component working fine alone, then the whole stack falling over
(OOM, thermal throttling) once everything runs concurrently. This is
Mana's exact situation (LLM + Whisper + Fish Speech + avatar rendering,
plus gaming-mode competing for the same GPU). The actionable technique:
treat VRAM/compute budget as something each subsystem explicitly declares
and negotiates, rather than assuming each can always claim what it wants.

### Plugin / tool-calling architecture

**Neuro-sama Game SDK — Context/Registered-Actions/Forced-Actions protocol**
(https://github.com/VedalAI/neuro-sdk/blob/main/API/SPECIFICATION.md) —
The published protocol for third-party games to talk to Neuro-sama over
WebSocket/JSON: "context" pushes (with a silent flag distinguishing
knowledge updates from reply prompts) are separate from "register
actions" (name + description + a deliberately constrained JSON Schema
excluding `$ref`/`allOf`/`anyOf`/`oneOf` so small/local models can't
hallucinate malformed nested calls) and "forced actions" (a markdown
state blob, a directive query, a priority level governing whether it can
interrupt current speech, and a closed action list). A result must arrive
within ~20s or the call times out. The single most reusable piece of
engineering for Mana's plugin system: separate "push context" from "ask
for a decision," keep schemas simple, attach interruptibility priority,
require a bounded-time callback so a stalled plugin can't hang the loop.
Borrow the protocol shape, not the whole SDK. → folded into **Issue #621**.

**GBNF grammar-constrained tool calling**
(https://github.com/Maximilian-Winter/llama-cpp-agent) — llama.cpp
natively supports GBNF grammars that constrain decoding token-by-token so
the model physically cannot emit a token breaking a target grammar —
forcing valid JSON against a tool's schema as a hard decoding constraint
rather than a prompt instruction. `llama-cpp-agent` auto-generates such
grammars from function signatures. Since the grammar engine is already in
llama.cpp, this eliminates a whole class of malformed-tool-call failures
for free, no new dependency. → **Issue #621.**

**Model Context Protocol (MCP) as the tool-exposition layer**
(https://www.anthropic.com/news/model-context-protocol) — An open
protocol standardizing how an LLM client discovers/invokes tools exposed
by a server process, decoupling implementation from any specific
framework. **Correction**: this isn't a proposal for new work — Mana
already has it, in both directions. `node-bot/mcp-server.js` already
exposes Mana capabilities (FFXIV market, web search/read, wiki lookup)
as an MCP server over stdio (opt-in via `MANA_MCP_SERVER_ENABLED=1`,
documented as "Phase 1: implemented" in
`docs/roadmap/issue-42-mcp-support.md`), and
`node-bot/mcp-client-registry.js` (339 lines) already consumes
third-party MCP servers over stdio and streamableHttp, wired into
`server.js`'s tool loop. What's still genuinely missing at this call
site: GBNF grammar-constrained decoding (below). → **Issue #621**
(rescoped to GBNF only).

**Home Assistant Assist: intent-matching first, LLM tool-calling as fallback**
— The majority of spoken commands resolve through fast, deterministic
slot-filling against a fixed intent list; an LLM with tool-calling is a
fallback bolted on for anything that doesn't match, not the first thing
every utterance hits. Given Mana's gaming-mode resource constraint, a
lightweight intent matcher in front of the tool-calling loop for
common/frequent commands would cut LLM invocations for the routine
majority of requests.

**Semantic Router — embedding-based intent routing with zero LLM inference**
(https://github.com/aurelio-labs/semantic-router) — Pre-encodes example
utterances per route into embeddings; routing at runtime is a nearest-
neighbor vector comparison, no LLM call at all for the decision. Distinct
from routing-via-tool-calling (a full inference pass every turn).
Extending Mana's existing wake-word-is-not-an-LLM-call philosophy one
layer up, to plugin/agent selection, fits the resource-backoff
constraint well.

**Leon 2.0 brain: progressively-loaded tool schemas**
(https://github.com/leon-ai/leon) — Rather than dumping every tool schema
into context up front, only a stable baseline prompt is fixed; additional
tool schemas and context summaries load in as the conversation's needs
make them relevant. Because Mana runs local GGUF models with much
smaller effective context budgets than cloud models, indiscriminately
listing every plugin's schema in every prompt is comparatively expensive
— this is a fairly direct, higher-value borrow, and pairs naturally with
the intent-router idea above as a first filter for which schemas to load.

**Home Assistant MCP Server integration** (official) — HA itself ships an
MCP server exposing its own tools/prompts/a read-only entity-state
resource, scoped per-entity via HA's existing "expose to voice
assistants" flags. **Correction**: Mana doesn't need a "generic
MCP-client capability" built — `node-bot/mcp-client-registry.js` already
is one (stdio + streamableHttp transports, `mcp__`-prefixed tool
registration). The genuinely actionable idea here is narrower: configure
that existing client to attach to a user's own Home Assistant MCP server
as one more entry, and consider borrowing HA's per-entity
exposure-scoping convention as a model for how Mana's own MCP server
(`mcp-server.js`) could scope what it exposes, rather than building new
client infrastructure.

### Coding agent safety

**Claude Code subagents — isolated context windows, no automatic inheritance**
(https://code.claude.com/docs/en/sub-agents) — Each subagent is a fresh,
isolated instance with its own context/system prompt/tool scope; nothing
is inherited automatically. Mana's coding agent runs as a single linear
ACP loop with one growing context, which will fill up fast against local
coding-model context windows (far smaller than a hosted frontier model's)
on anything beyond a small edit. Splitting a coding task into explicitly-
scoped, isolated sub-tasks, each fed only the specific files/diffs it
needs, directly addresses that constraint.

**Adversarial "skeptic" verifier sub-agent with structured verdicts**
(https://dev.to/yureki_lab/how-i-got-my-ai-agent-to-catch-its-own-bugs-5-lessons-on-self-verification-2jd1)
— A separate agent prompted adversarially to "find where it breaks,"
defaulting to refuted unless safety is demonstrated, returning a typed
Verdict (boolean + concrete failing case) rather than free text. 2-3
differently-specialized skeptics (logic, security, reproduction) roughly
doubled bug detection versus one verifier run three times; gated to
logic-touching changes to control cost. Reported: ~1 in 6 "approved"
changes had bugs the test suite missed. → **Issue #622.**

**Claude Code Stop-hook + dedicated self-reviewer subagent**
(https://x.com/0x_rody/article/2063928611619455268) — A Stop hook blocks
the agent's turn from ending until the test suite is green, injecting
failures back into context instead of letting the agent declare done;
paired with a separate reviewer persona distinct from the generator.
**Note**: Mana's approval-gate/diff-preview handoff isn't relying purely
on the coding agent's own self-assessment today — `reply-verifier.js`'s
`verifyReply()` already runs an external (if static/heuristic) check
before replies are accepted. The genuine gap this pattern points at is
narrower: that check isn't an adversarially-prompted LLM sub-agent, and
there's no test-suite-gated Stop-hook equivalent confirmed to exist.

**Cline shadow-git checkpoints for autonomous coding agents** — A hidden
git repository, separate from the real project history, commits a full
workspace snapshot after every tool action; users get a diff view against
any checkpoint and three restore modes. **Correction**: Mana already has
a retrospective safety net that does something even when the human
rubber-stamps a bad diff — `node-bot/snapshot-store.js` (explicitly
"independent of git" per `server-routes.js:892`) records a snapshot
before every file write in `acp-autonomous-loop.js:718`, with
`snapshot_restore`/`snapshot_list` tools and workspace-snapshot routes
already wired up. It's JSON-based and per-file-write, not a git
repository with whole-workspace commits — the genuinely open question is
whether that difference (diffing against an arbitrary prior checkpoint,
whole-workspace vs. single-file scope) is worth the added complexity of a
second git repo, not whether a checkpoint system exists at all. →
**Issue #622** (rescoped accordingly).

### Avatar and expression

**ChatVRM (pixiv) — inline `[emotion]text` screenplay tags** — The LLM is
prompted to prefix each sentence with a bracketed emotion tag from a
fixed vocabulary; the client splits the streamed text into tagged
segments, switching the VRM blendshape expression per segment in sync
with playback. No separate emotion-classifier model — the LLM self-labels
as part of normal output. **Correction**: this isn't filling a total gap
— `windows-launcher/renderer/reply-emotion.js`'s `detectReplyEmotion()`
already does per-sentence, playback-synced mood detection in Electron
(kaomoji/emoji/word heuristics, not LLM tags). The genuine gap is the
*mechanism*: replacing that heuristic with LLM self-labeling, which the
original research rationale (more reliable, language-agnostic) still
holds for. `windows-native-launcher` has neither the heuristic nor
anything else — `VoiceLoop.cs` comments this is "a deliberate scope cut."
→ **Issue #623.**

**Open-LLM-VTuber — per-model `emotionMap` config**
— The same tag idea for Live2D Cubism models, with the emotion-to-
expression binding moved out of code into a per-avatar `model_dict.json`
(an emotion keyword can point to an expression-array index or a named
`.exp3.json` file, with a configured `defaultEmotion` fallback). A small
refinement on top of ChatVRM's pattern: new avatars are just a mapping
file, no tag-parsing code changes. → **Issue #623.**

### Screen and vision awareness

**Screenpipe** (https://github.com/mediar-ai/screenpipe, appearing twice
in the raw findings under slightly different framing — both instances
converged on the same two techniques) — An open-source, local-first
24/7 screen+audio capture pipeline that avoids fixed-interval sampling:
it listens for OS-level events (app switches, clicks, typing pauses,
scrolling) and only captures a new frame when something actually changed
— reported disk savings of roughly 6-7x versus naive continuous capture.
For text extraction it prefers the OS accessibility tree over pixels,
falling back to OCR (Tesseract/Apple Vision/Windows OCR) only when
accessibility data isn't available (games, remote desktops). Everything
indexes into a local SQLite+FTS5 database; typical CPU overhead is 5-10%.
It also has a plugin permission system ("pipes") with per-pipe
cryptographic tokens gating what an extension can read. **Correction**:
the "try Windows UI Automation before invoking the vision model" half of
this already exists in Mana — `windows-launcher/accessibility-tree.js` +
`readScreenContext()` (`renderer.js:2785-2836`, issue #343) already tries
the accessibility tree first and falls back to vision only when it's
empty or unavailable. It's just not wired into the periodic glance loop:
`runScreenSensingGlance()` (`renderer.js:2877`) still calls
`screen:capture-primary` directly, bypassing that existing logic
entirely. The fixed-timer-vs-event-driven gap is real and unaffected by
this correction. → **Issue #624** (rescoped to wiring the two paths
together).

**Purview-style content filtering applied pre-storage, not post-storage**
— The technique underlying Windows Recall's PII protection: filtering
happens on OCR'd/extracted text at ingest time, before the vector/
snapshot is committed to the semantic index, using pattern+ML classifiers
tuned for passwords, government IDs, and credit-card numbers — distinct
from filtering at query/output time, since an already-embedded-and-stored
value can leak even if a later response is filtered. Directly applicable
to Mana's memory graph / Dream Mode ingest boundary given the broad
screen/vision data surface. → **Issue #624.**

**OpenAdapt — record-a-demo, compile-to-verified-program**
(https://github.com/OpenAdaptAI/OpenAdapt) — Records a human performing a
GUI task once (screenshots, OCR, mouse/keyboard events, accessibility
data), then "compiles" the recording by mining the effect contract from
the observed state delta (what actually changed) rather than replaying
literal click coordinates, and verifies at replay time that the declared
effect actually occurred. A genuinely different pattern from anything
Mana currently does — learn-by-demonstration instead of hand-authored or
purely LLM-generated procedures — that maps almost exactly onto Mana's
existing "separate procedural skills layer": the user demonstrates a
repetitive GUI task once (an FFXIV market-board workflow, a job-
application form) and Mana compiles it into a verified, replayable skill.
Not filed as its own issue (bigger lift, no immediate acceptance
criteria without a concrete first target task) — worth a future
narrowly-scoped evaluation once a specific repetitive task is identified.

### Cross-surface orchestration and companion behavior

**File-based "signal bus" for cross-process UI state** (Sujatx/Jarvis,
https://github.com/Sujatx/Jarvis) — A voice process and a separate WebGL
visualizer never talk directly; instead the voice process writes small
files (`.voice_state`, `.voice_waveform`, `.voice_alert`) to a known
folder, and the visualizer polls/watches those files to animate
idle/listening/thinking/speaking states. Mana spans several UI surfaces
(Electron windows-launcher, the in-progress native WinForms launcher,
avatar rendering) that all need to reflect one live conversational state
— a dead-simple shared-state file (or named pipe) is a low-effort way to
keep them in sync during the Electron-to-native transition, and is easy
to debug by hand. **Caveat**: a grep for an existing file/pipe-based
state bus found nothing, but both launchers already talk to one shared
Node backend over HTTP (`ManaBackendClient.cs` on the native side,
`renderer.js`'s fetch calls on the Electron side) — some "live
conversational state" may already be consistent between them through
that channel rather than genuinely desynced. This wasn't independently
verified in the fact-check pass; worth confirming what's actually still
inconsistent between the two UIs before building a new sync mechanism.
Small enough to lift directly if a real gap is confirmed; not filed as
its own issue since it's more of an interim scaffolding choice than a
durable feature.

**CyberVerse (Lynpoint/CyberVerse)**
(https://github.com/Lynpoint/CyberVerse) — Splits the agent into a
PersonaAgent that owns the live voice turn (keeps talking, keeps latency
low) and background SubAgents that do slow work (tool calls, retrieval),
reporting back asynchronously instead of blocking the conversational
turn, plus an explicit real-time-performance ratio tracking whether
generation keeps pace with playback. Addresses a real risk in Mana's
design: the plugin system and the coding agent's tool-calling loop can
take seconds to minutes, and if invoked mid-voice-conversation would
currently stall the talking turn. Worth folding into the Home Assistant
Assist-style staged-event-bus work above rather than as a standalone
issue — the two are the same underlying orchestration layer.

**Companion-app proactive messaging patterns** (Nomi, Replika, Kindroid) —
Nomi: per-character frequency tiers plus a fixed quiet-hours window,
continuing the prior topic rather than generic pings. Kindroid: proactive
content pulled from long-term memory/diary, with an anti-spam backoff
that reduces outreach frequency automatically when messages go
unanswered. Replika: proactive check-ins always grounded in previously
mentioned emotional/contextual details. Concrete, self-contained policy
rules for Mana's existing Discord/Telegram bridges: quiet-hours + tiered
frequency, unanswered-message backoff, always ground proactive content in
retrieved memory rather than templated pings. Small enough to implement
directly against the existing bridge plugins without a dedicated issue —
worth doing as a follow-up policy change whenever the bridges are next
touched.

### Onboarding and hardware fit

**LM Studio — per-model hardware-fit indicators** — A compatibility
signal per model/quant in the model browser (green/yellow/red against
detected VRAM/RAM), so a user doesn't need to know their own headroom
before downloading a multi-GB file. **Note**: Mana's backend already
computes the underlying data for this (`model-management.js`'s
`detectGpuVramMb`/`detectSystemMemoryMb`/`recommendModelProfile`, tested,
exposed via `GET /models/status`) — the gap is purely that no UI displays
it yet. → **Issue #625.**

**AnythingLLM — single-executable bundle with hardware-based auto-recommendation**
— Ships its whole stack (LLM runtime, vector DB, embedding model,
document parsers) as one binary per OS; first run auto-recommends a model
based on detected hardware, only later exposing advanced/scaling options.
**Correction**: the auto-recommendation step isn't missing from Mana's
backend — `model-management.js`'s `recommendModelProfile({vramMb, ramMb})`
already computes exactly this and is test-covered. What's missing is
surfacing it: a grep across `ManaBackendClient.cs`, `SettingsPanel.cs`,
and `renderer.js` confirms zero references to the `recommendation` field
anywhere in either launcher's UI — it's dead data on the wire. →
**Issue #625** (rescoped to surfacing existing data, not computing new
data).

**NVIDIA RTX AI / Windows AI Toolkit — hardware-aware backend auto-selection**
— Tags each model/engine build with the specific GPU/NPU it's compiled
for and auto-selects the matching build (CUDA vs. TensorRT-LLM vs.
CPU/DirectML) rather than making the user choose. Maps directly onto a
real Windows problem for Mana: llama.cpp has separate CUDA/Vulkan/CPU
(and ROCm) builds a non-technical user has no way to choose between
correctly. → **Issue #625.**

## Selected `borrow-narrow` and `stretch` highlights

The `borrow-narrow` tier (180 items) and `stretch` tier (62 items) are
too large to detail exhaustively here without duplicating most of the
`borrow` tier's ground. The full lists (names only) and the underlying
per-agent detail are preserved in this session's workflow journal
(`journal.jsonl` under the workflow run) for future reference if any of
these warrant promotion. The following stood out as worth naming now,
beyond what the `borrow` tier already covers:

- **NVIDIA NVIGI / G-Assist GPU scheduling modes for game+AI coexistence** (`stretch`) — directly on-target for Mana's gaming-mode backoff constraint specifically; not pursued now only because it's a heavier platform-integration lift than the `borrow`-tier items, but worth revisiting if gaming-mode backoff proves insufficient on its own.
- **Kyutai Moshi full-duplex dual-stream architecture** (`stretch`) — a genuinely different (harder, higher-payoff) approach to natural conversation than the cascaded STT/LLM/TTS pipeline Mana and most of the `borrow` tier assume; worth tracking as the field matures, not a near-term fit given Mana's per-role swappable-model architecture.
- **Raven wake-word engine (DTW/MFCC template matching, no training required)** (`borrow-narrow`) — a zero-training alternative to openWakeWord's trained-ONNX approach, worth a mention as a fallback if training a custom wake word proves impractical.
- **NanoWakeWord — phonetic-confusable synthesis to cut wake-word false positives** (`borrow-narrow`) — a specific data-augmentation technique to layer onto the openWakeWord training pipeline in issue #618 if false-positive rate is a problem after the initial swap.
- **llama-swap — external hot-swap proxy for GGUF models** (`borrow-narrow`) — relevant to Mana's per-role model-swapping infrastructure; worth a look whenever that subsystem is next revisited.
- **ReVeal / VIGIL — self-evolving/self-healing code agents via reliable self-verification** (`stretch`) — a heavier-weight relative of the adversarial-verifier pattern in issue #622; worth revisiting once the simpler verifier is in place and proven useful.
- **Anthropic's multi-agent research system — orchestrator-worker with externalized plan memory** (`stretch`) — relevant if Mana's coding agent or plugin orchestration ever needs genuine multi-agent fan-out rather than a single linear loop; not an immediate fit for the current single-agent ACP loop.

## Recommendation

Eight issues filed from this research, in the order listed under
"Top recommendations" above: #618, #619, #620, #621, #622, #623, #624,
#625. Each issue's body carries its own Goal/Why/Proposed
Scope/Acceptance Criteria; the `docs/roadmap/issue-NNN-*.md` companion
doc for each mirrors that scope and links back here for the full research
backing.

**Update (2026-09-12)**: a follow-up codebase fact-check found 7 of the 8
issues overstated what was missing (see the correction notice near the
top of this document). All 7 were rewritten in place — same issue
numbers, corrected scope, citing the real prior-art file paths/line
numbers and issue numbers (#431, #432, #343, #219, #42) the original
research missed. Only #618 (wake-word classifier) was accurate as
originally filed.

## Related

- `docs/roadmap/oss-inspiration-survey-2026-08.md` — prior survey; this
  document extends rather than duplicates its memory-architecture and
  companion-persona coverage.
- #432 — ontology-typed extraction + derived-facts (extended by #620).
- #508 / `docs/roadmap/issue-508-obscura-browser-engine-eval.md` — browser
  engine evaluation (separate track, not touched by this research).
- #556 — Heretic on-demand decensoring evaluation (separate track, not
  touched by this research).
