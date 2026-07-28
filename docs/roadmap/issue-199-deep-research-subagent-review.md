# Issue 199: Deep Research Subagent/Handoff Design Review

## Status: Investigation complete, no code changes (per issue scope)

## What was compared

`langchain-ai/deep_research_from_scratch`'s notebook 4 (`4_research_supervisor.ipynb`)
against Mana's actual issue #145 "parallel subagent delegation" implementation
(`node-bot/tools/subagent-delegation.js` + its one call site in
`node-bot/tools/deep-research.js`).

## LangChain's actual shape (from the repo's own README)

- **Supervisor pattern**: a `supervisor` node (an LLM) decides how to split a
  research question into subtopics and delegates each one via a structured
  `ConductResearch(research_topic)` tool call; a `supervisor_tools` node
  executes those calls. The supervisor can call `ConductResearch` multiple
  times in one turn, and they run concurrently via `asyncio.gather()`.
- **Each subagent is itself a full ReAct agent** (notebook 2's single-research-agent
  loop): its own LLM-decision-node + tool-execution-node loop, free to search
  multiple times, decide when it has enough, and compress its own search
  results before returning.
- **Context isolation is real and structural**: each subagent gets its own
  clean context window. The supervisor never sees a subagent's raw tool
  calls or search results -- only the condensed summary the subagent hands
  back by calling `ResearchComplete`. This is what actually bounds the
  supervisor's context as the number of subtopics grows.

## What Mana's issue #145 actually built

Reading `subagent-delegation.js` top to bottom: it's a flat
`runWithBoundedConcurrency(tasks, {maxConcurrency})` helper -- a worker-pool
that runs a batch of independent `() => Promise` tasks with a concurrency
cap. Its own top-of-file comment is explicit about this: *"Deliberately not
a general-purpose subagent framework: no shared context, no memory/skills
access, one level deep only."*

Its one call site in `deep-research.js` (the `searchAndRead` closure) uses it
to run the **page-reading step** concurrently -- each task is
`read(result.url)`, a plain HTTP fetch + text-extraction, no LLM call inside
it at all. The only two LLM calls in the whole pipeline are the (optional,
single-shot) sub-query decomposition at the start and the final synthesis
at the end (plus, since issue #197, one optional reflect-and-resynthesize
cycle). Sub-query decomposition produces a static list of query strings
up front -- it does not delegate follow-up reasoning to anything.

**So issue #145's "subagent" is concurrent I/O delegation (fetching pages in
parallel), not reasoning delegation (independent LLM agents working
subtopics in parallel).** There is no `ConductResearch`/`ResearchComplete`-style
structured handoff contract anywhere in Mana's pipeline, and no context
isolation boundary -- every source's excerpt (up to `maxSources`, currently
capped at 8, at up to `MAX_EXCERPT_CHARS` = 2000 chars each) is pooled into
one shared array and handed to a single final synthesis call. Nothing
prevents that shared context from growing linearly with `maxSources` /
`maxSubQueries`.

## Why this isn't simply "Mana did it wrong"

LangChain's parallel-subagent design assumes a hosted, multi-request LLM API
where N concurrent subagent conversations are just N concurrent HTTP calls.
Mana runs against **one local `llama-server` instance** (`ai/tool-policy.js`
et al. all funnel through it) -- there is no cheap way to run N independent
LLM reasoning loops concurrently against a single local model process today;
they'd either serialize (defeating the purpose) or require N separate model
loads, which isn't viable pre-5080-upgrade VRAM headroom (and may not be
viable after it either, for N > 1-2). Given that constraint, parallelizing
only the non-LLM I/O (page fetches) while keeping the LLM reasoning to a
small, fixed number of calls (decompose, synthesize, optional reflect) is a
reasonable adaptation, not an oversight -- it's the part of the pipeline that
actually *can* run concurrently on Mana's hardware.

## The one real, concrete gap

Terminology aside, the substantive difference that would matter in practice
is the **missing context-isolation boundary**: LangChain's subagents each
compress their own findings before the supervisor ever sees them; Mana pools
every source's raw excerpt into one shared synthesis prompt. At today's caps
(`maxSources` <= 8, `maxSubQueries` <= 4) this is fine. It would start to
matter if those caps grow, or if per-subtopic depth (letting each sub-query
iterate/search more than once) is ever added.

This is squarely the kind of thing issue #200 ("investigate: context
compression techniques for the memory retriever **and Deep Research
reports**") is already scoped to look at -- that issue currently frames
compression as a storage-time concern (`acpMemoryStore` report persistence),
but the same technique (summarize-before-merge) would also apply to
Deep Research's live pre-synthesis context, not just its persisted output.
Flagging the connection here rather than filing a third issue; #200's own
investigation is the right place to decide whether it's worth building.

## Conclusion

No code changes from this issue. No new follow-up issue filed -- the one
concrete finding (pre-synthesis context isolation) folds into #200's
already-scoped investigation rather than duplicating it. The "subagent"
naming in #145's title is a minor documentation mismatch with the
LangChain/industry meaning of the term, not worth a tracked issue on its
own.
