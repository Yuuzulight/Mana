# Issue 145: Parallel Subagent Delegation for Deep Research

## Goal

Let Deep Research fan out independent source-gathering into a small
number of parallel, capped, isolated sub-tasks instead of working through
sources strictly one at a time.

## Status: Implemented

- **`node-bot/tools/subagent-delegation.js`** (new): `runWithBoundedConcurrency(tasks, {maxConcurrency, onTaskSettled})`
  -- a flat worker-pool primitive. Each task is `() => Promise<T>`, fully
  isolated (no reference to the others, can't spawn further tasks of its
  own -- nothing here gives it the means to). Results come back as
  `{ok, value}` / `{ok, error}` in the *same order as the input tasks*,
  regardless of which one actually finishes first, so a caller assigning
  position-based metadata (citation numbers) doesn't need to reason about
  completion order.
- **`tools/deep-research.js`'s Step 3** (reading pooled sources) now
  dispatches all reads for the current batch through
  `runWithBoundedConcurrency`, capped by a new `maxConcurrency` option
  (default 3, capped at 5, same clamp-function pattern as `maxSources`
  etc.). Each source's `index` is assigned by pool position up front
  (`i + 1`), not by completion order, so citations stay stable.

## Real bug caught mid-implementation

The first version checked cancellation once before dispatching the whole
batch. That broke the existing
`"runDeepResearch stops with ResearchCancelledError when isCancelled flips true"`
test: with reads now firing concurrently, a single up-front check can't
stop tasks that haven't started their own read yet once `isCancelled()`
flips true partway through the batch (the old sequential loop checked
between *every* iteration). Fixed by moving the cancellation check inside
each task, right before it starts its own read -- a task whose turn comes
up after cancellation flips bails out before calling `read()` at all,
matching the original per-iteration behavior. `ResearchCancelledError` is
special-cased in each task's catch block (rethrown, not converted into a
`readFailed` fallback source) and re-surfaced by the caller once the
batch settles.

## Deliberate simplifications

- **No general-purpose subagent framework.** `runWithBoundedConcurrency`
  has no memory/skills access, no ability to spawn nested sub-tasks, and
  isn't exposed to any other capability yet -- matches the issue's explicit
  scope ("start scoped to Deep Research, expand later if it proves useful
  elsewhere").
- **"Only the final summary enters the main context" was already true.**
  Each source only ever contributed its truncated excerpt
  (`MAX_EXCERPT_CHARS`) to the synthesis prompt, never raw page content or
  intermediate steps -- parallelizing the reads doesn't change what
  reaches the model, just how the reads themselves are scheduled.
- **Step 2 (multi-query search) stays sequential.** Its per-domain-cap
  bookkeeping (`domainCounts`, `seenUrls`) is accumulated incrementally
  across sub-queries in a way that depends on processing order; making it
  concurrent would need re-deriving that logic to be safe under
  non-deterministic completion order, which the issue doesn't ask for --
  it names source *reading* as "the clearest case of independent,
  parallelizable sub-work," not searching.
- **Not exposed via the HTTP route.** `maxConcurrency` is an internal
  `runDeepResearch` option (useful for tests and future callers); no new
  request-body field was added to `deep-research-capability.js`'s
  `/research/start` route, since nothing asked for per-request tuning of
  it.

## Verified

- `node-bot/test/subagent-delegation.test.js` (6 tests, new): order
  preservation regardless of completion order, hard concurrency cap
  enforcement, per-task error isolation, default/invalid concurrency
  handling, empty task list, and `onTaskSettled` firing once per task.
- `node-bot/test/deep-research.test.js` (16 tests, 2 new): concurrent
  reads actually overlap (measured via an in-flight counter) and stay
  within the configured cap, citation numbering stays stable regardless of
  completion order, `maxConcurrency` clamps to its documented bound, and
  all 14 pre-existing tests -- including the cancellation one the initial
  version broke -- still pass.
- `node-bot/test/deep-research-capability.test.js` (14 tests): unaffected.
