# OSS inspiration survey (2026-07): AI companions, personal assistants, coding agents, Live2D

## Status: research only, nothing implemented from this doc yet

A GitHub survey across four categories -- AI companion projects, local-first
personal assistants, Live2D/VTuber tooling, and personal coding agents --
looking for genuinely new ideas for Mana. Project AIRI (moeru-ai/airi) was
deliberately excluded: it's already been extensively mined in prior work
(idle saccades, spectral-centroid mouth shape, the Live2D model validator,
mobile app architecture scoping, and the design that led to issue #253's
expression-tool work).

Each entry below is `borrow` (worth a concrete follow-up), `borrow-narrow`
(one specific technique worth lifting, not the whole project), or `skip`
(nothing beyond what Mana already has, or doesn't fit Mana's design
philosophy).

## AI companion / VTuber-assistant projects

### Miru -- github.com/kiyotakali/Miru — `borrow`
~52 stars, early but actively developed, single dev. Genuinely novel
architecture: a screen sensor glances at the display every 60s, extracts a
semantic summary, then **discards the image** -- privacy-by-construction,
never stores raw screenshots. An "AttentionEngine" decides *when* to
interrupt the user based on detected state (stays quiet during focused
work, speaks up on detected fatigue/frustration). A nightly "sleep agent"
consolidates the day's activity into four plain-Markdown memory categories
(projects/people/facts/topics) + a daily journal -- auditable, diffable, no
vector-DB black box.

**Why it matters for Mana**: Mana's memory has facts/summaries/entity tags
but no proactive-timing engine and no "watch the screen, discard the
pixels, keep the meaning" ambient-context loop. The discard-the-image
pattern paired with an attention/timing gate is a cheap, privacy-preserving
way to give Mana situational awareness without a permanent screen-recording
feature -- and the "stay quiet vs. speak up" decision is a natural fit for
Mana's existing approval-gated-action framework (same gate, new trigger
source).

### Soul of Waifu -- github.com/jofizcd/Soul-of-Waifu — `borrow-narrow`
~348 stars, solo dev, active. Three standout pieces: (a) **self-healing
memory** -- detects contradictions between a new fact and a stored one,
auto-overwrites with a logged correction, plus "emotional decay" so
moods/grudges fade over time instead of persisting forever; (b) a separate
AI Game Master layer ("Soul Stage") running an independent RPG state
machine alongside the companion character; (c) desktop-overlay behavior
driven by a simulated neurohormone system (fatigue after long sessions,
boredom on idle) instead of scripted proactive-message rules.

**Why it matters for Mana**: the contradiction-detection-and-overwrite pass
is the concrete, low-effort win -- bolt a "does this new fact conflict with
a stored one?" check onto Mana's existing memory writer, log the
correction, and get self-healing memory almost for free. The RPG/game-master
layer is neat but scope creep unless roleplay is an actual goal for Mana.

### Open-LLM-VTuber -- github.com/Open-LLM-VTuber/Open-LLM-VTuber — `borrow-narrow`
~13k stars, 1.5k forks, active. Local voice-interactive companion with a
Live2D face, swappable local LLM/ASR/TTS backends. Two things stand out:
(a) drives facial expressions by having the LLM emit **inline expression
tags in its text response** (e.g. `[joy]`), parsed by the frontend and
mapped to Live2D motions -- no separate tool call, no function-calling
support needed, just prompt convention; (b) runs VAD that specifically
**excludes its own TTS output** from triggering "user is talking," enabling
barge-in interruption without the AI hearing itself.

**Why it matters for Mana**: the inline-tag approach solves the same
problem issue #253's `expression__set` tool solves, but works on *any*
model/profile, not just when tool-calling is enabled and the profile is
`"default"` -- a real, already-flagged limitation of the tool-call design.
Not adopted for #253 (see that issue's own notes for the tradeoff reasoning:
tool-calling stays the more durable long-term direction as it expands past
the default profile), but worth revisiting if the profile restriction turns
out to matter in practice. Separately: check whether Mana's own voice
pipeline already excludes its own TTS output from VAD triggering -- if not,
this is a small, well-proven, directly-portable fix for barge-in.

### Amica -- github.com/semperai/amica — `skip`
~1.6k stars, active. Web-first (Next.js + three-vrm + Tauri) VRM chat
interface, technically polished but architecturally a reimplementation of
things Mana already has (avatar rendering, swappable local TTS/STT, tool
backends). Its one differentiator -- in-page inference via Transformers.js
-- doesn't apply to Mana's Electron+Node architecture.

## Local-first personal assistant projects

