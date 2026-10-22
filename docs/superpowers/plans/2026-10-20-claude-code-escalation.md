# Claude Code Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When DeepSeek Flash fails a self-work issue, Mana asks Yuuzulight, then hands the attempt to the official Claude Code (her Pro subscription, signed in inside Claude Code) over ACP, with Mana's own guarded tools as Claude's only tools.

**Architecture:** Claude Code is one more *runner* for `loop()` in `node-bot/self-work.js` (same contract as `remoteToolReply`: `runner(prompt, tools, opts) -> Promise<{content, rounds, messages}>`). The runner starts the Claude Code ACP adapter, gives the session one MCP server (a local HTTP MCP endpoint, `127.0.0.1` + random token) that exposes exactly `tools.tools` and calls `tools.executeTool`, and starts the session with every Claude Code built-in tool switched off (`_meta.claudeCode.options`: `tools: []`, `disallowedTools`, `settingSources: []`, `strictMcpConfig`). So every edit, test run, review and finish goes through her existing policy (`writeRefusal`, sandboxed tests, reviewer), and `remoteAttempt` judges the result as for any tier.

**Tech Stack:** Node 22, `node:test`; `@modelcontextprotocol/sdk` (already a dependency); `@agentclientprotocol/sdk@1.8.0` (ACP client) and `@agentclientprotocol/claude-agent-acp@0.91.0` (the adapter Zed uses, renamed from `@zed-industries/claude-code-acp`), pinned exact.

**Spec:** `docs/superpowers/specs/2026-10-20-claude-code-escalation-design.md`

## Global Constraints

- Mana never reads, stores, copies or forwards Claude credentials or session tokens; sign-in only through Claude Code's own `/login`.
- Every `ANTHROPIC_*`, `CLAUDE*` and `USE_*_OAUTH` variable is removed from the adapter's environment (an API key would bill the API; a host app's variables point it at that app's session and break the login).
- Claude Code gets no built-in tool (no shell, no read/edit/write, no web); its only tools are Mana's, through the MCP endpoint.
- Every handoff asks Yuuzulight first through the approval gate (type `self-work-claude`); a bench run with setup `flash-claude` is the approval for its own handoffs.
- Default Claude model alias `sonnet` (Claude Code resolves it to its newest Sonnet, Sonnet 5.5 today; a pinned id breaks older Claude Code builds); the model is a setting (`MANA_CLAUDE_CODE_MODEL`).
- A usage-limit response pauses the run ("paused until the reset"), never a failure, never a retry, never paid credits.
- Claude runs count toward the existing 5 remote runs a day (`PER_DAY`).
- Default DeepSeek chain is Flash only; Pro stays pickable in Settings.
- Personal use: no Claude sign-in offered in any UI for other users; `.env.sample` says it uses the user's own subscription.
- Tests: `node:test`, one file at a time (`node --test test/<file>.test.js`).

## Review Focus

- Claude Code not installed or not signed in: the run ends with "install Claude Code / run `claude` then `/login`", no crash, no approval asked first.
- A limit hit mid-run: the worktree keeps Claude's partial work, the run is "paused", `escalation.finish` is not called as a failure, and resuming later continues with Claude.
- `ANTHROPIC_API_KEY` set in Mana's own `.env`: it must not reach the adapter (silent API billing otherwise).
- The MCP endpoint must refuse requests without the token, and listen on `127.0.0.1` only.
- Yuuzulight declines the handoff: the issue ends as a normal failure with DeepSeek's attempt put back, and nothing is sent to Claude.

---

### Task 1: Spike - does the adapter let Mana be Claude's only tools? (gate) - DONE 2026-10-22, PASSED

