# Issue 70: Best-of-N Self-Voting Inference for Coding Replies

## Goal

Extend Mana's existing single-candidate reply verification/retry system
into real multi-draft generation with model-driven selection, for
coding-mode replies specifically.

## Why

Mana has no sampling-parameter control or multi-draft generation today,
but it does have one adjacent, narrower mechanism worth building on
rather than replacing:

- `node-bot/ai/llama-server-runtime.js` never sends `temperature`,
  `top_p`, `top_k`, or any sampling-variation parameter to llama-server's
  `/v1/chat/completions` endpoint — every request body only carries
  `messages` and `max_tokens`. Every call site produces exactly one
  completion.
- The only existing "regeneration" logic is `server.js`'s opt-in
  verify/retry pass (`MANA_VERIFY_REPLY=1`,
  `MANA_AUTO_RETRY_VERIFICATION=1`): it runs `verifyReply()`
  (`node-bot/utils/reply-verifier.js` — checks fenced code blocks via
  `checkPythonSyntax`/`simpleBracketCheck`/JSON parsing, purely syntactic)
  against the single reply just generated, and if that fails, re-calls
  the model **once more, sequentially**, with a prompt appending the
  specific issues found, up to `MANA_VERIFY_MAX_RETRIES` (default 1)
  extra attempts. There is only ever one candidate in flight at a time —
  no parallel drafts, no temperature variation between attempts, and no
  ranking/selection among multiple candidates, since there's never more
  than one.
- This is real infrastructure to extend, not scope from scratch: the
  coding-mode detection (`pickAssistantMode`/`CODING_SYSTEM_PROMPT` in
  server.js) and the syntactic verifier already exist and already gate on
  `mode === "coding"` in places (e.g. retrieval augmentation via
  `MANA_RETRIEVAL_MODES`).

## Proposed Scope

- Add real sampling-parameter support to `llama-server-runtime.js`'s
  request builder (temperature, top_p, etc.) — currently absent entirely.
- For coding-mode replies specifically, generate 3-5 candidate
  completions using varied temperature (parallel requests to
  llama-server, or sequential if VRAM/throughput on this hardware doesn't
  support concurrent generation — needs real measurement, not assumption,
  especially given the ~2.5 tokens/sec generation speeds already observed
  with heavier local models on this machine's 8GB GPU).
- Add a greedy (temperature 0), single-pass "judge" step: feed the N
  candidates back to the model, asking it to critique syntax correctness,
  edge-case handling, and efficiency, and return the single best
  candidate. This is a genuinely new step — distinct from the existing
  syntactic-only `verifyReply()`, which never asks the model to
  compare/rank drafts.
- Decide whether this replaces or layers on top of the existing
  verify/retry pass — e.g. run syntactic verification on the judge's
  chosen candidate as a final gate, reusing `reply-verifier.js` rather
  than duplicating its checks.
- Gate this behind its own opt-in env var (matching the
  `MANA_VERIFY_REPLY`-style precedent) given the real latency cost of
  generating multiple drafts sequentially on local hardware — this should
  not become the default coding-mode path until its real latency is
  measured and acceptable.

## Acceptance Criteria

- Coding-mode replies can generate N candidate drafts (N configurable,
  default 3) with varied temperature, gated behind an explicit opt-in env
  var.
- A judge pass (temperature 0) selects a single best candidate using the
  model's own critique of syntax, edge cases, and efficiency, verified
  with a real example where the judge's chosen candidate differs from the
  first-generated draft.
- Real end-to-end latency for the full N-draft-plus-judge pipeline is
  measured and documented on this hardware, so users can judge whether
  it's worth the wait.
- Existing `MANA_VERIFY_REPLY`/`MANA_AUTO_RETRY_VERIFICATION` syntactic
  verification continues to work unchanged when this feature is off
  (default).
- Casual/everyday mode replies are unaffected — this is scoped to coding
  mode only.

## Notes

Part of a 3-issue initiative:
- #68 — dynamic VRAM hotswap tuning
- #69 — idle-triggered Dream Mode memory consolidation
