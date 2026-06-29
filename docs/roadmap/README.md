# Mana Project Roadmap

Last synced: 2026-06-29

This roadmap reflects the current GitHub Project board, merged PRs, open issues, and repository docs on `main`.

## Completed

| Area | Status | Notes |
| --- | --- | --- |
| Backend module split | Done | Issue #8 closed. PR #15 merged. `server.js` now delegates local AI, llama runtime, FFXIV/Universalis, TTS, VTube, and core route registration to focused modules. |
| Local setup Doctor checks | Done | Issue #9 closed. PR #16 merged. Doctor checks cover local setup, local-only policy, editor integration, and async backend probes. |
| Zed editor CLI integration | Done | Issue #22 closed. PR #23 merged. Mana can detect/open Zed and VS Code, track active workspaces, inspect files explicitly, and create safe edit proposals. |
| Zed External Agent entry point | Done | Issue #24 closed. PR #25 merged. Mana has a local ACP entry point for Zed External Agents with local-first reply behavior and approval-required editor writes. |
| Shared editor approval flow | Done | Merged to `main` on 2026-06-29. Editor proposals can be applied through `POST /editors/workspace/proposals/:id/approve` only after content verification. |
| Mobile PWA companion foundation | Done outside current board | Mobile PWA docs, auth, local summary persistence, Cloudflare access notes, and mobile voice/chat flows exist. Future mobile security work is tracked in issue #14. |
| Local-only AI baseline | Done outside current board | Remote AI is disabled by default. Local model profile selection and llama runtime helpers are now separated into `node-bot/ai/`. |

## In Progress

| Area | Status | Linked Work |
| --- | --- | --- |
| Component-level health status | In progress | Issue #10, PR #17. Expand `/health` into structured component readiness. |
| API request validation | In progress | Issue #11, PR #18. Add consistent validation and stable 400 responses. |
| Local model management/status | In progress | Issue #12, PR #19. Expose model list/status and switching controls. |
| Capability module boundaries | In progress | Issue #13, PR #20. Define a simple internal capability pattern. |
| Mobile device security controls | In progress | Issue #14, PR #21. Add device visibility, token rotation, revocation, and remote exposure warnings. |

## In Review

| Area | Status | Linked Work |
| --- | --- | --- |
| Speech recognition improvements | In review | Issue #4, PR #5. Plan exists; implementation should continue local Whisper accuracy and wake-word reliability work. |

## Backlog

| Area | Status | Notes |
| --- | --- | --- |
| Screen perception and understanding | Backlog | Issue #1. First version should stay opt-in, local-first, screenshot-based, and avoid saving screenshots by default. |
| Gaming performance mode | Backlog | Issue #2. Needs testing with FFXIV running and should prioritize low overhead over response speed. |
| Fish Speech TTS evaluation | Backlog | Issue #3. Fish provider support and docs exist, but the issue remains open for evaluation, health reporting, and smoke-test confirmation. |
| Stock market analysis helper | Backlog / needs triage | Issue #6 remains open, but the repo already includes `node-bot/market-data.js`, stock endpoints, tests, and `docs/market_analysis_helper.md`. Decide whether to close it or narrow it to remaining SEC/news/watchlist enhancements. |

## Untracked Roadmap Items

- Native Windows launcher: `docs/native_launcher_plan.md` documents a scaffold and next steps, but there is no matching GitHub issue on the current board. Create an issue before continuing feature work.
- Installer/model-download improvements: existing worktrees and docs suggest installer work has started, but the current board does not track it directly. Add an issue if this should stay on the active roadmap.

## Recommended Next Order

1. Finish and merge the open PR stack for issues #10 through #14.
2. During issue #13, separate FFXIV/Universalis helpers into a clearer capability folder or section while preserving public endpoint URLs.
3. Resolve PR #5 and decide the first implementation slice for speech recognition accuracy.
4. Triage issue #6 because much of the market-analysis MVP appears implemented already.
5. Choose the next new feature lane: screen perception (#1), gaming performance (#2), or native launcher parity.
