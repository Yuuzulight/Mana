# Mana Project Roadmap

Last synced: 2026-07-20

This roadmap reflects the current GitHub Project board, merged PRs, open issues, and repository docs on `main`. The board has moved a lot since the last sync (2026-06-29) — everything that was tracked as "In Progress"/"In Review"/most of the "Backlog" at that point (issues #1–#25 and dozens more since) is now closed and merged; see `git log` / `gh issue list --state closed` for the full history rather than an itemized table here, which is what let this doc drift stale in the first place.

## Open

| Issue | Area | Status | Notes |
| --- | --- | --- | --- |
| [#4](https://github.com/Yuuzulight/Mana/issues/4) | Speech recognition accuracy | Open | Whisper model profiles, wake-word fuzzy matching, noise rejection tuning, mic gain/normalization, a local test harness with sample WAVs. |
| [#48](https://github.com/Yuuzulight/Mana/issues/48) | Mobile 2FA | Open | Opt-in TOTP second factor for mobile device pairing, on top of the existing passcode. Should land alongside/after issue #14's device list/rotation/revocation work (closed) so mobile security stays one coherent story. |
| [#65](https://github.com/Yuuzulight/Mana/issues/65) | Fish Audio S2 Pro TTS | Blocked | Follow-up to the (closed) Fish Speech evaluation. S2 Pro's BF16 weights (~10GB) don't fit the current dev GPU (RTX 3070 Ti, 8GB); blocked on an RTX 5080 upgrade. Recheck the model card periodically in case a quantized release appears. |

## Recently completed (since the last sync)

Non-exhaustive highlights — see individual issue/PR history for full detail:

- Extracted FFXIV market/crafting and real-world stock market data into standalone, self-contained plugins under `plugins/` (issues #106, #109), plus a generic `contributePromptContext` hook (issue #108) so plugins inject chat-reply context without `server-routes.js` hardcoding each one by name. See [plugins/README.md](../../plugins/README.md).
- OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) so external tools like Obsidian Copilot can talk to Mana directly (issue #95).
- Obsidian plugin (Mana Memory Sync) that pulls Mana's memory into a vault as linked notes (issue #89), plus setup-time Obsidian detection.
- Reorganized `node-bot/server.js`'s admin routes into focused capability modules under `node-bot/capabilities/`.
- Fish Speech (S1-mini) as Mana's default TTS provider, with inline reference-audio voice cloning and automatic gaming-mode device swap.
- Best-of-N self-voting inference, idle-triggered Dream Mode memory consolidation, and cross-session memory connections/entity tagging.
- Deep Research mode (multi-step, multi-source, cited report) with a UI entry point in `windows-launcher`.

## Untracked Roadmap Items

- Native Windows launcher: `docs/native_launcher_plan.md` documents a scaffold and next steps; still no matching GitHub issue. Create one before continuing feature work there.

## Recommended Next Order

1. Issue #4 (speech recognition accuracy) — no hardware blocker, most directly improves daily use.
2. Issue #48 (mobile 2FA) — coordinate scope with the mobile security work already merged for issue #14 rather than diverging.
3. Issue #65 (Fish Audio S2 Pro) stays blocked until the GPU upgrade; revisit the model card for a quantized release in the meantime.
