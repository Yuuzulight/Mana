# Mana Project Roadmap

Last synced: 2026-07-20

This roadmap reflects the current GitHub Project board, merged PRs, open issues, and repository docs on `main`. The board has moved a lot since the last sync (2026-06-29) — everything that was tracked as "In Progress"/"In Review"/most of the "Backlog" at that point (issues #1–#25 and dozens more since) is now closed and merged; see `git log` / `gh issue list --state closed` for the full history rather than an itemized table here, which is what let this doc drift stale in the first place.

See [INDEX.md](INDEX.md) for a full status table across every doc in this
directory (implemented / partial / scoped out / design-only / open), built
from actually reading each doc rather than hand-tracked here.

## Open

| Issue | Area | Status | Notes |
| --- | --- | --- | --- |
| [#48](https://github.com/Yuuzulight/Mana/issues/48) | Mobile 2FA | Open | Opt-in TOTP second factor for mobile device pairing, on top of the existing passcode. Should land alongside/after issue #14's device list/rotation/revocation work (closed) so mobile security stays one coherent story. |
| [#65](https://github.com/Yuuzulight/Mana/issues/65) | Fish Audio S2 Pro TTS | Open | Follow-up to the (closed) Fish Speech evaluation. S2 Pro's BF16 weights (~10GB) didn't fit the previous dev GPU (RTX 3070 Ti, 8GB); an RTX 5080 upgrade has been ordered (ETA within the week), unblocking this once it arrives. |
| [#137](https://github.com/Yuuzulight/Mana/issues/137) | Docs / media | Open | Demo reel and real screenshots to replace the generic fallback-avatar SVGs in the root README's Preview section. |
| [#417](https://github.com/Yuuzulight/Mana/issues/417) | Vision | Open | Let the model call a vision tool mid-reply instead of only reacting to the hotkey/ambient loop. See [issue-417-vision-tool-call.md](issue-417-vision-tool-call.md). |
| [#418](https://github.com/Yuuzulight/Mana/issues/418) | Browser automation | Open | Live view/action log while browser automation runs, instead of only a final result. See [issue-418-browser-automation-live-view.md](issue-418-browser-automation-live-view.md). |
| [#419](https://github.com/Yuuzulight/Mana/issues/419) | Coding agent | Open | Wire the test runner into the autonomous coding loop so failures drive bounded retries. See [issue-419-verification-loop.md](issue-419-verification-loop.md). |
| [#420](https://github.com/Yuuzulight/Mana/issues/420) | Coding agent | Open | Reject syntactically broken editor-handoff proposals before the approval gate. See [issue-420-lint-precheck-proposals.md](issue-420-lint-precheck-proposals.md). |
| [#421](https://github.com/Yuuzulight/Mana/issues/421) | Remote AI | Open | Per-session token/cost meter, only relevant when remote AI is enabled. See [issue-421-token-cost-meter.md](issue-421-token-cost-meter.md). |
| [#422](https://github.com/Yuuzulight/Mana/issues/422) | Coding agent | Open | Run test verification against a scratch copy of the workspace, not the live tree. See [issue-422-scratch-copy-test-sandbox.md](issue-422-scratch-copy-test-sandbox.md). |
| [#423](https://github.com/Yuuzulight/Mana/issues/423) | Notifications | Open | Native Windows toast notifications for proactive check-ins. See [issue-423-windows-toast-notifications.md](issue-423-windows-toast-notifications.md). |
| [#424](https://github.com/Yuuzulight/Mana/issues/424) | Plugins | Open | Sandboxed plugin widget UI, manifest-declared. See [issue-424-plugin-widget-ui.md](issue-424-plugin-widget-ui.md). |
| [#425](https://github.com/Yuuzulight/Mana/issues/425) | Avatar | Open | Evaluate Spine2D as a third avatar format -- low priority. See [issue-425-spine2d-avatar-format.md](issue-425-spine2d-avatar-format.md). |
| [#426](https://github.com/Yuuzulight/Mana/issues/426) | Coding agent | Open | User-configurable PreToolUse/PostToolUse-style hooks. See [issue-426-user-extensible-hooks.md](issue-426-user-extensible-hooks.md). |
| [#427](https://github.com/Yuuzulight/Mana/issues/427) | Coding agent | Open | Hunk-level accept/reject in editor-handoff proposals. See [issue-427-hunk-level-proposal-review.md](issue-427-hunk-level-proposal-review.md). |
| [#428](https://github.com/Yuuzulight/Mana/issues/428) | Coding agent | Open | Restorable snapshots for applied edits, independent of git. See [issue-428-restore-points.md](issue-428-restore-points.md). |
| [#429](https://github.com/Yuuzulight/Mana/issues/429) | Speech | Open | Add Whisper large-v3-turbo as a selectable model profile. See [issue-429-whisper-large-v3-turbo.md](issue-429-whisper-large-v3-turbo.md). |
| [#430](https://github.com/Yuuzulight/Mana/issues/430) | Speech | Open | Evaluate local speaker diarization for single-mic multi-person audio. See [issue-430-speaker-diarization.md](issue-430-speaker-diarization.md). |
| [#431](https://github.com/Yuuzulight/Mana/issues/431) | Memory | Open | Bi-temporal fact invalidation in the memory graph. See [issue-431-bitemporal-fact-invalidation.md](issue-431-bitemporal-fact-invalidation.md). |
| [#432](https://github.com/Yuuzulight/Mana/issues/432) | Memory | Open | Ontology-typed entity extraction + derived-facts inference pass. See [issue-432-ontology-typed-extraction.md](issue-432-ontology-typed-extraction.md). |
| [#433](https://github.com/Yuuzulight/Mana/issues/433) | Memory | Open | Evaluate a mem0-style CRUD memory engine -- likely redundant. See [issue-433-mem0-style-crud-engine.md](issue-433-mem0-style-crud-engine.md). |
| [#434](https://github.com/Yuuzulight/Mana/issues/434) | Integrations | Open | Home Assistant / Wyoming voice-satellite integration. See [issue-434-home-assistant-integration.md](issue-434-home-assistant-integration.md). |
| [#435](https://github.com/Yuuzulight/Mana/issues/435) | Integrations | Open | Matrix bridge alongside Discord/Telegram. See [issue-435-matrix-bridge.md](issue-435-matrix-bridge.md). |
| [#436](https://github.com/Yuuzulight/Mana/issues/436) | Integrations | Open | Evaluate a Signal bridge -- Docker dependency tradeoff. See [issue-436-signal-bridge.md](issue-436-signal-bridge.md). |
| [#437](https://github.com/Yuuzulight/Mana/issues/437) | Integrations | Open | Evaluate WhatsApp/Slack bridges -- likely not viable. See [issue-437-whatsapp-slack-bridges.md](issue-437-whatsapp-slack-bridges.md). |

## Recently completed (since the last sync)

Non-exhaustive highlights — see individual issue/PR history for full detail:

- Extracted FFXIV market/crafting and real-world stock market data into standalone, self-contained plugins under `plugins/` (issues #106, #109), plus a generic `contributePromptContext` hook (issue #108) so plugins inject chat-reply context without `server-routes.js` hardcoding each one by name. See [plugins/README.md](../../plugins/README.md).
- OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) so external tools like Obsidian Copilot can talk to Mana directly (issue #95).
- Obsidian plugin (Mana Memory Sync) that pulls Mana's memory into a vault as linked notes (issue #89), plus setup-time Obsidian detection.
- Reorganized `node-bot/server.js`'s admin routes into focused capability modules under `node-bot/capabilities/`.
- Fish Speech (S1-mini) as Mana's default TTS provider, with inline reference-audio voice cloning and automatic gaming-mode device swap.
- Best-of-N self-voting inference, idle-triggered Dream Mode memory consolidation, and cross-session memory connections/entity tagging.
- Deep Research mode (multi-step, multi-source, cited report) with a UI entry point in `windows-launcher`.
- Silero VAD replaces the RMS-threshold live speech/silence detection in `windows-launcher`'s continuous-listening loop, with a graceful fallback if the model is unavailable (issue #135). See [issue-135-silero-vad.md](issue-135-silero-vad.md).
- `windows-launcher` UI overhaul: popup info bubbles, redesigned Doctor panel, startup loading screen, the Mana Crystal logo, a fuller Settings menu (Logs/Plugins), and a themed scrollbar -- brings it up to par with `desktop-client`'s recent reskin (issue #138). See [issue-138-windows-launcher-ui-overhaul.md](issue-138-windows-launcher-ui-overhaul.md).
- Procedural skills layer: a `node-bot/skills/` store for "how I did X last time" knowledge, separate from Dream Mode's factual memory -- cheap always-available index, full content loaded only on demand, idle-gated stale/archive pruning (issue #140). See [issue-140-skills-layer.md](issue-140-skills-layer.md).

## Untracked Roadmap Items

- Native Windows launcher: `docs/native_launcher_plan.md` documents a scaffold and next steps; still no matching GitHub issue. Create one before continuing feature work there.

## Recommended Next Order

1. Issue #4 (speech recognition accuracy) — no hardware blocker, most directly improves daily use.
2. Issue #48 (mobile 2FA) — coordinate scope with the mobile security work already merged for issue #14 rather than diverging.
3. Issue #65 (Fish Audio S2 Pro) — RTX 5080 upgrade ordered, ETA within the week; pick this back up once the new GPU is in.
