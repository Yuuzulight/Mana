# Issue 200: Context Compression Techniques Review

## Status: Investigation complete, no code changes to memory/retriever (per issue scope). One concrete gap found -- filed as issue #208.

## What was compared

`langchain-ai/context_engineering`'s `3_compress_context.ipynb` (which covers
three techniques: **conversation summarization**, **tool output
compression**, and **state-based compression**) against what
`acp-memory-store.js`, `tools/retriever-index.js`, and Deep Research
(`tools/deep-research.js`) actually do today.

## Correcting the issue's own premise: conversation summarization already exists

Issue #200's background assumed "entries and reports are stored close to
verbatim, bounded mainly by `maxChars` truncation" -- checking the actual
code shows this is only true for *some* of Mana's memory tiers, not all of
them. `acp-memory-store.js` already has genuine LLM-based **summarization-on-write**
(built for issue #141, "bounded memory tier"): `appendTurn()` tracks the
rolling session summary's token count via `tokenEstimator`, and once it
crosses 90% of `maxSummaryTokens`, fires a background call to
`summarizeFn({sessionId, summary, turns, maxSummaryTokens})` -- wired in
`server.js` (`summarizeFn: async ({...}) => {...}`) to a real prompt sent to
either the remote AI path or the local `llama-server`, asking for a compact
summary that keeps concrete facts and preferences. This is conditional
summarization based on context length, which is exactly the "State-based
Compression" and "Conversation Summarization" techniques the notebook
covers. **No gap here** -- this part of Mana's memory system already does
what the notebook teaches.

## The real gap: tool output compression

The notebook's second technique -- summarizing token-heavy tool responses
(its own example: RAG retrieval results) before they enter the model's
context -- is genuinely missing:

- `tools/retriever-index.js`'s search results are flat character-truncated
  (`snippet = String(raw).slice(0, 800)`, three call sites), never
  summarized.
- `tools/deep-research.js`'s per-source excerpts are the same shape
  (`MAX_EXCERPT_CHARS = 2000`, a flat slice of the fetched page's raw text
  in the `read()` step) -- up to `maxSources` (capped at 8) of these get
  pooled into the final synthesis prompt untouched. This is the same
  spot issue #199's investigation flagged as lacking a context-isolation
  boundary -- a related but distinct problem: #199 was about *how many*
  sources' raw text share one prompt, this is about *how each individual
  source's text* gets shaped before it's included at all.

This matters concretely on Mana's hardware: `llama-server`'s default
context window is 4096 tokens (confirmed against the real number when
fixing the video-watch plugin's frame budget, issue #154) -- 8 sources at
2000 chars each is up to ~4000 tokens of excerpt alone, before the system
prompt, the question, and any prior conversation. A flat character cut can
sever a source mid-sentence or mid-fact, keeping whatever text happened to
come first rather than what's actually relevant to the question -- pure
truncation has no way to prefer relevance over position.

## Conclusion

One concrete, worthwhile gap: raw search/read excerpts (both
`retriever-index.js` and `deep-research.js`) are truncated by position, not
compressed by relevance, before reaching the model. Filed as **issue #208** --
scoped narrowly to summarizing individual tool-output excerpts (the notebook's
"Tool Output Compression" technique), not a rebuild of the memory system or a
duplicate of #199's separate context-isolation gap.
