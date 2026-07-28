# Issue 215: Surface Fish Speech's torch.compile Warmup

## Goal

Issue #213 enabled `torch.compile` for Fish Speech (~12x steady-state
speedup). The trade-off: `torch.compile` is lazy -- the ~4 minute compile
trace fires on the *first real generate() call*, not at process launch.
Before this issue, that first call was whatever the user's first real
chat message happened to trigger, and it would blow straight through
`fishTtsTimeoutMs` (20s default) and silently fall back to Kokoro for
that one reply -- a real, if minor, functional regression introduced by
#213, not just a missing UX nicety.

## Status: Implemented (`tts-runtime.js`, `server.js`, `doctor.js`)

## Design

- **`tts-runtime.js`'s new `warmupFishTts()`/`getFishWarmupStatus()`**
  -- fires one throwaway synthesis call ("Warming up.") against Fish
  Speech on its own, much longer timeout (`FISH_TTS_WARMUP_TIMEOUT_MS`,
  default 5 minutes) separate from the normal per-reply
  `fishTtsTimeoutMs` (20s) -- reusing `postFishTtsBuffer`'s existing
  request-building logic via the same injectable `postFish` seam
  `synthesizeReply` already uses, just with a timeout override.
  `fishWarmupStatus` tracks `idle -> warming -> ready|failed`, or
  `skipped` immediately if the configured provider isn't `fish`.
- **`server.js` fires this eagerly at startup**, mirroring the existing
  `MANA_EAGER_LLAMA_SERVER` pattern -- but *unconditionally* (no opt-in
  env var) whenever the provider is `fish`, unlike the llama-server one.
  The llama warmup is opt-in because eagerly starting llama-server has
  real GPU/resource cost even when nobody asked for it; this warmup has
  no such downside if Fish Speech is already the configured provider --
  running it is strictly better than not, given #213's actual timeout
  regression. Skipped entirely under `NODE_ENV=test`/`NODE_TEST_CONTEXT`
  so the test suite never fires a real outbound request.
- **`GET /health` now includes `fishTtsWarmup`** (`idle|warming|ready|
  skipped|failed`), read directly from the same in-memory `ttsRuntime`
  instance (no extra network hop -- doctor.js and this route run in the
  same process).
- **`doctor.js`'s new `checkFishTtsWarmup` check** surfaces this as a
  Doctor popup entry ("Voice warmup"): `warn` while warming or if the
  warmup call failed, `pass` once ready, and -- importantly -- entirely
  **absent** (not just hidden, actually omitted from the checks array)
  when there's nothing to report (`idle`/`skipped`), so it never shows up
  for non-fish setups or before the eager call has even had a chance to
  update the status.

## Deliberate simplification: Doctor popup, not the startup loading screen

The original plan (and issue #215's own initial scope) was to surface
this on the startup loading screen's existing `voice` row. Investigating
the actual code changed that: **both `windows-launcher` and
`desktop-client`'s loading screens use a fixed, hardcoded row/service ID
list that must all reach a terminal state (ready/failed/skipped/timeout)
before the overlay hides** (`windows-launcher`'s `STARTUP_ROW_IDS`,
`desktop-client`'s `SERVICE_IDS`). Making the `voice` row genuinely wait
out an open-ended ~4 minute warmup would hold up the *entire* loading
screen for that long on a cold Fish Speech start -- exactly the
"unexplained pause" issue #138 was built to eliminate, and a regression
issue #215 should not introduce to fix a different one.

Both apps already have a **Doctor popup** with its own non-blocking
pass/warn/fail display, fed by `node-bot/doctor.js`'s existing
structured check system -- no startup-blocking constraint, no new UI
plumbing needed in either app (both already render whatever
`runDoctorChecksAsync()` returns generically). Confirmed with the user
before building this direction instead of the originally-scoped one.

## Out of scope

- Any change to the startup loading screen's row list/blocking behavior
  in either app.
- A dedicated warmup-progress indicator elsewhere in the chat UI itself
  (e.g. a toast) -- the Doctor popup is the only surface for now; a
  more prominent indicator is real future work if it turns out the
  Doctor popup isn't discoverable enough in practice.

## Verified

- `node-bot/test/tts-runtime.test.js` (+3 tests): `warmupFishTts` skips
  for non-fish providers, goes `idle -> warming -> ready` on success
  (asserting the in-flight `"warming"` status and the longer warmup
  timeout actually get used), and goes `idle -> warming -> failed`
  (never throwing) when the warmup call itself fails.
- `node-bot/test/doctor.test.js` (+4 tests): the check is entirely
  omitted for `undefined`/`idle`/`skipped`, warns while warming, warns
  (not fails) when the warmup call failed, and passes once ready.
- Full `node-bot` suite (one process per file): no regressions -- traced
  and ruled out an unrelated pre-existing slow test
  (`test/server-routes.test.js`, confirmed slow even with these changes
  fully reverted via `git stash`) before concluding this.
