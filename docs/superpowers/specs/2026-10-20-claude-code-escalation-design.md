# Escalating self-work to Claude Code (#1406)

## Why

The DeepSeek self-work benchmark (2026-10-16, 22 cases) answered the #1406
question for DeepSeek: Flash solves small, well-scoped issues for about
$0.24 per solved case, Pro adds one case for five times the cost, and no
setup solved any of the twelve larger multi-file features (1348-1360).
Flash also spent up to 2.8 hours failing a single case. Mana needs a
stronger last step for the tasks DeepSeek can't do, and it has to be one
Yuuzulight already pays for: a Claude Pro subscription.

Anthropic doesn't allow apps to take a Claude login themselves, but it does
allow what Zed does: run the official Claude Code, unmodified, over the
Agent Client Protocol, with the user signed in inside Claude Code
(Help Center, Oct 2026: "You can still use the Claude Agent SDK, claude -p,
and third-party apps with your subscription limits"). This design does the
same, for Yuuzulight's own use.

## Goals

- When Flash has failed an issue, Mana can hand it to Claude Code, which
  picks up DeepSeek's failed attempt: it works out where and why it failed,
  then fixes or improves that change (or replaces the parts that went the
  wrong way).
- Mana **asks Yuuzulight before every handoff**. Nothing reaches Claude
  without a yes.
- Her guardrails hold exactly as they do for DeepSeek: protected paths,
  credential files and the case's hidden tests are never written, tests run
  only in her sandbox, and the result goes through her reviewer, her tests
  and a PR they approve.
- The self-work bench can run the escalation locally (Flash first, Claude
  on failure), so the hard cases can be measured on their PC once their limits
  reset.

## Non-goals

- Claude for every task. Flash goes first; Claude is the step up.
- A DeepSeek Pro tier in the default chain (the benchmark showed it isn't
  worth its cost). It stays pickable in Settings.
- Opus by default. Pro's five-hour and weekly limits are shared with their own
  Claude and Claude Code use, and Opus drains them about twice as fast as
  Sonnet. The model is a setting; the default is Sonnet 5.5.
- Running Claude on the AWS benchmark instance.

## Anti-goals (a failure even if it works)

- Mana ever reading, storing, copying or forwarding Claude credentials or
  session tokens. Sign-in happens only in Claude Code's own `/login`.
- Offering Claude sign-in to anyone but Yuuzulight, or as a product feature.
  It's documented as personal use of their own subscription.
- Claude Code getting its own unrestricted shell, or writing outside the
  worktree, or touching a guardrail.
- Mana switching to paid usage credits or retrying when a limit is hit.
- A handoff that quietly uses up their limits: every one is asked first, with
  an estimate.

## The design (decided)

**The chain.** Unchanged up to the end: her local attempts, then the tiers
picked in Settings (default now Flash only), then the new Claude tier.
Escalation to Claude is offered when a Flash run ends in any of: her stuck
stop, the third refutation by her reviewer, tests still failing at the end
of its budget, or a case she judged large up front. Claude is the last tier;
when it fails, the run ends as today ("needs you").

**The handoff ask.** Through her existing approval gate, like a test run:
issue, what DeepSeek tried and why it failed, the model, and a rough share
of their five-hour window. Declining ends the run as a normal failure. The
5-runs-a-day remote cap counts Claude runs too.

**Running Claude Code.** Mana is an ACP client of the open-source Claude
Code ACP adapter (the one Zed uses), started as a child process in the
issue's worktree. They install Claude Code and sign in once with `/login`;
Mana checks only "is Claude Code installed and signed in" and tells them to
run `/login` if not. `ANTHROPIC_API_KEY` is removed from the child's
environment so it can't silently switch to API billing.

**Guardrails.** Mana answers the agent's permission requests and file
operations herself:
- Edits and writes go through her existing `writeRefusal` (worktree by real
  path, never `.git`/`.github`/`node_modules`, credential files, guardrails,
  hidden tests). Refused writes are reported back to Claude as errors.
- Its shell, web fetch and any tool outside the worktree are denied.
- Tests: Mana gives the session her own sandboxed test runner (the
  self-work test tool, approved by her gate as today) as an MCP tool, and
  that is the only way Claude runs code.

**The handoff brief.** The worktree as DeepSeek left it, plus: the issue,
DeepSeek's plan, a short list of its steps, the failing test output, the
reviewer's refutations, and how the run ended. Not the full transcript.

**When it's done.** Claude ending its turn is treated like her
`session_goal__finish`: her review passes, her reviewer and her tests run on
the worktree's diff, and a passing change becomes a PR exactly as from
DeepSeek. A failing one ends as "needs you" with Claude's summary attached.

**Limits.** A usage-limit response stops the Claude run, marks it "paused
until the reset" (not a failure), and the issue can be resumed. No paid
credits, no retry loop.

**Bench.** A new setup, `flash-claude`: each case runs Flash; on failure it
escalates to Claude in the same worktree with the brief above. Starting
the bench with that setup is the approval for its handoffs (one yes per run,
not per case). It runs on their PC only and stops cleanly at a usage limit,
resumable with the cases that are left. Reports show the Flash and Claude
parts separately (pass, and Claude usage instead of dollars).

## Left to the builder

- The adapter's current package and version (Zed's `claude-code-acp`; it
  may have been renamed), and the ACP client library to use.
- **Check first, in a short spike:** that the adapter really routes Claude
  Code's edits through the client (ACP file operations or permission
  requests) and lets the client deny its own shell and read tools outside
  the worktree. If it doesn't, the guardrails above can't be guaranteed this
  way and the design comes back for a decision before anything else is
  built.
- How "a share of the five-hour window" is estimated (a plain rough
  estimate from the case's size is enough).
- Where the Claude tier's settings live (model, on/off) in Settings.
- What "a case she judged large up front" means in practice (for example,
  her plan naming more than a few files); start simple.
- How the sandboxed test tool reaches Claude Code: ACP's `session/new`
  takes MCP servers, so a small stdio MCP server that calls back into Mana
  (which routes the run through her approval gate and sandbox) is one way.
- Her reviewer and review passes keep using the model they use today (the
  DeepSeek helper), so a Claude run still needs a DeepSeek balance for its
  review.

## Calls I made (Claude), not decided by Yuuzulight

- Claude gets DeepSeek's plan and a step summary, not the full transcript.
- The approval goes through her existing gate, not a new prompt.
- Starting a `flash-claude` bench run is the approval for its handoffs.
- Claude runs count toward the existing 5 remote runs a day.
- The adapter's own shell is denied entirely, not just restricted.