Result: with `_meta.claudeCode.options = { model, tools: [], disallowedTools: <built-ins>, settingSources: [], strictMcpConfig: true }` and one HTTP MCP server, Claude Code (Sonnet 5.5, her Pro login) had only that server's tools: no shell, no reads; its MCP call arrived as `session/request_permission` titled `mcp__mana__<tool>` (approve those, reject anything else); it wrote nothing itself; `stopReason` `end_turn`; `PromptResponse.usage` has `inputTokens/outputTokens/cachedReadTokens/cachedWriteTokens/totalTokens`; signed out = `RequestError` code -32000 "Authentication required". Needed a standalone `claude` `/login` (the Claude app's own login isn't usable outside it). No settings file needed.

Throwaway, outside the repo (session scratchpad). **If any check fails, stop and report to Yuuzulight; nothing else is built.** Uses a little of her Pro limits.

**Files:**
- Create (scratch): `<scratchpad>/claude-acp-spike/spike.js`, `package.json`

- [ ] **Step 0: Yuuzulight installs Claude Code and signs in** (`claude`, then `/login`, Pro account). Ask her; wait.
- [ ] **Step 1: Install the adapter and ACP SDK in the scratch dir**; record the adapter's actual package name and version (`claude-code-acp` may be renamed).
- [ ] **Step 2: Write `spike.js`**: a temp git repo as `cwd`; `.claude/settings.json` there with `permissions.deny` for every built-in (`Bash`, `Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Task`); a local HTTP MCP server exposing one tool `write_file {path, text}` that logs calls; spawn the adapter with `ANTHROPIC_API_KEY` removed; `initialize` (no fs, no terminal capabilities), `session/new` with that MCP server and model `claude-sonnet-5-5`, then prompt: "Create hello.txt containing hi using the write_file tool. Then also try to list files with a shell command and to read C:\\Windows\\win.ini."
- [ ] **Step 3: Run it and record**: (a) `write_file` was called with `hello.txt`; (b) no file was written by Claude Code itself; (c) the shell and the outside read never ran (denied, or a permission request that the client rejects); (d) the model reported/used is Sonnet 5.5; (e) what `initialize`/`session/new` return when signed out (temporarily `claude /logout`, then log back in), and the exact error shape; (f) the `stopReason` at the end and whether usage is reported.
- [ ] **Step 4: Report to Yuuzulight** with (a)-(f). Continue only if (a), (b), (c) hold.

### Task 2: Mana's tools as an MCP endpoint

**Files:**
- Create: `node-bot/ai/policy-mcp-server.js`
- Test: `node-bot/test/policy-mcp-server.test.js`

