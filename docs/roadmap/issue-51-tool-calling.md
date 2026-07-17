# Issue 51: Scope Tool-Calling (Shell/File) Access for Mana's Local Model

## Goal

Let Mana's local model actively call tools (shell commands, file access)
under policy control, the way odysseus's `agent_tools`/`tool_policy.py`
does — a prerequisite already flagged in issue #42's MCP scoping.

## Why

Odysseus's agent loop gives the model bash + file access under an explicit
policy/security layer. Mana's local llama-server runtime
(`node-bot/ai/llama-server-runtime.js`) has no tool-calling loop today —
replies are built from a regex/heuristic intent classifier, not the model
requesting tools.

## Proposed Scope

- Investigate llama.cpp/llama-server's `--jinja` tool-calling template
  support for Mana's current Qwen3/Qwen2.5-Coder models.
- Design a minimal, policy-gated tool set (e.g. read-only file access, a
  narrow allowlisted shell action) with explicit user approval before any
  write/execute action — mirroring node-bot's existing pending-writes
  approval flow for editor edits.
- This is exploratory/foundational: land a working tool-call loop for at
  least one safe, read-only tool before considering anything destructive.

## Acceptance Criteria

- A documented finding on whether Mana's current local models support
  reliable tool-calling via llama-server.
- If viable: one working, policy-gated, read-only tool callable by the
  model end-to-end.
- No destructive/write tool is auto-approved; matches the existing
  approval-required pattern already used for editor edits.
- This issue is understood as a prerequisite for MCP client support
  (issue #42's Phase 2), not a replacement for it.

## Status

Implemented, foundational scope only — one read-only tool, not wired into
the default chat flow yet (see "Not done yet" below).

### Finding: tool-calling reliability depends on which model, not just the infra

Tested directly against the real `llama-server.exe` binary Mana bundles
(`tools/llama/llama-b9436-bin-win-cuda-12.4-x64`), which turned out to
already have more relevant infrastructure than expected:

- `--jinja` (jinja chat-template engine) is **on by default** in this build,
  not opt-in.
- The build also ships an experimental `--tools` flag with its own built-in
  agentic tools (`read_file, file_glob_search, grep_search,
  exec_shell_command, write_file, edit_file, apply_diff, get_datetime`).
  **Not used here** — no documented path-sandboxing for it (`--help` only
  warns "do not enable in untrusted environments"), and half the list is
  exactly the destructive tooling this issue explicitly says not to enable
  yet. Mana's own `tool-policy.js` (below) is the actual gate.

With a real OpenAI-style `tools` array declared in the request body:

| Model (Mana profile) | Result |
|---|---|
| Qwen3-4B (`default`) | **Reliable** — 3/3 requests returned proper `finish_reason: "tool_calls"` with a correctly structured `message.tool_calls` array. |
| qwen2.5-coder-7b-instruct (`coding`) | **Not reliable** — the model produces the *right JSON* (correct tool name and arguments) but wraps it in a markdown code fence inside `message.content` instead of the `<tool_call>...</tool_call>` XML tags its own chat template explicitly asks for. Confirmed via `/props` that the template is correctly instructing it to use those tags — the model just doesn't comply. llama-server's structured-output parser never recognizes the code-fenced version, so `tool_calls` comes back `undefined` every time. |

**Conclusion: tool-calling is viable today, scoped to the `default` profile
(Qwen3-4B).** The `coding` profile's model needs either a different
chat-template/grammar constraint or a different quantization/model before
its tool-calling could be trusted — not attempted here, out of scope for
"foundational."

### One real, working, read-only tool

- `node-bot/ai/tool-policy.js`: exactly one tool, `read_file`, scoped to a
  single allowed root directory (defaults to the Mana repo root). Path
  resolution rejects `../` traversal and absolute paths outside the root —
  tested against both. **No write or shell-execute tool is defined in this
  module at all** — there's nothing to accidentally auto-approve, because
  the capability doesn't exist here yet; adding one is a separate, explicit
  future decision, not a flag on this one.
- `node-bot/ai/llama-server-runtime.js`'s new `runToolAwareReply(prompt,
  toolPolicy, options)`: a single-round tool loop (request → model asks for
  a tool → policy executes it → model sees the result → final reply).
  Deliberately not a multi-step agent loop — matches "land a working
  tool-call loop for at least one safe, read-only tool" without building
  more than that yet. A tool-policy error (e.g. a blocked path) is fed back
  to the model as a normal tool result rather than thrown, so the model can
  respond sensibly ("I can't read that file") instead of the whole reply
  failing.

### Not done yet (deliberately)

- **Not wired into `buildAssistantReply`/the normal chat pipeline.** Every
  existing reply path (`/reply`, `/transcribe`, mobile routes) is
  unaffected — this issue adds a new, tested, independently callable
  capability, not a silent behavior change to how Mana already replies.
  Turning it on for real conversations is a deliberate follow-up decision
  (which profile(s), which tool(s), any UI indicator when a tool was used),
  not bundled into this foundational pass.
- No explicit user-approval UI, since the only tool that exists is
  read-only and already policy-scoped to the project directory — the
  acceptance criterion ("no destructive/write tool is auto-approved")
  holds trivially because no destructive tool is defined. An approval flow
  becomes necessary the moment a write/execute tool is proposed, not
  before.

## Verified

- `node-bot/test/tool-policy.test.js` — 11/11 pass: path-traversal
  rejection (`../`, absolute paths outside root, prefix-sharing sibling
  directories), unknown-tool rejection, missing-file/non-file handling,
  truncation, and the one real successful read.
- `node-bot/test/llama-server-runtime.test.js` — 4 new tests for
  `runToolAwareReply` (successful tool round-trip, policy error fed back to
  the model, no spurious tool round when none is needed, unknown tool name
  rejected via the real policy) — 14/14 pass in that file, all prior tests
  unaffected.
- Full `node run_tests.js` — all files pass, no regressions.
- Real hardware verification (not simulated): drove the actual
  `llama-server.exe` + real Qwen3-4B and qwen2.5-coder-7b GGUF models
  through the standard OpenAI tool-calling request shape multiple times
  each, which is what produced the reliability finding above.
