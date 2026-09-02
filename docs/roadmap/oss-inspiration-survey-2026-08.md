# OSS inspiration survey (2026-08): companions, coding agents, voice stack, memory

## Status: research only, nothing implemented from this doc yet

Follow-up to `oss-inspiration-survey-2026-07.md`, run across four parallel
tracks against `docs/roadmap/INDEX.md` so nothing already implemented or
already scoped out gets re-proposed: AI companion/avatar projects, coding-
agent tooling, the local voice stack (STT/TTS/VAD/wake-word), and memory
frameworks + messaging/platform integrations.

Tags follow the July survey's convention: `borrow` (worth a concrete
follow-up), `borrow-narrow` (one specific technique, not the whole
project), `stretch` (real but bigger lift or narrower payoff), `skip`
(noted and explicitly excluded, for the record).

## AI companion / avatar projects

### Model-invoked vision as a tool call -- my-neuro (morettt/my-neuro) -- `borrow`
Lets the LLM itself decide mid-reply when to look at the screen
("language-intent-based activation"), instead of only reacting to the
`Ctrl+Alt+M` hotkey or the passive ambient-glance loop. Mana's tool-calling
loop (#183) and existing tool sources (`expression-tool-source.js`,
`skill-tool-source.js`) already give this an idiomatic home -- a
`vision_look`-style tool source is a small, in-pattern addition, not new
infrastructure.

### Live view for browser automation -- Open-LLM-VTuber v1.2 (BrowserBase MCP) -- `borrow-narrow`
Streams a live view of what an automated browser is doing as it acts.
Mana's `plugins/browser-automation/browser-automation.js` currently returns
only plain text extraction -- no visual feedback while Playwright acts. Fits
Mana's existing "propose, don't silently act" philosophy (editor handoff,
approval gate) applied to a plugin that currently behaves like a black box.

### Real-time voice conversion (RVC), decoupled from TTS -- z-waif (SugarcaneDefender/z-waif) -- `stretch`
A Retrieval-based Voice Conversion layer on top of whatever TTS/STT is in
use, converting *any* input audio (including mic input, not just TTS
output) to a target voice cheaply and in real time. Different mechanism
from Fish Speech's built-in reference-audio cloning. Worth revisiting only
if cloning quality/speed becomes a bottleneck, or for a "talk in Mana's
voice" novelty feature -- not a near-term pick.

### Sandboxed plugin widget UI -- AIRI Gamelet API (`plugin.airi.json`) -- `stretch`
Plugins ship their own iframe-sandboxed widget UI, not just backend logic
(reference example: a chess gamelet). Mana's `plugins/` system is
backend-only today. Bigger architectural lift than anything else in this
survey -- worth knowing as a pattern if a future plugin (job tracker, market
dashboard) wants a richer in-app view, not worth building ahead of that
need.

### Spine2D as a third avatar format -- AIRI v0.11.0 -- `skip`
Adds a rendering pipeline for a format with a much smaller anime-avatar
ecosystem than Live2D's. Only worth it if a specific user already owns a
Spine2D model; not worth pursuing speculatively.

## Coding-agent tooling

### Close the verification loop -- SWE-agent / general agent pattern -- `borrow`
Auto-run tests, parse failures, re-inject as context, retry up to a bounded
cap. Called out repeatedly as the single highest-leverage capability across
current coding agents. Mana already has both halves as separate primitives
-- `node-bot/acp-test-runner.js` (guarded, allowlisted test runner) and
`node-bot/acp-autonomous-loop.js` (tool-call loop with per-session call
caps) -- but neither currently feeds parsed test failures back into the
loop. This is wiring existing pieces together, not new infrastructure.

