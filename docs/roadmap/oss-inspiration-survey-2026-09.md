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

## Top recommendations

Ranked by expected impact relative to effort, given Mana's own
constraints (local-first, swappable per-role models, gaming-mode
resource backoff as a first-class constraint):

1. **Dedicated wake-word classifier ahead of continuous Whisper** — issue #618. Highest-leverage single change: replaces always-on full ASR inference with a near-zero-cost gate.
2. **Echo suppression + turn-detection for TTS playback** — issue #619. Closes a real self-triggering risk and is a prerequisite for natural barge-in.
3. **MCP + GBNF grammars for the plugin/tool-calling layer** — issue #621. Removes a whole class of malformed-tool-call failures for free (grammar engine already in llama.cpp) and stops the plugin surface from growing more bespoke over time.
4. **Adversarial verification + shadow-git checkpoints for the coding agent** — issue #622. A second, differently-shaped safety net on top of the existing approval gate, not a replacement for it.
5. **Dream Mode as a composable extract/enrich pipeline + bi-temporal edge validity** — issue #620. Extends the already-tracked #432 work with two more independently-validated patterns (cognee's `memify`, Graphiti's bi-temporal edges).
6. **Inline per-sentence emotion tags for avatar expression** — issue #623. Cheap, zero-new-model, works with any swappable local chat model via prompting alone.
7. **Event-driven, accessibility-tree-first ambient vision loop + pre-storage PII filtering** — issue #624. Cuts vision-model calls and closes a real privacy gap (secrets on screen ending up in long-term memory).
8. **Hardware-aware model recommendations + backend auto-selection at first run** — issue #625. Directly relevant to the in-progress native launcher (PR #538); prevents a real class of "picked a model my GPU can't run" failures for non-technical users.

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
hit on Mana's design. → **Issue #619.**

**Mic muting / AEC during TTS playback**
(https://github.com/rhasspy/wyoming-satellite/issues/250) —
`wyoming-satellite` mutes mic input for a configurable window around
chime/TTS playback (`--mic-no-mute-during-awake-wav`,
`--mic-seconds-to-mute-after-awake-wav`); Home Assistant's own reference
hardware instead uses a dedicated XMOS XU316 DSP chip for real AEC so the
mic can stay open and be interrupted mid-speech. → **Issue #619.**

**WebRTC AEC3 standalone acoustic echo cancellation for open-mic barge-in**
— AEC3 has been extracted from the full browser stack specifically so
non-browser voice-assistant projects can link just the echo canceller,
feeding it the outgoing TTS PCM as the far-end reference alongside the
live mic input. This is close to a hard prerequisite for reliable
speaker-based (non-headset) barge-in — the piece most conspicuously
absent from Mana's described architecture if the avatar plays TTS through
real speakers. → **Issue #619.**

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
CPU, decoupled from any specific STT/LLM/TTS. The most concretely
adoptable turn-detection finding: cheap enough to keep running even under
gaming-mode GPU reservation. → **Issue #619.**

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
demand, never pinned to context). Mana's memory graph functions closer to
archival memory alone — keeping a second, un-summarized raw-transcript
tier searchable by the LLM is valuable precisely because Dream Mode's
consolidation is lossy; when the graph's summary is insufficient, the
agent can fall back to verbatim recall.

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
weight and no fact semantics — bi-temporal validity is a genuinely
distinct axis (association strength vs. fact truth) that layers cleanly
onto a typed-edge upgrade without displacing the Hebbian graph. →
**Issue #620.**

**Cognee `memify`: two-stage Extraction + Enrichment pipeline**
(https://docs.cognee.ai/core-concepts/main-operations/memify) — A
post-processing stage (never ingests raw data itself) built as a
composable chain of an Extraction task (pull a working set from the
existing graph) and an Enrichment task (process it, often via LLM, write
back). Built-ins include `consolidate_entity_descriptions`,
`cross_connect_entities`, `add_rule_associations`. Maps almost
one-to-one onto what Dream Mode should be doing, with a concrete
checklist: prune unused edges, reweight frequently-traversed ones, merge
duplicate entities, synthesize derived edges. → **Issue #620.**

**`consolidate_entity_descriptions`: neighborhood-conditioned merging**
(https://github.com/topoteretes/cognee/blob/main/cognee/memify_pipelines/consolidate_entity_descriptions.py)
— The concrete first implementable task: pull an entity's local
neighborhood (connected edges + neighbor descriptions), have an LLM
produce one merged description via structured output, replace the
fragments. Narrow, well-scoped, liftable close to as-is. → **Issue #620.**

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
framework. Exposing Mana's plugins as local MCP servers (stdio, no
network dependency) would let Mana consume the growing MCP-server
ecosystem without hand-writing new plugins for capabilities that already
exist, and let the coding agent and companion chat loop share one
tool-calling interface. → **Issue #621.**

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
assistants" flags. The inverse of Mana's plugin model: give Mana's
plugin system a generic MCP-client capability (attach any MCP server by
URL+token) instead of hand-rolling integrations, one instance of which
could be attaching to a user's own Home Assistant instance for free.

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
Close in shape to what Mana's approval-gate/diff-preview handoff needs: a
concrete pattern for not relying on the coding agent to self-assess
honestly.

**Cline shadow-git checkpoints for autonomous coding agents** — A hidden
git repository, separate from the real project history, commits a full
workspace snapshot after every tool action; users get a diff view against
any checkpoint and three restore modes. Distinct from — and composes
with, rather than duplicates — Mana's existing prospective approval gate:
a retrospective safety net that does something even when the human
rubber-stamps a bad diff. → **Issue #622.**

### Avatar and expression

**ChatVRM (pixiv) — inline `[emotion]text` screenplay tags** — The LLM is
prompted to prefix each sentence with a bracketed emotion tag from a
fixed vocabulary; the client splits the streamed text into tagged
segments, switching the VRM blendshape expression per segment in sync
with playback. No separate emotion-classifier model — the LLM self-labels
as part of normal output. Directly applicable to Mana's Live2D/VRM
avatar, zero new model dependency, works with any local chat model via
prompting alone. → **Issue #623.**

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
cryptographic tokens gating what an extension can read. Close to a direct
blueprint for Mana's ambient glance loop: gate the whole loop on OS
events rather than a timer, and try Windows UI Automation before invoking
the vision model — a local VLM call is far more expensive than an
accessibility API read. → **Issue #624.**

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
to debug by hand. Small enough to lift directly; not filed as its own
issue since it's more of an interim scaffolding choice than a durable
feature — worth doing inline whenever the native launcher's live-state
sync is next touched, rather than as separately tracked work.

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
before downloading a multi-GB file. → **Issue #625.**

**AnythingLLM — single-executable bundle with hardware-based auto-recommendation**
— Ships its whole stack (LLM runtime, vector DB, embedding model,
document parsers) as one binary per OS; first run auto-recommends a model
based on detected hardware, only later exposing advanced/scaling options.
Mana already bundles many local services behind one launcher — what's
missing is the auto-recommendation step itself. → **Issue #625.**

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

## Related

- `docs/roadmap/oss-inspiration-survey-2026-08.md` — prior survey; this
  document extends rather than duplicates its memory-architecture and
  companion-persona coverage.
- #432 — ontology-typed extraction + derived-facts (extended by #620).
- #508 / `docs/roadmap/issue-508-obscura-browser-engine-eval.md` — browser
  engine evaluation (separate track, not touched by this research).
- #556 — Heretic on-demand decensoring evaluation (separate track, not
  touched by this research).