### Letta (formerly MemGPT) -- github.com/letta-ai/letta — `borrow-narrow`
~24k stars, very active. OS-inspired tiered memory: "core memory" (always
in-context, agent-editable, acts like RAM), "archival memory" (external
vector store, queried via explicit tool calls, acts like disk). The agent
itself decides via tool calls when to page memory in/out -- self-managed
context compaction rather than a fixed summarizer.

**Why it matters for Mana**: the narrow, worth-stealing piece is "the agent
edits its own core memory via tool call" -- if Mana's memory writes
currently happen mostly out-of-band (a background summarizer), a small
`memory_edit`/`memory_archive` tool pair could let the model promote/demote
what's pinned in context itself. Don't adopt the whole platform -- Letta is
a heavyweight multi-tenant agent server, overkill for a single local
companion.

### OpenVoiceOS (ovos-core) -- github.com/OpenVoiceOS/ovos-core — `skip`
Mycroft successor, layered intent-matcher, skills as installable packages,
HiveMind for multi-device/multi-satellite coordination. Its distributed
satellite model is the closest match to Mana's own Discord/Telegram/mobile-
PWA remote-bridge design -- already solved similarly in Mana. Nothing
structurally new.

### Linux Voice Assistant (OHF-Voice) -- github.com/OHF-Voice/linux-voice-assistant — `borrow-narrow`
552 stars, active; successor to the archived `rhasspy/wyoming-satellite`.
Full always-listening wake-word detection on ordinary Linux hardware, using
openWakeWord or microWakeWord with a dual-engine fallback, plus WebRTC
noise-suppression/AGC on the mic path.

**Why it matters for Mana**: Mana already runs Silero VAD + local wake-word,
so this isn't a new capability -- but if Mana's wake-word false-positive
rate is ever a known pain point, the dual-engine fallback and WebRTC
AGC/noise-suppression preprocessing are concrete, provenpatterns worth
borrowing for hardening.

**No project found** with real technical substance for beat-sync/music-
reactive avatar features or on-device mobile inference -- only thin hobby
repos (Electron waveform visualizers, VRChat AudioLink, small Android GGUF
wrappers). Both gaps remain genuinely open for Mana to be first at, if ever
picked up (see issue #253's beat-sync section and issue #258's mobile
scoping doc).

## Live2D / VTuber tooling

### wLipSync -- github.com/mrxz/wLipSync — `borrow`
79 stars, 4 forks, small but functional/maintained. A WASM+WebAudio port of
Unity's uLipSync algorithm: extracts MFCCs (Mel-Frequency Cepstral
Coefficients -- a multi-coefficient fingerprint of vocal-tract resonance,
not just a loudness/brightness proxy), compares against calibrated
phoneme profiles, drives per-phoneme blend-weights. Packaged as an npm
module (`wlipsync`) with a `.weights`/`.volume` output read per animation
frame.

**Why it matters for Mana**: this is a real technique upgrade over Mana's
current RMS-amplitude + spectral-centroid mouth-shape heuristic --
centroid is a single scalar easily fooled by sibilants/noise, whereas MFCC
genuinely discriminates viseme shapes ("ah" vs "oo" vs "ee"). Mana already
runs PIXI.js/Electron (a Web-Audio-capable context), so the WASM+
AudioWorklet package could plug in directly where the current heuristic
lives. Real integration cost: needs calibration profiles per voice/model,
and the project is small/lightly-adopted -- treat as "technique to port,"
not "dependency to install blindly."

### VTube Studio API protocol -- github.com/DenchiSoft/VTubeStudio — `borrow-narrow`
Not a rendering library -- the local WebSocket API spec VTube Studio itself
exposes to plugins. Far richer than "trigger a named expression": plugins
push raw parameter values continuously (`InjectParameterDataRequest`, >=1/sec),
meaning any Live2D parameter can be driven frame-by-frame, with per-plugin
custom parameters, physics overrides, and ease/fade timing on expression
activation.

**Why it matters for Mana**: not the protocol itself (Mana doesn't need a
VTS-compatible socket), but the *design pattern* -- continuous
raw-parameter injection with fade/ease timing, instead of Mana's current
discrete state-swap. That would let Mana blend between expressions (e.g.
70% happy + 30% surprised, with a fade curve) instead of snapping between
named states. Relevant if/when issue #253's expression system ever wants to
evolve past discrete named expressions.

### hecomi/uLipSync -- github.com/hecomi/uLipSync — `skip` (reference only)
The Unity/C# original wLipSync ports from. ~1.2-1.6k stars, actively
maintained. Same MFCC technique as above; not directly usable since it's
Unity, but the algorithm description is the primary source if wLipSync's
port ever needs debugging or reimplementing directly in JS.

