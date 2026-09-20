# Hermes Desktop Evaluation (2026-09)

## What Hermes Desktop is

Nous Research's native desktop app (MIT license, Mac/Windows/Linux) for
their open-source, self-improving agent framework. Shipped June 2, 2026;
~180k GitHub stars within four months. The most recent substantive
release is **Pantheon (v0.21.0, 2026-08-31)** — Bot Mode, memory-backed
cron, live subagent orchestration, an MCP command center, and
agent-controlled in-app browsing. Three September patch releases
(v0.21.1/2/3) followed with mostly stability fixes (state.db reliability,
credential-vault integration, plugin-catalog SHA-pinning) rather than new
features.

## Method

Web research on Hermes Desktop's shipped feature set (official docs,
release notes, and third-party technical writeups), followed by direct
verification against Mana's actual codebase for every candidate idea —
grep/read against `node-bot/`, `windows-native-launcher/`,
`windows-launcher/`, and `plugins/` — before treating anything as a gap.
This follows directly from the DIY-AI/JARVIS survey
(`docs/roadmap/oss-inspiration-survey-2026-09.md`) and its own
correction pass, which found several proposed "gaps" in that survey were
already shipped in Mana under different names. The same discipline is
applied here: every finding below cites the actual file(s) checked.

## Findings

### Already shipped in Mana — not proposed as new work

These came up as candidate ideas from Hermes' feature set and were
confirmed to already exist in Mana, in some cases in a stricter form:

- **Skill write-approval gate**: Mana's idle skill-proposal pass
  (`node-bot/skill-proposal.js`, issue #262) never auto-applies — only
  "propose" (default) or "off," always through the approval gate. Hermes
  writes skills freely by default with an *optional* gate — Mana is
  already stricter.
- **MCP server + client**: fully shipped both directions
  (`node-bot/mcp-server.js`, `node-bot/mcp-client-registry.js`), plus a
  native-launcher registration dialog (`McpServerDialog.cs`).
- **Quick-entry always-on-top composer**: already shipped
  (`QuickEntryForm.cs`, confirmed `TopMost`).
- **Coding-agent approval gate + diff preview**: already exists
  (`approval-gate.js`).
- **Bot Mode** (named-bot roster, per-profile avatars, group chats,
  bot-to-bot DMs) is a different product philosophy, not a missing
  feature — Mana is one coherent companion persona, not a roster of
  interchangeable bots. Not recommended for import.

### Genuine gaps — verified missing, issues filed

1. **Memory-graph visualization UI** — issue #641. Hermes' `/journey`
   command shows a zoomable, filterable node graph of everything it's
   learned. Mana has richer underlying data (Hebbian graph, typed
   entities, bi-temporal facts) and zero UI to see any of it.
2. **Context-window usage meter** — issue #642. Hermes shows a live "%
   full" meter broken down by category (system prompt, tools, skills,
   memory, rules, MCP, conversation). No equivalent exists in Mana.
3. **Cron jobs don't load memory before running** — issue #643.
   `plugins/cron-scheduler/index.js` writes each run's result to memory
   afterward (`acpMemoryStore.appendTurn()`) but never loads the
   background-memory summary into the job's own prompt beforehand —
   confirmed by grep, no `buildPromptMemory`/`BACKGROUND_MEMORY`
   reference anywhere in that plugin. Hermes' cron agents do this in
   both directions since v0.21.0.
4. **MCP health/status not surfaced in UI** — issue #644. The backend
   already computes this (`mcpClientCapability.getHealth()`), but
   `McpServerDialog.cs` is registration-only — no health or cost display
   anywhere.
5. **No credential vault integration** — issue #645. Hermes added
   1Password/Bitwarden/OS-keyring-backed credential storage in v0.21.2.
   No equivalent exists anywhere in Mana's provider/plugin credential
   handling.
6. **No live subagent steering UI** — issue #646. Hermes shows a live
   panel of delegated workers (count, task names, elapsed time, latest
   activity) with per-worker Steer/Stop controls. Consistent with the
   earlier finding that Mana's coding agent runs a single linear ACP
   loop with no subagent-monitoring surface at all.
7. **No in-app browser annotate/comment-pin workflow** — issue #647.
   Mana's `browser-automation` plugin is headless/API-driven; Hermes'
   in-app browser pane lets a user click-to-annotate any element with a
   note, attaching a cropped screenshot plus the element's CSS
   selector/markup to the next turn.
8. **No positional/deictic screen-context resolution ("HUD mode")** —
   issue #648. Hermes' HUD bar's on-screen position resolves "this,"
   "here," "that page" to whatever's underneath it. Verified missing in
   Mana on all three fronts: `ScreenContextTrigger.cs` gates screen
   reads on a fixed keyword list only (no positional signal);
   `ScreenContextReader.cs` has no cursor/window-under-point logic
   anywhere; `QuickEntryForm.cs`/`AvatarOverlayForm.cs` have no
   click-through-when-idle behavior.

## Recommendation

Eight issues filed: #641 (memory-graph visualization), #642
(context-window usage meter), #643 (cron jobs load memory), #644 (MCP
health/status UI), #645 (credential vault), #646 (subagent steering
panel), #647 (browser annotate), #648 (positional/deictic screen
context). Each issue's body carries its own Goal/Why/Proposed
Scope/Acceptance Criteria; the `docs/roadmap/issue-NNN-*.md` companion
doc for each mirrors that scope and links back here.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (prior research round,
same verify-before-claiming discipline). Issue #624 (accessibility-tree
wiring into the ambient glance loop) is the natural sibling of #648
above — same subsystem, one more signal for *what* to read.
