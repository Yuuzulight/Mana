# Mana Project Roadmap

Last synced: 2026-07-20

This roadmap reflects the current GitHub Project board, merged PRs, open issues, and repository docs on `main`. The board has moved a lot since the last sync (2026-06-29) — everything that was tracked as "In Progress"/"In Review"/most of the "Backlog" at that point (issues #1–#25 and dozens more since) is now closed and merged; see `git log` / `gh issue list --state closed` for the full history rather than an itemized table here, which is what let this doc drift stale in the first place.

## Open

| Issue | Area | Status | Notes |
| --- | --- | --- | --- |
| [#4](https://github.com/Yuuzulight/Mana/issues/4) | Speech recognition accuracy | Open | Whisper model profiles, wake-word fuzzy matching, noise rejection tuning, mic gain/normalization, a local test harness with sample WAVs. |
| [#48](https://github.com/Yuuzulight/Mana/issues/48) | Mobile 2FA | Open | Opt-in TOTP second factor for mobile device pairing, on top of the existing passcode. Should land alongside/after issue #14's device list/rotation/revocation work (closed) so mobile security stays one coherent story. |
| [#137](https://github.com/Yuuzulight/Mana/issues/137) | Docs / media | Open | Demo reel and real screenshots to replace the generic fallback-avatar SVGs in the root README's Preview section. |
| [#331](https://github.com/Yuuzulight/Mana/issues/331) | Streaming voice pipeline | Open | Stream text and voice together instead of waiting for the full reply. `tools/fish-speech`'s server already supports real chunked streaming (`ServeTTSRequest.streaming: true`) and the sentence-chunking half of the pipeline is merged (#410, #411) -- what's left is wiring the client (`node-bot/tts-runtime.js`) to consume it. |

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
- Issue #65 (Fish Audio S2 Pro TTS) closed as **no-go**: the RTX 5080 arrived, but S2 Pro's official requirement is 24GB VRAM (not the ~10GB weights-only estimate the issue was opened with), and the unofficial GGUF/`s2.cpp` route that does fit doesn't have solid streaming yet. S1-mini stays the TTS model; the actual low-latency goal moves to #331 above.
- Local model stack upgraded for the RTX 5080 (16GB): chat/quality moved from Qwen3-14B to **Qwen3.5-9B** (newer training generation scores higher on every directly comparable benchmark -- MMLU-Redux, GPQA-Diamond, C-Eval, IFEval -- at 5.68GB vs 9.00GB, not a size/quality trade-off), vision moved from Qwen2.5-VL-7B to **Qwen3-VL-4B** (frees ~2.9GB, occasional-use hotkey so the smaller tier is an acceptable trade), and fast/background moved from Qwen2.5-1.5B to **Qwen3-1.7B**. The coding profile was upgraded further: a **self-quantized Q4_K_M build of Qwen2.5-Coder-7B**, calibrated with a custom imatrix built from Mana's own codebase plus the user's other real projects (Python/TS-React/SQL/C++), replacing the generic community quant at the same size/VRAM cost. Side-by-side comparison against the generic quant: 3 wins/edges, 1 loss, 2 ties across 6 tasks, with one genuine correctness win (a React animation component) directly traceable to the custom calibration. See [coding_model_quantization.md](../coding_model_quantization.md) for the full pipeline, corpus composition, and comparison detail. All four swapped models were verified against their real production code path (`llama-server` + `/v1/chat/completions`, not just the raw CLI, which gave a false-positive "broken" result for Qwen3's default thinking-mode behavior before `--reasoning off` was confirmed working through the actual HTTP path).

## Untracked Roadmap Items

- Native Windows launcher: `docs/native_launcher_plan.md` documents a scaffold and next steps; still no matching GitHub issue. Create one before continuing feature work there.

## Recommended Next Order

1. Issue #4 (speech recognition accuracy) — no hardware blocker, most directly improves daily use.
2. Issue #48 (mobile 2FA) — coordinate scope with the mobile security work already merged for issue #14 rather than diverging.
3. Issue #331 (streaming voice pipeline) — RTX 5080 is in; #65 (S2 Pro) closed no-go, so this is the actual path to low-latency voice, using the S1-mini streaming endpoint Mana already runs.