### Lint/syntax pre-validation before a proposal reaches review -- SWE-agent ACI -- `borrow-narrow`
Runs a linter at edit time and rejects syntactically broken edits before
they're ever shown to the reviewer. Complements Mana's approval gate (#152)
by catching garbage before spending a human review cycle on it.

### User-extensible deterministic hooks -- Claude Code (`PreToolUse`/`PostToolUse`) -- `borrow-narrow`
Project-declared, user-authored shell hooks (allow/deny/ask/modify-input),
separate from any built-in agent logic. Mana's unified audit layer (#188)
is a fixed internal gate; a local per-project hook config ("always run
prettier after a write," "block writes under `.env`") is a natural,
low-infra extension for a single-user local app.

### Hunk-level accept/reject -- avante.nvim, Cursor -- `borrow-narrow`
Approve individual diff hunks instead of all-or-nothing. Direct refinement
of Mana's existing `editors/workspace/proposals` diff preview -- needs a
data-model change (hunks as addressable units), not new infrastructure.

### Named restore points, independent of git -- Cursor checkpoints -- `borrow-narrow`
Auto-snapshot before each agent action, restorable per-turn from the chat
timeline, deliberately separate from git state. Mana's proposals are
pre-apply only; once applied there's no restore UI beyond a raw `.bak`
file. A lightweight timestamped/restorable snapshot list fits a local
single-user app cheaply.

### Visible token/cost budget meter -- opencode -- `stretch`
Per-session token/cost tracking with configurable budget thresholds. Mana
already caps tool-call *count* per session; most relevant once
`MANA_ALLOW_REMOTE_AI` is on, since local inference has no metered cost --
narrower payoff than the other items here.

### Full sandboxed execution (Docker-isolated runtime) -- OpenHands -- `skip`
Every shell command/test/write runs inside a per-task Docker container.
Wrong weight class for a single-user Windows companion app that assumes no
Docker dependency. A narrower "run tests against a scratch copy of the
workspace" variant would fit better than full containerization, if this
ever becomes worth doing.

## Voice stack (STT / TTS / VAD / wake-word)

### openWakeWord -- dscripka/openWakeWord -- `borrow`
A small trained wake-word classifier (not a fuzzy string match) that runs
continuously and cheaply on CPU, detecting the wake phrase directly from
audio. Mana's current wake-word detection is continuous whisper.cpp
transcription fuzzy-matched (edit-distance-1) against the transcript text
-- a real architecture change, not a tuning knob, that could cut both false
triggers and constant STT load. Bigger lift: needs a trained/fine-tuned
"Mana" wakeword and a second always-on model running alongside whisper.cpp.

### Whisper large-v3-turbo as a new model profile -- `borrow`
Pruned-decoder Whisper variant (32->4 decoder layers), ~7x faster than
large-v3 with a modest accuracy tradeoff, already whisper.cpp-compatible
(GGML weights exist). A free addition to the existing
tiny/base/small/medium profile list (#4) -- no architecture change, no new
runtime.

### sherpa-onnx streaming ASR (k2-fsa) -- `borrow-narrow`
ONNX-Runtime toolkit with genuinely streaming (Zipformer/Paraformer/
Conformer) models that emit partial transcripts word-by-word, unlike
whisper.cpp's chunk-then-decode cycle. Native Windows builds exist.
Moderate lift -- a new runtime alongside whisper.cpp, not a swap.

### NVIDIA Parakeet-TDT (ONNX export) -- `stretch`
Reported 5-10x faster than Whisper on CPU with comparable-or-better
accuracy; v3 covers 25 languages. Runnable via ONNX Runtime without
NeMo/CUDA. Ecosystem still skews Python/NeMo-first -- verify the ONNX
export's Windows packaging before committing to this over sherpa-onnx.

### pyannote.audio speaker diarization -- `stretch`
Local, offline-loadable diarization (segmentation + embedding +
clustering) that acoustically separates speakers from a single shared
audio stream -- unlike Mana's Discord per-speaker transcription, which
relies on Discord's per-user audio channels rather than diarizing. Would
enable multi-person single-mic scenarios (e.g. the video-watch plugin).
CPU-only is slow (~2.2s compute per 1s audio per published benchmarks) --
real-time use likely needs GPU.

### Chatterbox TTS (Resemble AI) -- `stretch`
MIT-licensed zero-shot voice cloning like Fish Speech already offers, plus
an emotion-exaggeration intensity control Mana's stack doesn't have, and a
June 2026 multilingual release (25 languages) on a 0.5B backbone. Would be
an additional/alternate provider, not a strict upgrade over Fish Speech --
worth a spike to confirm Windows viability mirrors Fish Speech's.

### Kyutai Delayed Streams Modeling (full-duplex STT+TTS) -- `skip` (for now)
Full-duplex streaming STT/TTS built for continuous conversational audio
instead of discrete request/response turns -- the biggest conceptual
departure from Mana's current pipeline. Interesting long-term direction,
but current optimization skews Mac (MLX)/CUDA and Windows CPU support is
unconfirmed. Exploratory, not near-term.

## Memory frameworks

### Bi-temporal fact invalidation -- Zep / Graphiti -- `borrow`
Every graph edge carries two timestamps: when a fact became true in the
world, and when the system learned it. A contradicting new fact marks the
old edge *invalid* rather than overwriting or deleting it, so the full
timeline stays queryable ("what did I believe was true in March?"). Mana's
Hebbian graph tracks associative strength, not fact validity over time --
this is a distinct axis worth adding to entity/relation edges, not a
framework swap.

### Ontology-typed extraction + graph-inference pass -- cognee -- `borrow-narrow`
Entities/relations extracted against a defined ontology instead of
open-vocabulary LLM labels (cuts synonym/drift noise), plus a
post-ingestion pass that infers new derived facts from existing graph
structure (multi-hop/transitive), not just what was explicitly stated. The
typed-extraction half would tighten entity tagging; the derived-facts half
is a genuinely new capability beyond consolidation and connection-making.

### mem0's ADD/UPDATE/DELETE/NOOP decision engine -- `skip`
Mechanically overlaps too much with Dream Mode consolidation plus the
already-noted contradiction-detection idea from the July survey -- "another
memory database with LLM-judged CRUD," not a new mechanism.

## Integrations (messaging / platform)

### Home Assistant / Wyoming voice-satellite integration -- `borrow`
Mana could register as a local Assist conversation agent or Wyoming
satellite so smart-home commands route through Mana's own
wake-word/tool-calling loop instead of a second assistant, and Home
Assistant's local REST/WebSocket API lets Mana query device state for
situational replies. Fully local, reuses infrastructure Mana already has
rather than duplicating it -- and a genuinely different category
(smart-home) from the messaging bridges Mana already ships.

### Native Windows toast/tray interaction mode -- Windows Toast Notification API -- `borrow-narrow`
Proactive, low-friction check-ins (a surfaced memory, a cron result, a
Dream Mode insight) via native toast notifications with action buttons,
dismissible without opening the launcher window. No new bridge/server --
Electron already exposes notification APIs.

### Matrix bridge -- Synapse/Dendrite + mautrix-style bridges -- `borrow-narrow`
Self-hosted homeserver with Mana as a bot user, E2EE, federatable to other
chat networks from one integration point instead of one bridge per
network. Same shape as the existing Discord/Telegram bridges.

### Signal bridge -- signal-cli-rest-api (bbernhard/signal-cli-rest-api) -- `stretch`
Local Dockerized REST/WebSocket wrapper around `signal-cli` for
self-hosted Signal messaging, no cloud vendor API involved -- several
existing local-LLM Signal bots already use this pattern. Real local bridge,
just a Docker dependency Mana doesn't otherwise have.

### WhatsApp / Slack -- `skip`
WhatsApp has no compliant local bridge (only reverse-engineered, ToS-risk
libraries). Slack has no meaningful local/self-hosted server option. Both
excluded on Mana's local-first constraint, not on merit.

## Ad-hoc link evaluations (2026-08-25)

User-supplied links evaluated individually, not part of the four-track
sweep above.

### locally-uncensored -- github.com/PurpleDoubleD/locally-uncensored -- `borrow-narrow` (#488)
A local-first desktop app combining chat, image/video gen, and a coding
agent -- similar shape to Mana itself. Most of it overlaps with features
Mana already has in comparable or more advanced form. The one genuinely
new idea: it auto-detects 12 different local AI backends and
auto-installs ComfyUI on first run, versus Mana's manual
npm-install-plus-hand-configured-paths setup.

### OpenBot -- github.com/CopilotKit/OpenBot -- `skip` (#490, scoped out)
Multi-agent enterprise governance platform (per-agent Docker/gVisor
containers, policy gateway, multi-user SSO). Solves a multi-tenant
problem Mana doesn't have -- see `issue-490-openbot-governance-scoping.md`
for the full investigation and verdict. One piece salvaged as its own
idea: mid-task manual control handoff (#491).

### MoneyPrinterTurbo -- github.com/harry0703/MoneyPrinterTurbo -- `borrow` (#492)
Automated short-form video generation (script -> footage -> subtitles ->
narration -> cross-platform publish). Originally scoped down to
generation-only over a trust-boundary concern with social publishing;
revisited 2026-08-25 -- publishing is wanted as a real capability. See
`issue-492-social-automation-video-plugin.md`.

### tailcat -- github.com/tailscale/tailcat -- `borrow` (#489)
Point-to-point WireGuard tunnel needing no account and no control plane,
with NAT hole-punching and DERP relay fallback. A real alternative to the
Cloudflare-account-and-domain requirement in Mana's current mobile
remote-access setup (`docs/mobile_pwa_cloudflare.md`).

### SurfSense -- github.com/MODSetter/SurfSense -- mixed
NotebookLM-style research platform: structured live-data connectors
(Reddit, YouTube, Instagram, TikTok, Amazon, Walmart, Google Maps,
Indeed), an MCP server, hybrid search with cited answers, and scheduled
write-back to Notion/Slack/Linear/Jira. Most of it overlaps with Deep
Research (#47) and Mana's existing MCP server (#42/#169). Four distinct
ideas extracted:
- Audio podcast digest of research reports -- `borrow` (#493)
- Structured platform connectors (Reddit, YouTube, etc.) -- `borrow-narrow` (#494)
- Scheduled/event write-back to Notion/Linear/Jira -- `borrow-narrow` (#495)
- Cloud storage sync as a memory-inbox source -- `stretch` (#496)

### OpenViking -- github.com/volcengine/OpenViking -- `borrow-narrow` (#497)
A context database for AI agents that unifies memory, resources, and
skills under a navigable filesystem paradigm (`ls`/`find`-style hierarchy)
instead of a flat vector-embedding pool. Mana's skills store (#140) is
already file-based, making it the natural first comparison point against
the current index-then-load and hybrid-retrieval (#263) approaches.
10k+ stars in 1.5 months since open-sourcing.

### Colibri -- github.com/JustVugg/colibri -- `stretch` (#498)
A pure-C, zero-dependency inference engine that runs 744B-2.8T parameter
MoE models on consumer hardware by streaming experts from disk, treating
disk/RAM/VRAM as one inference hierarchy. Not a swap within Mana's
existing llama.cpp headroom (that's #335) -- a second runtime to unlock
models an order of magnitude larger than the hardware would otherwise
support.

### Obscura -- github.com/h4ckf0r0day/obscura -- `borrow-narrow` (#508)
A Rust headless browser engine, drop-in for headless Chrome via the same
CDP protocol Puppeteer/Playwright use. Confirmed `plugins/browser-
automation/` (#150) actually uses Playwright+Chromium today. Claimed
~30MB vs 200MB+ memory and ~85ms vs ~500ms page load, plus built-in
stealth/anti-detection and native MCP support. A real efficiency
candidate for a background companion app if the claims hold up on
hands-on testing.

### Solari -- docs.getsolari.com -- `skip`
Paid cloud infrastructure ("real Chrome in the cloud," cloud VMs/
sandboxes, single API key, hardware-isolated microVMs). Directly
contradicts Mana's local-first design -- nothing here runs without a
cloud dependency. The individual techniques it sells (stealth mode,
captcha solving, session persistence) are real, but Obscura already
covers the local stealth/anti-detection angle without the cloud
requirement.
