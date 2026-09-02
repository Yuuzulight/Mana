# Roadmap Status Index

Last built: 2026-08-19. Partially refreshed 2026-09-02 against `main`'s
actual GitHub issue state (not just doc text) for the batch of ideas filed
in `oss-inspiration-survey-2026-08.md` and its "Ad-hoc link evaluations"
addendum -- see "Known staleness" at the bottom for what this refresh did
and didn't cover.

Purpose: answer "has this idea already been done / already scoped out /
never considered" in one lookup, without re-reading 90+ files each time.
Rebuild this (re-run the same kind of full-directory read and diff against
what's below) whenever a batch of roadmap docs lands, rather than
hand-patching it row by row and letting it drift the way `active-issues.md`
did. **A doc's own prose is not sufficient evidence of its status** --
cross-check the actual GitHub issue state, since a doc can keep reading as
an open proposal long after the issue that tracks it was closed as
shipped (see the "Implemented per GitHub, doc not yet updated" section
below for 18 live examples of exactly this).

Status definitions:
- **Implemented** -- shipped, doc has a completed Progress/Verification section.
- **Partial** -- part shipped, part explicitly deferred/out of scope.
- **Scoped out** -- investigated, decision made not to build (for now or at all).
- **Design only** -- spec/scoping written, no build decision made yet, usually gated on something (hardware, a prerequisite feature, a plugin that doesn't exist yet).
- **Open** -- proposed, not started.
- **Unclear** -- doc predates the Progress/Verification convention and can't be classified from its own text; check the actual GitHub issue before assuming either way.

## Implemented (66)

| Doc | Issue | Topic |
| --- | --- | --- |
| issue-8-backend-modules.md | #8 | Split backend into focused modules |
| issue-9-doctor-checks.md | #9 | Doctor checks for local setup |
| issue-10-component-health.md | #10 | `/health` reports component-level readiness |
| issue-11-api-validation.md | #11 | Request validation, stable 400s |
| issue-12-local-model-management.md | #12 | Local model listing/switching status |
| issue-13-capability-modules.md | #13 | Capability module boundary pattern |
| issue-44-chat-sessions.md | #44 | Named chat sessions, rename/delete |
| issue-45-theme-picker.md | #45 | Theme picker via CSS custom properties |
| issue-46-model-recommendations.md | #46 | Hardware-aware model recommendations |
| issue-47-deep-research.md | #47 | Multi-step Deep Research web mode |
| issue-49-compare-mode.md | #49 | Side-by-side model output compare mode |
| issue-50-presets.md | #50 | Saved prompt/behavior presets |
| issue-51-tool-calling.md | #51 | Scoped shell/file tool-calling for local model |
| issue-68-vram-hotswap-tuning.md | #68 | VRAM hotswap tuning + TTS purge |
| issue-69-idle-dream-mode.md | #69 | Idle-triggered Dream Mode consolidation |
| issue-70-best-of-n.md | #70 | Best-of-N self-voting inference (coding) |
| issue-75-memory-connections.md | #75 | Cross-session memory connections |
| issue-76-inbox-ingestion.md | #76 | Watched inbox folder for memory ingestion |
| issue-77-staleness-notes.md | #77 | Gap/staleness notes on research answers |
| issue-78-entity-tagging.md | #78 | Cross-session entity tagging |
| issue-135-silero-vad.md | #135 | Silero VAD replaces RMS-threshold endpointing |
| issue-138-windows-launcher-ui-overhaul.md | #138 | windows-launcher UI overhaul |
| issue-140-skills-layer.md | #140 | Procedural "how I did X" skills layer |
| issue-141-bounded-memory-tier.md | #141 | Bounded memory tier |
| issue-143-soul-file.md | #143 | Durable SOUL persona file |
| issue-144-cron-scheduler.md | #144 | Built-in cron scheduler plugin |
| issue-145-subagent-delegation.md | #145 | Parallel subagent delegation for Deep Research |
| issue-147-whisper-hallucination-crash-logging.md | #147 | Whisper hallucination filter + crash logging |
| issue-148-renderable-artifacts.md | #148 | Renderable artifacts (HTML/code preview) |
| issue-149-image-generation.md | #149 | Image generation tool plugin |
| issue-150-browser-automation.md | #150 | Interactive browser automation plugin |
| issue-151-telegram-bridge.md | #151 | Telegram remote messaging bridge |
| issue-152-approval-gate.md | #152 | Approval gate for agent-authored content |
| issue-153-session-export.md | #153 | Session trajectory export (ShareGPT JSONL) |
| issue-154-video-watch.md | #154 | Video-watching capability plugin |
| issue-159-rut-detection.md | #159 | Conversational rut detection |
| issue-160-phrasing-variation.md | #160 | Anti-formulaic phrasing rewrite pass |
| issue-161-vrm-avatar.md | #161 | VRM (3D) avatar support |
| issue-169-outbound-mcp-client.md | #169 | Outbound MCP client support |
| issue-183-multiround-tool-calling.md | #183 | Multi-round tool-calling loop |
| issue-185-discord-bot.md | #185 | Discord bot remote messaging bridge |
| issue-187-discord-voice-channels.md | #187 | Discord voice channel support |
| issue-188-unified-tool-audit-layer.md | #188 | Unified tool-execution audit/approval layer |
| issue-189-passive-web-context.md | #189 | Passive "what are you looking at" web context |
| issue-190-backend-url-centralization.md | #190 | Centralize hardcoded backend URL |
| issue-196-gguf-metadata.md | #196 | Real GGUF metadata via @huggingface/gguf |
| issue-197-deep-research-reflect.md | #197 | Reflect-on-gaps step for Deep Research |
| issue-198-memory-hot-path.md | #198 | Explicit hot-path memory tool + policies |
| issue-211-retriever-compress-snippets.md | #211 | Compress retriever-index search snippets |
| issue-215-fish-tts-warmup.md | #215 | Surface Fish Speech torch.compile warmup |
| issue-217-dedupe-vector-store-snippets.md | #217 | Dedupe/compress vector-store-direct snippets |
| issue-219-voice-barge-in.md | #219 | Voice barge-in (interrupt mid-speech) |
| issue-228-graceful-quit.md | #228 | Graceful quit with closing progress screen |
| issue-230-icon-and-menu-bar.md | #230 | Fix broken taskbar icon, remove menu bar |
| issue-232-packaged-app-icon.md | #232 | Packaged installer had no app icon |
| issue-238-crystal-redesign-ag.md | #238 | Redesign Mana Crystal mark (concept AG) |
| issue-240-organic-crystal-render.md | #240 | Organic low-poly render of Crystal mark |
| issue-263-hybrid-retrieval-scoping.md | #263 | Hybrid keyword+vector retrieval + resummarization |
| issue-269-deep-research-subtask-profiles.md | #269 | Route Deep Research subtasks to model profiles |
| issue-282-memory-position-depth.md | #282 | Positionable memory injection (depth/position) |
| issue-284-guardian-precheck.md | #284 | Guardian pre-check on approval gate |
| issue-285-hebbian-memory-emotional-reflexes.md | #285 | Hebbian memory graph + emotional reflexes |
| issue-388-windows-subprocess-audit.md | #388 | Windows subprocess spawn hygiene audit (fixed console-flash gap) |
| issue-4-speech-recognition-accuracy.md | #4 | Speech recognition accuracy (wake word, Whisper) -- scoped subset |
| zed-agent-full-capability.md | -- | Zed External Agent full capability (ACP) |
| zed-integration.md | -- | Zed/VS Code editor integration roadmap |

## Implemented per GitHub, doc not yet updated (18)

Confirmed via direct GitHub query (`state_reason: completed`), not by
reading the docs -- these docs still read as open Goal/Scope/Acceptance-
Criteria proposals with no Implementation Notes section. Treat as
implemented for planning purposes; someone still needs to write each
doc's actual verification section against the merged code, matching this
directory's usual rigor.

| Doc | Issue | Topic |
| --- | --- | --- |
| issue-417-vision-tool-call.md | #417 | Model-invoked vision tool call, not just a hotkey |
| issue-418-browser-automation-live-view.md | #418 | Live view while browser automation acts |
| issue-419-verification-loop.md | #419 | Wire test runner into the autonomous coding loop |
| issue-420-lint-precheck-proposals.md | #420 | Reject syntactically broken edits before the approval gate |
| issue-421-token-cost-meter.md | #421 | Per-session token/cost meter for remote AI |
| issue-422-scratch-copy-test-sandbox.md | #422 | Run test verification against a scratch copy of the workspace |
| issue-423-windows-toast-notifications.md | #423 | Native Windows toast notifications for proactive check-ins |
| issue-427-hunk-level-proposal-review.md | #427 | Hunk-level accept/reject in editor-handoff diff proposals |
| issue-428-restore-points.md | #428 | Restorable snapshots for applied agent edits, independent of git |
| issue-429-whisper-large-v3-turbo.md | #429 | Add Whisper large-v3-turbo as a selectable model profile |
| issue-431-bitemporal-fact-invalidation.md | #431 | Bi-temporal fact invalidation in the memory graph |
| issue-432-ontology-typed-extraction.md | #432 | Ontology-typed entity extraction + derived-facts inference pass |
| issue-433-mem0-style-crud-engine.md | #433 | Evaluate a mem0-style ADD/UPDATE/DELETE/NOOP memory engine |
| issue-437-whatsapp-slack-bridges.md | #437 | Evaluate WhatsApp/Slack bridges (closed completed -- verdict presumably held, not verified) |
| issue-48-mobile-2fa.md | #48 | Optional TOTP 2FA for mobile pairing -- shipped via PR #453 |
| issue-14-mobile-device-security.md | #14 | Mobile device list, token rotation, revocation -- shipped via PR #73; resolves this INDEX's own previously-flagged "Unclear" ambiguity |
| issue-271-comfyui-split-loader-workflow.md | #271 | ComfyUI split-loader (Flux-shape) workflow -- shipped; `plugins/image-generation/workflows/comfyui-txt2img-split.json` exists and is wired in, doc still says "Scoped, not yet implemented" |
| issue-225-comfyui-backend.md | #225 | ComfyUI backend for image generation -- was Partial pending #271; #271 above is now shipped too, so this is fully implemented, not partial |

Also note: #426 and #435 (in Open below) have real shipped commits
(#483, #484) despite their GitHub issues remaining open -- likely
phase-1-of-N work (#486 explicitly extends #426). Not moved into this
section since the issues themselves aren't closed.

## Partial (7)

| Doc | Issue | Topic | What's left |
| --- | --- | --- | --- |
| issue-42-mcp-support.md | #42 | MCP: Mana as server | Phase 2, Mana as an MCP *client*, unstarted (superseded by #169's outbound client, check overlap before starting) |
| issue-142-programmatic-tool-calling.md | #142 | Programmatic tool calling primitive | Standalone primitive built, not wired into a caller yet |
| issue-195-tei-embedder-eval.md | #195 | Evaluate TEI as local embedder backend | Evaluated, not swapping (real blocker found); one improvement shipped |
| issue-208-compress-tool-output.md | #208 | Compress tool-output excerpts vs flat truncation | Implemented for Deep Research only; other callers out of scope |
| issue-253-airi-future-ideas.md | #253 | AIRI-inspired ideas | 2 of 3 shipped; beat-sync head-sway scoped-not-implemented (no audio-capture surface yet) |
| issue-361-test-rigor-audit.md | #361 | Audit: does green CI actually mean correct (PRs run 2 of 94 tests) | The audit itself is done and closed-completed (not "not started" as previously filed) -- its recommendations (fix the CI gating) are what's still unactioned |
| issue-363-installer-licensing-audit.md | #363 | Audit: installer bundles AGPL SearXNG under Apache-2.0 | The audit itself is done and closed-completed via PR #412 (not "not started" as previously filed) -- its recommendations (ship AGPL notice or drop SearXNG) are what's still unactioned |

## Scoped out (5)

| Doc | Issue | Topic | Verdict |
| --- | --- | --- | --- |
| issue-199-deep-research-subagent-review.md | #199 | Deep Research subagent/handoff design review | Investigation complete, no code changes |
| issue-200-context-compression-review.md | #200 | Context compression techniques review | Investigation complete; one gap found, filed as #208 |
| issue-220-cache-ram-and-sqlite-vec-eval.md | #220 | Benchmark llama-server cache-ram and sqlite-vec | Investigation complete; sqlite-vec not justified at current scale |
| issue-260-honcho-vs-manas-memory.md | #260 | Honcho dialectic memory vs Mana's memory design | Investigated, not adopted -- has a named condition for revisiting |
| issue-490-openbot-governance-scoping.md | #490 | OpenBot-style multi-agent governance | Not adopted -- single-user gate/audit already covers it; named condition for revisiting. GitHub issue closed as not_planned 2026-09-02, resolving the prior doc/issue mismatch |

## Design only -- scoped, gated on something (6)

| Doc | Issue | Topic | Gated on |
| --- | --- | --- | --- |
| issue-146-mcp-client-investigation.md | #146 | Can Mana consume external MCP servers | An actual prerequisite feature landing first |
| issue-258-mobile-app-scoping.md | #258 | Native mobile app (Godot) | Not started; open questions already decided |
| issue-268-credential-broker-scoping.md | #268 | Local OAuth credential broker | No OAuth-gated plugin exists yet to build it for |
| issue-359-mac-linux-scoping.md | #359 | Mac/Linux launcher and packaging | Scoping only, no code changes yet |
| oss-inspiration-survey-2026-07.md | -- | OSS survey: companions, assistants, coding agents, Live2D | Research only, nothing implemented from it yet |
| oss-inspiration-survey-2026-08.md | -- | OSS survey: companions, coding-agent tooling, voice stack, memory, integrations | Research only, nothing implemented from it yet |

## Open (18)

| Doc | Issue | Topic |
| --- | --- | --- |
| issue-424-plugin-widget-ui.md | #424 | Sandboxed plugin widget UI (iframe-sandboxed, manifest-declared) |
| issue-425-spine2d-avatar-format.md | #425 | Evaluate Spine2D as a third avatar format |
| issue-426-user-extensible-hooks.md | #426 | User-configurable PreToolUse/PostToolUse-style hooks -- phase 1 shipped via #483, issue kept open for #486's extension |
| issue-430-speaker-diarization.md | #430 | Evaluate local speaker diarization for single-mic multi-person audio |
| issue-434-home-assistant-integration.md | #434 | Home Assistant / Wyoming voice-satellite integration |
| issue-435-matrix-bridge.md | #435 | Matrix bridge alongside Discord/Telegram -- shipped via #484, issue kept open (unclear why; verify) |
| issue-436-signal-bridge.md | #436 | Evaluate a Signal bridge (Docker dependency tradeoff) |
| issue-488-auto-detect-local-backend.md | #488 | Auto-detect and offer to install local AI backends on first run |
| issue-489-tailcat-tunnel-alternative.md | #489 | Account-free WireGuard tunnel as an alternative to Cloudflare Tunnel |
| issue-491-midtask-control-handoff.md | #491 | Mid-task manual control handoff for autonomous runs |
| issue-492-social-automation-video-plugin.md | #492 | Short-video generation + social auto-publish plugin |
| issue-493-research-podcast-digest.md | #493 | Audio podcast digest of Deep Research reports |
| issue-494-structured-platform-connectors.md | #494 | Structured data connectors (Reddit, YouTube, etc.) |
| issue-495-writeback-notion-linear-jira.md | #495 | Scheduled/event write-back to Notion/Linear/Jira |
| issue-496-cloud-storage-inbox-sync.md | #496 | Cloud storage sync as a memory-inbox source |
| issue-497-openviking-context-store-eval.md | #497 | Evaluate a navigable filesystem-paradigm context store |
| issue-498-colibri-inference-eval.md | #498 | Evaluate Colibri for larger MoE models on modest hardware -- duplicate issues #502/#503 exist with the same title, worth closing |
| issue-508-obscura-browser-engine-eval.md | #508 | Evaluate Obscura as a lighter browser-automation engine |

## Unclear -- check the GitHub issue directly (0)

Previously had one entry, `issue-14-mobile-device-security.md` -- resolved
2026-09-02: confirmed shipped via PR #73, moved to "Implemented per
GitHub, doc not yet updated" above.

## docs/superpowers plans/specs

Implementation plans/specs for already-decided work, cross-referenced against the roadmap docs above.

- Component Health, API Request Validation, Capability Module Boundaries, Local Model Management, Zed Agent Full Capability, Editor Approval -- all **shipped**, match completed roadmap docs above.
- Market Analysis Helper, Mobile PWA Companion, Mana Soft Restart -- **likely shipped**, no dedicated roadmap doc to confirm directly but other docs reference them as already existing.
- Installer With Downloadable Local Models -- **design only**, spec exists with no matching plan and no roadmap doc; hasn't moved past design.

## Known staleness elsewhere in this directory

- `README.md`'s Open table lists **#4** as Open; `issue-4-speech-recognition-accuracy.md` says Implemented. Corrected in README as part of building this index -- re-verify against GitHub if it drifts again.
- `active-issues.md` (last synced 2026-06-29) is comprehensively out of date -- everything it lists as In Progress/In Review is now closed per the individual docs and per README's own disclaimer. Don't treat it as current; this INDEX supersedes it. Consider deleting it next time someone's in this directory for an unrelated reason.
- No `issue-1-*.md`, `issue-2-*.md`, `issue-3-*.md`, or `issue-6-*.md` exist despite `active-issues.md` referencing them -- can't cross-check those from this directory alone.

## 2026-09-02 partial refresh -- what this covered and what it didn't

This branch (`claude/mana-future-thoughts-5vq3dy`) had drifted ~815 commits
behind `main` before this refresh. Two things were done: (1) synced the 12
roadmap docs this branch had that `main` didn't yet (#488-#498, #508); (2)
corrected the status of the 33-issue batch filed from the 2026-08 OSS
survey against `main`'s actual GitHub issue state -- 14 of those had
already shipped (`state_reason: completed`) while their docs still read
as open proposals, moved to "Implemented per GitHub, doc not yet updated"
above.

**What this did NOT cover**: main gained many other closed issues during
those 815 commits (#439, #450 -- both fixed in this pass -- and surely
others across the repo's 251 total issues) with no corresponding
`docs/roadmap/*.md` file at all. That's not necessarily a gap worth
closing -- plenty of closed issues (small fixes, housekeeping) never got
a roadmap doc and don't need one; a doc only matters for ideas substantial
enough to have been scoped in writing in the first place.

## 2026-09-02 full re-audit -- every remaining doc checked against GitHub

Follow-up to the partial refresh above: checked all 102 remaining
`issue-N-*.md` docs (everything except the 14 already fixed) against
real GitHub issue state, not just doc text, plus spot-checked 6 of the
existing "Implemented" entries for confidence (all confirmed correct).

**Found and fixed 6 more of the same bug** (doc reads as open/partial/
design-only, issue is actually closed-completed): #48, #14, #271, #225,
#361, #363 -- all moved above (the first four to "Implemented per GitHub,
doc not yet updated"; #361/#363 to "Partial", since the audits themselves
shipped but their recommendations remain unactioned, which "Implemented"
would overstate and "Open" understated).

**One reverse-direction inconsistency, found and fixed**:
`issue-490-openbot-governance-scoping.md` stated a settled "not adopted"
verdict, but GitHub issue #490 was still open. Closed as not_planned
2026-09-02 and moved from Open to Scoped-out above.

**Everything else checked out**: all remaining Open-section docs (424,
425, 426, 430, 434, 435, 436, 488, 489, 491-498, 508) confirmed genuinely
still open on GitHub; the 4 Scoped-out docs and the (now 4) Design-only
docs besides oss-survey confirmed correctly filed -- their closed issues'
actual deliverable was the investigation/scoping itself, matching what
the doc already says.

This is now a genuinely complete audit of every doc in this directory
against real GitHub state, not just the batch this branch had filed --
the "proper full re-audit" flagged as outstanding above is done.
