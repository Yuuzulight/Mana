# Issue #361: does green actually mean correct?

Audit of the node-bot test suite, 2026-08-17. Prompted by the issue, and
then handed a live example partway through: two regressions reached `main`
while every pull request reported green.

## Headline finding: on a pull request, `npm test` runs two files out of 94

`node-bot/run_tests.js` decides what to run:

```js
const skipHeavy =
  process.env.SKIP_HEAVY_MODEL_TESTS === '1' ||
  process.env.SKIP_HEAVY_MODEL_TESTS === 'true' ||
  process.env.GITHUB_EVENT_NAME === 'pull_request' ||
  (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/pull/'));
```

When `skipHeavy` is true it runs exactly two files:

- `test/mobile-device-store.test.js`
- `test/e2e-pairing-smoke.test.js`

There are **94 test files** in `node-bot/test/`.

### The consequence

`GITHUB_EVENT_NAME === 'pull_request'` is checked **independently of the env
var**, so the reduction is not something a workflow opts into — it happens
on every pull request, whatever the workflow intended.

That means:

- `fast-node-tests.yml` (which sets `SKIP_HEAVY_MODEL_TESTS=1`) runs 2 files.
  Expected.
- `heavy-ci.yml` triggered by the `run/full-ci` **label** also runs 2 files,
  because a labelled run is still `pull_request`. **The label does not do
  what its name says.**
- Only a **push to `main`** runs the full suite — after the merge, not before.

### Measured, not inferred

| Run | Event | Heavy Node tests |
| --- | --- | --- |
| PR #380, `run/full-ci` label | `pull_request` | 04:59:48 → 05:00:01 = **13s** |
| `main` after merging #380 | `push` | 05:01:39 → 05:02:23 = **44s** |
| Local `node run_tests.js` | — | **51s** |

13 seconds is the two-file path. 44 seconds matches the local full run.

## The live example

Heavy CI was red on `main` from `0334e81` (PR #371) until `51acd71`. Two
regressions, both introduced by pull requests that reported green:

1. **`health-components.test.js`** — deep-equals the full sorted list of
   health component keys. Adding a capability with a `getHealth` grows that
   list, so the assertion fired. Working exactly as designed.
2. **`tool-source.test.js`** — builds a skill tool source with its own
   approval-gate stub. A change requiring `registerExecutor` at construction
   broke it, while the equivalent stub in `skill-tool-source.test.js` was
   updated.

Neither test is slow, model-dependent, or heavy in any sense. They are
excluded for one reason: they are not one of the two hardcoded files.

## So: does green mean correct?

**On a pull request, green currently means "two files passed."** It carries
almost no information about the change under review. That is not a coverage
problem — the suite is broad, 94 files, and it caught both regressions the
moment it was allowed to run. It is a **gating** problem.

## Secondary findings

### Modules with no matching test file

`caption-server`, `plugin-settings-store`, `server`, `tray-server`,
`vtube-routes`, `vtube-studio-client`.

`server.js` is exercised indirectly through capability and route tests, so
its absence overstates the gap. `caption-server.js` is the sharper one: it
broadcast to nobody for its entire existence (#362), and no test would have
noticed, because a broadcaster with no listener still "works".

### Stub drift is a real, demonstrated risk

The `registerExecutor` break is the exact failure mode the issue predicted:
a hand-written stub that no longer matches the interface it stands in for.
There are two independent approval-gate stubs in the suite, and updating one
did not update the other. Nothing detects that divergence.

### What the suite does well

Worth recording, because the answer to this audit is not "the tests are
bad":

- Injectable paths (`dataDir`, `dbPath`, `logPath`, `filePath`) are used
  consistently so tests never touch real data directories.
- Logic is deliberately extracted for testability — `skill-proposal.js` out
  of a server closure, `speech-filters.js` out of the renderer — rather than
  being reachable only through a fully mocked HTTP route.
- Failure paths are tested, not just happy ones: simulated retriever
  failures, a locked graph DB, invalid JSON, an unavailable embedder all
  appear in the full run's output.
- `health-components.test.js` deliberately asserts an exact set so that
  adding a component is a decision rather than an accident. It did its job.

## Recommendations, in order of value

1. **Stop `pull_request` from silently reducing the suite.** The env var is
   a reasonable opt-in; the event-name check makes it involuntary. Removing
   the `GITHUB_EVENT_NAME`/`GITHUB_REF` clauses would let each workflow
   choose, and would make `run/full-ci` mean what it says.
2. **Make the full suite a required check before merge**, or at minimum let
   the label genuinely trigger it. Today the full suite only ever runs after
   the merge, so `main` is where breakage is discovered.
3. **Share one approval-gate stub** across the tests that need it, so an
   interface change breaks in one place instead of drifting silently.
4. **Cover `caption-server.js`** — a broadcaster with no subscriber is
   exactly the shape of bug that looks healthy from the inside.

Item 1 is the whole audit in one change. Without it, everything else is
verified by a suite that does not run.