**Interfaces:**
- Produces: `startPolicyMcpServer(tools: {tools, isKnownTool, executeTool}) -> Promise<{ url: string, headers: {Authorization: string}, calls: Array<{name, args}>, close(): Promise<void> }>` (streamable HTTP, `127.0.0.1`, port 0, random bearer token; each MCP tool = one entry of `tools.tools` by `function.name` / `description` / `parameters`; a call returns `executeTool`'s string as text, a thrown error as `isError` text).

- [ ] **Step 1: Write the failing tests** with the MCP SDK client:
  - `lists exactly the policy's tools` (names equal `tools.tools.map(t => t.function.name)`).
  - `a call reaches executeTool with its arguments and returns its text`.
  - `a thrown error comes back as an error result, not a crash`.
  - `refuses a request without the token` (HTTP 401) and `listens on 127.0.0.1 only` (`url` host).
- [ ] **Step 2: Run** `node --test test/policy-mcp-server.test.js` - expect FAIL (module missing).
- [ ] **Step 3: Implement** with `@modelcontextprotocol/sdk` (`McpServer` + streamable HTTP transport) and `node:http`; token check before the transport.
- [ ] **Step 4: Run** - expect PASS.
- [ ] **Step 5: Commit** `Self-work: her tools as a local MCP endpoint for an outside agent`.

### Task 3: The Claude Code runner

**Files:**
- Create: `node-bot/ai/claude-code-runner.js`
- Create: `node-bot/test/fixtures/fake-acp-agent.js` (ACP agent on stdio, scripted by env: `FAKE_ACP_MODE=finish|limit|signed-out`)
- Test: `node-bot/test/claude-code-runner.test.js`
- Modify: `node-bot/package.json` (add the ACP SDK and the adapter from Task 1)

**Interfaces:**
- Consumes: `startPolicyMcpServer` (Task 2).
- Produces: `createClaudeCodeRunner({ model = "sonnet", command, args, env = process.env, worktree }) -> runner(prompt, tools, opts) -> Promise<{ content: string, rounds: number, messages: null, usageLimit?: true, unavailable?: string }>`; `DENIED_BUILTINS: string[]` (the list from Task 1); `claudeCodeAvailable({ command, args, env }) -> Promise<null | string>` (null, or why not: not installed / not signed in, worded for her).
- `command`/`args` default to the adapter installed in `node-bot/node_modules` (run with `process.execPath`).

- [ ] **Step 1: Write the failing tests** (against the fake agent):
  - `asks for a session with no built-in tools` (`_meta.claudeCode.options`: `tools: []`, `disallowedTools` equals `DENIED_BUILTINS`, `settingSources: []`, `strictMcpConfig: true`, `model`).
  - `passes only Mana's MCP endpoint to session/new and the configured model`.
  - `strips every ANTHROPIC_*, CLAUDE* and USE_*_OAUTH variable from the agent's env` (fake echoes its env).
  - `approves permission requests for mcp__mana__ tools and rejects any other`.
  - `content is the agent's final message; rounds counts its turns` (mode `finish`).
  - `a usage-limit stop returns usageLimit: true` (mode `limit`).
  - `signed out returns unavailable: "run claude, then /login"` and `claudeCodeAvailable` says the same (mode `signed-out`).
  - `stops the agent and closes the MCP endpoint when done`.
- [ ] **Step 2: Run** `node --test test/claude-code-runner.test.js` - expect FAIL.
- [ ] **Step 3: Implement**: start the endpoint, spawn, `initialize`, `session/new` (cwd = worktree, mcpServers = [endpoint], model), `session/prompt` with `prompt`; approve `session/request_permission` only for titles `mcp__mana__*`, reject the rest; collect text; signed out = `RequestError` code -32000 -> `unavailable`; classify limit errors by `/usage limit|limit reached|rate limit/i` on the error or final message; always kill the child and close the endpoint in `finally`.
- [ ] **Step 4: Run** - expect PASS.
- [ ] **Step 5: Commit** `Self-work: Claude Code over ACP as a runner, with only her tools`.

### Task 4: The Claude tier in her escalation

**Files:**
- Modify: `node-bot/self-work-escalation.js` (default tiers; Claude tier)
- Modify: `node-bot/self-work.js` (`escalate()` around lines 1017-1100; `handoffBrief`)
- Modify: `node-bot/server.js:3130` (pass `claudeRunner`)
- Modify: `node-bot/.env.sample`
- Test: `node-bot/test/self-work-escalation.test.js`, `node-bot/test/self-work.test.js`

**Interfaces:**
- Consumes: `createClaudeCodeRunner`, `claudeCodeAvailable` (Task 3).
- Produces: tier `{ id: "claude", label: "Claude (Sonnet 5.5)", model, agent: true }` appended last by `tiersFor` when `MANA_CLAUDE_CODE=1`; `options.claudeRunner(worktree) -> runner` on `createSelfWork`; approval type `"self-work-claude"`; `handoffBrief(r, out) -> string`.

- [ ] **Step 1: Write the failing tests**:
  - escalation: `default DeepSeek chain is Flash only`; `the Claude tier comes last when MANA_CLAUDE_CODE=1, with MANA_CLAUDE_CODE_MODEL or sonnet`; `a Claude run counts toward the day's 5`.
  - self-work (scripted runners, fake gate): `Flash fails -> she asks with type self-work-claude, naming the issue, why Flash failed, the model, and a rough share of the five-hour window (the summary contains "five-hour")`; `declined -> no Claude run, her own attempt is put back, run ends as today`; `approved -> Claude runs in the worktree as Flash left it (not reset) and its prompt contains the brief: plan, steps, failing tests, refutations, how it ended`; `Claude's change passes her judge -> PR path as from DeepSeek, r.fromRemote.label is the Claude label`; `usageLimit -> run state "paused", escalation.finish not called, a later retry resumes with Claude`; `claude unavailable -> one log line telling her to run claude then /login, no approval asked`.
- [ ] **Step 2: Run** each file alone - expect FAIL.
- [ ] **Step 3: Implement**: in `escalate()`, for a tier with `agent: true`: check `claudeCodeAvailable`, ask `approvalGate.requestApproval("self-work-claude", { summary, payload, forceReview: true })` (register a no-op executor once), skip `resetWorktree`, set `r.priorFacts = handoffBrief(r, out)` (out = the Flash tier's result), run `remoteAttempt(r, issue, options.claudeRunner(r.worktree))`; `usageLimit` -> `r.paused = "Claude's usage limit; I'll pick this up after it resets"` and return `{ held: ... }` (existing hold path) without `escalation.finish`. `handoffBrief` reuses `failureFacts(r)` plus the Flash tier's `how` line and refutations.
- [ ] **Step 4: Run** - expect PASS; also `node --test test/self-work-bench.test.js` still passes.
- [ ] **Step 5: `.env.sample`**: `MANA_CLAUDE_CODE=0` and `MANA_CLAUDE_CODE_MODEL=sonnet`, with: "Uses your own Claude subscription through Claude Code (install it, run `claude`, then `/login`). Every handoff asks you first. Personal use only."
- [ ] **Step 6: Commit** `Self-work: hand a failed Flash attempt to Claude Code, after asking (#1406)`.

### Task 5: The `flash-claude` bench setup

**Files:**
- Modify: `node-bot/bench/self-work-bench.js` (setup parsing around line 831; the case loop around 900-960; `benchTestGate`)
- Test: `node-bot/test/self-work-bench.test.js`

**Interfaces:**
- Consumes: Task 3's runner, Task 4's tier and approval type.
- Produces: `--setup flash-claude` = `--remote deepseek-flash` plus the Claude tier; report rows gain `claude: { ran, passed, rounds, usageLimit }`; the bench gate approves `self-work-claude` only for this setup.

- [ ] **Step 1: Write the failing tests**: `flash-claude escalates a failed Flash case to Claude in the same worktree`; `a passing Flash case never reaches Claude`; `the bench gate approves self-work-claude only under flash-claude`; `a usage limit stops the run with "resume with" and the cases left`; `the report marks Claude rows and has no dollar figure for them`.
- [ ] **Step 2: Run** `node --test test/self-work-bench.test.js` - expect FAIL.
- [ ] **Step 3: Implement** in the bench's case loop and gate; refuse `flash-claude` on a run whose `--remote` is not Flash.
- [ ] **Step 4: Run** - expect PASS.
- [ ] **Step 5: Commit** `Bench: flash-claude setup, run locally after a limit reset`.

### Task 6: Hand-off to Yuuzulight

- [ ] **Step 1:** Run the touched test files one at a time; all pass.
- [ ] **Step 2:** Ask Yuuzulight before opening an issue and PR (her rule); the PR links #1406 and lists the calls below.
- [ ] **Step 3:** Tell her the bench command for after her reset: `node bench/self-work-bench.js --setup flash-claude --remote deepseek-flash --helper-model deepseek-flash --case <id> ...` on the twelve hard cases, and that it needs a DeepSeek balance for Flash and the reviewer.

## Calls made in this plan (not decided by Yuuzulight)

- Claude's tools are Mana's whole self-work toolset over MCP, with all of Claude Code's built-ins denied (stronger than filtering its edits).
- The Claude tier is switched on by `MANA_CLAUDE_CODE` / `MANA_CLAUDE_CODE_MODEL` in `.env` (no Settings UI yet).
- No separate "large up front" trigger in v1: any Flash failure offers the handoff.
- Reports show Claude rows without dollars (subscription), with rounds and limit stops.
