# Mana Project Roadmap

Last synced: 2026-10-02

This roadmap reflects the current GitHub issues, merged PRs and repository docs on `main`. A lot has moved since the August 2026 sync -- several hundred PRs merged (up to #1276), covering proactive behaviours, native launcher parity, the Obsidian vault sync, character profiles, and Mana working on her own codebase.

## Open

| Issue | Area | Status | Notes |
| --- | --- | --- | --- |
| [#1221](https://github.com/Yuuzulight/Mana/issues/1221) | Self-work benchmark | Open | Re-run the coding benchmark on both the 9B (Qwen3.5-9B) and the 30B (Qwen3-Coder-30B-A3B) now that the gate fixes (#1260-#1264) are merged, to pick the model for Mana's self-work. The 30B fits the 16 GB card: it ran at 15.3 GB peak VRAM with the MoE experts offloaded, started via `--server-args "--fit on --fit-target 768 -fa on -ctk q8_0 -ctv q8_0"`. A run started without those server args aborts -- that's a launch mistake, not the model being too big. |
| [#692](https://github.com/Yuuzulight/Mana/issues/692) | Setup | Open | Installer, first-run setup and auto-update (scoped 1 Oct: Velopack, Kokoro as the default voice, unsigned at first). |
| [#705](https://github.com/Yuuzulight/Mana/issues/705) | Streaming | Open | Co-streaming: Spout output for OBS, a moderated Twitch/YouTube chat bridge, and stream mode (one switch that keeps private content off stream). |
| N/A | Speech | Open (no issue yet) | Fine-tune a smaller Whisper model on my voice and accent. Needs a reading session and guided conversations recorded as ground truth first. |
| [#331](https://github.com/Yuuzulight/Mana/issues/331) | Streaming voice pipeline | Open | Stream text and voice together instead of waiting for the full reply. `tools/fish-speech`'s server already supports real chunked streaming (`ServeTTSRequest.streaming: true`) and the sentence-chunking half of the pipeline is merged (#410, #411) -- what's left is wiring the client (`node-bot/tts-runtime.js`) to consume it. |
| [#470](https://github.com/Yuuzulight/Mana/issues/470) | Cloudflare Access lockdown | Open | When the Cloudflare Tunnel remote-access setup (`docs/mobile_pwa_cloudflare.md`) actually gets configured, restrict the Access policy to the owner's identity only, not open signup. Not urgent -- the tunnel itself isn't configured yet (no `CLOUDFLARE_*` env vars set), so this is a checklist item for whenever that happens, not a current gap. |
| [#424](https://github.com/Yuuzulight/Mana/issues/424) | Plugins | Open | Sandboxed plugin widget UI, manifest-declared. See [issue-424-plugin-widget-ui.md](issue-424-plugin-widget-ui.md). |
| [#425](https://github.com/Yuuzulight/Mana/issues/425) | Avatar | Open | Evaluate Spine2D as a third avatar format -- low priority. See [issue-425-spine2d-avatar-format.md](issue-425-spine2d-avatar-format.md). |
| [#426](https://github.com/Yuuzulight/Mana/issues/426) | Coding agent | Open (phase 1 shipped via #483, issue kept open for #486's extension) | User-configurable PreToolUse/PostToolUse-style hooks. See [issue-426-user-extensible-hooks.md](issue-426-user-extensible-hooks.md). |
| [#430](https://github.com/Yuuzulight/Mana/issues/430) | Speech | Open | Evaluate local speaker diarization for single-mic multi-person audio. See [issue-430-speaker-diarization.md](issue-430-speaker-diarization.md). |
| [#434](https://github.com/Yuuzulight/Mana/issues/434) | Integrations | Open | Home Assistant / Wyoming voice-satellite integration. See [issue-434-home-assistant-integration.md](issue-434-home-assistant-integration.md). |
| [#435](https://github.com/Yuuzulight/Mana/issues/435) | Integrations | Open (shipped via #484, issue kept open -- verify whether further work is expected) | Matrix bridge alongside Discord/Telegram. See [issue-435-matrix-bridge.md](issue-435-matrix-bridge.md). |
| [#436](https://github.com/Yuuzulight/Mana/issues/436) | Integrations | Open | Evaluate a Signal bridge -- Docker dependency tradeoff. See [issue-436-signal-bridge.md](issue-436-signal-bridge.md). |
| [#488](https://github.com/Yuuzulight/Mana/issues/488) | Setup | Open | Auto-detect and offer to install local AI backends on first run. See [issue-488-auto-detect-local-backend.md](issue-488-auto-detect-local-backend.md). |
| [#489](https://github.com/Yuuzulight/Mana/issues/489) | Mobile | Open | Account-free WireGuard tunnel as an alternative to Cloudflare Tunnel. See [issue-489-tailcat-tunnel-alternative.md](issue-489-tailcat-tunnel-alternative.md). |
| [#491](https://github.com/Yuuzulight/Mana/issues/491) | Coding agent | Open | Mid-task manual control handoff for autonomous runs. See [issue-491-midtask-control-handoff.md](issue-491-midtask-control-handoff.md). |
| [#492](https://github.com/Yuuzulight/Mana/issues/492) | Plugins | Open | Short-video generation + social auto-publish plugin. See [issue-492-social-automation-video-plugin.md](issue-492-social-automation-video-plugin.md). |
| [#493](https://github.com/Yuuzulight/Mana/issues/493) | Deep Research | Open | Audio podcast digest of Deep Research reports. See [issue-493-research-podcast-digest.md](issue-493-research-podcast-digest.md). |
| [#494](https://github.com/Yuuzulight/Mana/issues/494) | Deep Research | Open | Structured data connectors (Reddit, YouTube, etc.). See [issue-494-structured-platform-connectors.md](issue-494-structured-platform-connectors.md). |
| [#495](https://github.com/Yuuzulight/Mana/issues/495) | Integrations | Open | Scheduled/event write-back to Notion/Linear/Jira. See [issue-495-writeback-notion-linear-jira.md](issue-495-writeback-notion-linear-jira.md). |
| [#496](https://github.com/Yuuzulight/Mana/issues/496) | Memory | Open | Cloud storage sync as a memory-inbox source. See [issue-496-cloud-storage-inbox-sync.md](issue-496-cloud-storage-inbox-sync.md). |
| [#497](https://github.com/Yuuzulight/Mana/issues/497) | Memory | Open | Evaluate a navigable filesystem-paradigm context store (OpenViking-inspired). See [issue-497-openviking-context-store-eval.md](issue-497-openviking-context-store-eval.md). |
| [#498](https://github.com/Yuuzulight/Mana/issues/498) | Local AI | Open (note: duplicate issues #502/#503 were auto-created with the same title -- worth closing as duplicates) | Evaluate Colibri for larger MoE models on modest hardware. See [issue-498-colibri-inference-eval.md](issue-498-colibri-inference-eval.md). |
| [#508](https://github.com/Yuuzulight/Mana/issues/508) | Plugins | Open | Evaluate Obscura as a lighter browser-automation engine. See [issue-508-obscura-browser-engine-eval.md](issue-508-obscura-browser-engine-eval.md). |

## Recently completed (since the last sync)

Non-exhaustive highlights — see individual issue/PR history for full detail:

- **Mana working on her own code** (umbrella #976 still open): she takes issues labelled `mana-task`, works in her own worktree, runs the tests and opens a PR. The self-work benchmark (#1210) measures it; gate fixes #1260-#1264 added a round floor, a read-budget nudge, test-first as a warning, and best-of-N keeping an attempt whose tests pass. A cloud fallback for when every local attempt fails merged in #1270 (#1269).
- **Obsidian vault sync** (#935 still open): facts and standing intents sync both ways with vault notes, plus read-only views and a session-end journal (#936, #939, #943). `MANA_VAULT_DIR` points at the vault (`D:\ManaAI\Mana-Obsidian\Mana` in `.env.sample`).
- **Character profiles**: switchable personas with their own voice, mood and personality, switched from the tray with an in-place Live2D swap, remembered across restarts, and per-character relationship notes (#973, #983, #1027, #1054, #1075).
- **Proactive core, first parts** (#697-#700 still open): threshold, daily budget and gaming hold for unprompted remarks (#784), standing intents (#782), the heartbeat checklist (#783), and mood shaping her tone (#785, part 1). Goal mode with a completion review for the chat tool loop (#787).
- **Native launcher parity work** (#694 still open): barge-in modes, VAD hysteresis, voiceprint gate, chunked TTS, gaming pacing, remappable hotkeys and tray Doctor alerts.
- **Integrations and desktop actions**: game-aware help from wikis, daily briefings, mail/calendar tools over IMAP/CalDAV (#906 still open), media keys, volume, app launching, and moving/renaming files with undo.
- **Voice**: Whisper on the GPU with large-v3-turbo q5_0, Qwen3-TTS as a provider, and a voiceprint threshold slider with live scores.
- **Security and safety**: default-deny auth, Host/Origin guards against CSRF/DNS rebinding, voice uploads deleted per request, and crisis handling with Singapore hotlines (SOS 1767, IMH).
- **Recent fixes**: inference-gateway `vllm` KeyError (#1274), native barge-in env vars honoured (#1275), native tool calls with bad arguments no longer run with `{}` (#1276).

Earlier highlights (model stack decisions, the S2 Pro no-go, the August batch) are in this file's git history.

## Untracked Roadmap Items

(none currently — Native Windows launcher is now tracked as issue #479.)

## Recommended Next Order

1. **Issue #1221 (benchmark re-run)**: with the gate fixes merged, re-run the benchmark on the 9B and the 30B to settle the self-work model. Start the 30B with its `--fit on --fit-target 768 -fa on -ctk q8_0 -ctv q8_0` server args.
2. **Custom STT model**: record a reading session and guided conversations as ground truth, then fine-tune a smaller Whisper model on my voice and accent.
3. **Issue #331 (streaming voice pipeline)** — RTX 5080 is in; #65 (S2 Pro) closed no-go, so this is the actual path to low-latency voice, using the S1-mini streaming endpoint Mana already runs.
