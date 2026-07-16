# Issue 49: Add a Compare Mode for Side-by-Side Local Model Output

## Status

Implemented, `windows-launcher` only. A "Compare" button next to the
composer's Send button toggles an opt-in panel with two model-profile
dropdowns (populated from the existing `GET /models/status`) and two result
columns. Sending a prompt while Compare mode is active fires two parallel
`POST /reply` calls -- one per selected profile, with the typed text and an
explicit `modelProfile` -- and renders both replies side by side once they
settle (`Promise.allSettled`, so one profile failing doesn't block the
other). No new backend route: this reuses `/reply` exactly as the issue
asked, and the calls deliberately omit `sessionId` so exploratory
comparisons don't get saved to chat/session memory. Each column has a
"Prefer this" button that toggles a purely local, mutually-exclusive
highlight -- no telemetry, nothing sent to the backend. Toggling Compare
mode off returns Send/Enter to the normal chat pipeline unchanged; the two
modes don't share any state beyond the composer's text input.

The pure "which two profiles to preselect" decision (`default` vs
`quality` when both exist, else the first two distinct profiles) is
extracted into `windows-launcher/renderer/compare-mode.js` so it has real
unit tests, matching the existing pattern for `reply-emotion.js` and
`voice-endpointing.js`; the rest of Compare mode is DOM/fetch wiring in
`renderer.js`, verified in a real browser via a scratchpad harness that
loads the actual unmodified `renderer.js` with the backend and Electron
APIs mocked.

Follow-up hardening, in both clients:

- Each compare column's label shows which GGUF the selected profile is
  actually using (e.g. "Quality fallback (Qwen3-14B-Q4_K_M.gguf)"), not
  just the profile name -- profiles silently fall back to a smaller model
  when the preferred file isn't downloaded, which would otherwise make two
  "different" profiles compare identically with no indication why.
- Profiles with no matching local GGUF (`available: false`) are disabled
  and labeled "(unavailable)" in the dropdowns, and are excluded from the
  default-pair selection, so a comparison can't silently run against
  nothing.
- A Cancel button appears while a comparison is in flight and aborts both
  `/reply` calls client-side via `AbortController`; an aborted column
  reads "Cancelled." instead of hanging indefinitely.
- `desktop-client` now has the same Compare panel, adapted to its simpler
  single transcript/reply layout: since it has no existing text-send flow
  to hook into, Enter on the message box triggers the comparison only
  while Compare mode is active, and the input's placeholder changes to
  say so. `desktop-client/renderer/compare-mode.js` duplicates the pure
  logic from the windows-launcher module (matching the existing
  `reply-emotion.js` duplication pattern between the two clients);
  desktop-client has no test runner of its own, so this half was verified
  the same way the rest of desktop-client's UI work has been -- live in a
  browser harness loading the real, unmodified `renderer.js`.

## Goal

Let users see how Mana's different local model profiles
(default/fast/quality/coding) respond to the same prompt, to help tune
their own setup.

## Why

Inspired by odysseus's Compare (blind side-by-side model testing and
synthesis). Mana already has multiple local profiles but no way to
directly compare their output.

## Proposed Scope

- New UI view: enter one prompt, get replies from two selected profiles
  side by side.
- Reuse the existing `/reply` endpoint with an explicit `modelProfile` per
  call rather than building a new inference path.
- Optionally let the user mark a preferred response (local-only, no
  telemetry).

## Acceptance Criteria

- Users can run the same prompt against two model profiles and see both
  replies side by side.
- No new backend inference path is introduced — this reuses `/reply` with
  different `modelProfile` values.
- Compare mode is opt-in from the UI, not the default chat flow.
