# Issue #388: Windows subprocess audit

Audit of Mana's spawn and child-process surface, 2026-08-17, treating it as
one class rather than incident-by-incident.

## Scope

Every `spawn`/`spawnSync`/`execFile` site in `node-bot`, `windows-launcher`
and `desktop-client`, excluding tests and `node_modules`. Four questions:
encoding, console flash, quoting, line endings.

## 1. Encoding — clean, no action

**Every `spawnSync` site that reads child output sets `encoding` explicitly.**
Checked across `ai/local-llama-runtime.js`, `model-management.js`,
`server.js` (5 sites), `tts-runtime.js` and `utils/reply-verifier.js`
(2 sites). All pass `encoding: "utf8"`.

This is the bug class the reference project closed repo-wide, and Mana did
not have it. Worth recording so it is not re-audited later.

## 2. Console flash — was the real gap, now fixed

`windowsHide` was set at only 5 of 13 spawn sites in `node-bot`. Missing on:

| Site | Why it matters |
| --- | --- |
| `tts-runtime.js:245` | runs on **every spoken reply** |
| `server.js:3069` (whisper) | runs on **every spoken utterance** |
| `server.js:3167` (ffmpeg) | every audio conversion |
| `server.js:3731` (retriever) | every retrieval call |
| `ai/local-llama-runtime.js:259` | every CLI-fallback generation |
| `model-management.js:128` (nvidia-smi) | VRAM probe |
| `utils/reply-verifier.js` ×2 | inline while verifying a reply |

The top two are the point: for a desktop assistant, a console window
blinking on screen on every reply and every utterance is a visible defect,
not a cosmetic one. All eight now set `windowsHide: true`.

Already correct before this audit, and left alone: `ai/llama-server-runtime.js`,
`zed-integration.js` (both the command resolver and #349's git helper).

## 3. Quoting and paths with spaces — clean, and already hardened

Mana has scar tissue here, all of it holding:

- `zed-integration.js`'s `quoteWindowsCmdArg()` refuses a literal `"` in an
  argument, because `cmd.exe` has no escape for one inside `/c "..."` — a
  closed command-injection gap, with the reasoning in the comment.
- `buildSpawnInvocation()` special-cases `.cmd`/`.bat` on win32.
- `run_tests.js` uses `shell: false` specifically because "shell:true's
  Windows argument quoting corrupts any path containing a space (e.g.
  mangles `C:\GitHub Projects\...`)".
- `defaultCommandResolver()` branches on `where` vs `which`.

**`shell: true` appears nowhere in the codebase** outside that explanatory
comment. That is the single most important finding in this section: the
whole class of Windows shell-quoting bugs is structurally avoided rather
than handled case by case.

## 4. Line endings — one real risk, now covered

Anywhere Mana writes a file and later compares it byte-for-byte, CRLF
rewriting can cause a false mismatch. There is exactly one such comparison,
and it was added by #387: `approveEditProposal()` reads back what it wrote
and compares against `proposedContent`.

Both the write and the read use explicit `"utf8"` and neither transforms
line endings, so a round-trip is faithful. Worth knowing that this is now a
place where a future change to either side would surface as a confusing
"file on disk does not match the approved content" error rather than as a
line-ending bug.

Git's `core.autocrlf` operates on checkout/commit, not on `fs.writeFileSync`,
so it does not affect this path.

## Electron apps

`windows-launcher/main.js` has 7 spawn sites and 6 `windowsHide`
occurrences — the long-running service spawns (GPT-SoVITS, retriever,
embedder, SearXNG, node backend) are covered. `desktop-client` spawns
nothing directly.

The one uncovered launcher site was not changed here: those spawns start
long-lived services rather than firing per-turn, so a flash at startup is
far less visible than one on every reply, and the launcher's spawn options
carry more per-site nuance (detached, stdio wiring) than a mechanical edit
should touch. Worth a follow-up if it turns out to be visible in practice.

## Summary

| Question | Result |
| --- | --- |
| Encoding | Already clean everywhere |
| Console flash | **8 sites fixed** — was the real gap |
| Quoting / spaces | Already hardened; `shell: true` used nowhere |
| Line endings | One comparison, faithful round-trip |

The audit's premise — that Mana had this bug class and had only been fixing
it incident-by-incident — turned out to be **half right**. The quoting and
encoding halves were already handled structurally. Console flash was not,
and it was missing in exactly the hottest paths.