### DenchiSoft/Live2DFrequencyLipSync — `skip` (reference only)
Smaller Unity reference implementation of frequency-domain (not full MFCC)
lip-sync driving four discrete mouth shapes (closed/open/pressed/kiss). A
lighter middle ground between RMS and full MFCC, worth knowing as a
fallback design if wLipSync's calibration overhead turns out to be too much
-- not a library to pull in, it's Unity example code.

### Open-LLM-VTuber (Live2D angle) — `skip`
Same project as above; its `emotionMap`/`idleMotionGroup` config-driven
approach is architecturally the same state->expression lookup pattern Mana
already has, and its idle-motion-group random-pick logic matches AIRI's
(already mined). Nothing new on the Live2D side specifically.

## Personal coding-agent projects

### Plandex -- github.com/plandex-ai/plandex — `borrow`
~15.6k stars, active. Writes changes into a sandbox separate from the real
working tree -- a "cumulative diff review" area -- rather than touching
files directly. Tree-sitter project maps (30+ languages) with per-step lazy
loading. Changes accumulate as a diff; nothing lands in real files until an
explicit user action applies them. Version-controlled plan history with
branches for exploring alternate approaches.

**Why it matters for Mana**: this is a genuinely new middle rung between
"never touch files" (Mana's coding-mode today: detect intent, hand off to
Zed/VS Code, never auto-edit) and "edit live, review after" (Aider/Cline).
Mana could adopt this shape without violating its own "nothing persists
without review" rule -- e.g. coding-mode could draft a proposed patch to a
scratch location and hand the *diff* to the editor's native diff/review UI
(both Zed and VS Code support opening a diff view) instead of just opening
the file and stepping back. Strictly safer and more useful than plain
hand-off, without crossing into auto-edit.

### Cline -- github.com/cline/cline — `borrow-narrow`
~65k stars, very active. Per-action approval gate (every file edit/terminal
command needs explicit approval, with an opt-in auto-approve toggle);
separate Plan mode (discuss/propose) vs. Act mode (execute); auto-snapshot
checkpoints before each agent action for rollback.

**Why it matters for Mana**: the Plan/Act split is a nice UX pattern --
propose the intended change set in chat first, only step into action after
confirmation -- that coding-mode could borrow conceptually for *how it
phrases a hand-off*. Doesn't add a new safety primitive beyond what Mana's
approval-gate already gives (arguably Mana's gate is already stricter: full
stop, nothing persists without review, vs. Cline's opt-in auto-approve).

### Goose (Block) -- github.com/block/goose — `borrow-narrow`
~52k stars, Linux Foundation project, very active. Full-autonomy MCP-
extension-based agent (doesn't fit Mana's review-gated philosophy at all).
One structural idea worth borrowing: its "recipes" -- reusable, shareable,
**parameterized** workflow definitions with named/typed inputs, more like a
callable procedure than freeform narrative markdown.

**Why it matters for Mana**: could lightly enhance Mana's skills system --
a skill that declares "inputs" so node-bot can recognize "this is recipe X
with args Y" rather than relying only on prose-similarity retrieval. Not
the edit/autonomy model, just the recipe-parameterization idea.

### Aider -- github.com/Aider-AI/aider — `skip`
~48k stars, extremely active. Edits directly by default, auto-commits every
edit with a generated message; git itself is the approval gate (review/
revert after the fact, not before). This is exactly the "full write access,
review after" model Mana's design explicitly rejects. Its tree-sitter
"repo map" validates Mana's existing cheap-index/full-content-on-demand
skills pattern rather than adding anything new.

## Summary: concrete next steps worth considering (not committed to)

1. Screen-sensing with discard-the-pixels + attention-gated proactivity (Miru) -- new capability, real design work.
2. Contradiction-detection on memory writes (Soul of Waifu) -- small, bolts onto the existing memory writer.
3. Self-TTS-exclusion check in Mana's voice pipeline (Open-LLM-VTuber) -- verify first, may already be handled.
4. MFCC-based lip-sync via a wLipSync-style port -- real quality upgrade, real integration cost (calibration).
5. Sandboxed-diff-then-explicit-apply for coding-mode (Plandex) -- a safer middle rung than plain editor hand-off.
6. `memory_edit`/`memory_archive` self-managed tool pair (Letta) -- narrow, optional.
7. Parameterized skill "recipes" with typed inputs (Goose) -- narrow, optional.

None of these are scheduled. Revisit if picked up as an actual issue.
