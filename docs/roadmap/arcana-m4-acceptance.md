# Arcana M4 acceptance matrix

Status: **complete** for the Obscura-backed Arcana path (2026-11-13).
Release code signing is intentionally postponed and is not part of this acceptance.

Run date: 2026-11-13

## Manual takeover

| Capability | Result | Evidence |
| --- | --- | --- |
| Start manual control and issue an ownership token | Pass | Real Arcana M4 test |
| Stream a live frame to the panel | Pass | Real Arcana M4 test |
| Forward mouse click | Pass | Real Arcana M4 test |
| Forward text and keyboard input | Pass | Real Arcana M4 test |
| Forward scroll input | Pass | Real Arcana M4 test |
| Click-to-annotate selector, role, name and rectangle | Pass | Real Arcana M4 test |
| Hand back control and preserve page state | Pass | Real Arcana M4 test |
| Native panel takeover and Done flow | Pass | `BrowserToolTests`: 25/25 |
| Open rejected pages in the OS default browser | Pass | `BrowserToolTests` fallback coverage; `OpenUrl` uses shell default handling |

## Credential-free sign-in spikes

The opt-in spike harness only navigates and reads the resulting page. It never
types a credential, submits a form, solves a challenge, or stores a session.

| Class | Target | Arcana result | M4 decision |
| --- | --- | --- | --- |
| Bank-style | `https://www.chase.com/` | Loaded; password surface detected | Handoff required before credentials |
| CAPTCHA | `https://www.google.com/recaptcha/api2/demo` | Loaded; human-verification surface detected | Handoff required |
| SaaS | `https://github.com/login` | Loaded; password surface detected | Handoff required before credentials |

Command used:

```powershell
$env:MANA_ARCANA_TEST_REAL='1'
$env:MANA_ARCANA_SIGNIN_SPIKES='1'
node --test plugins\browser-automation\test\arcana-real-engine.test.js
```

The three pages loaded in Arcana during the spike. Arcana is therefore usable
for reaching and reading the sign-in pages, but none of these credential or
human-verification steps is delegated to the agent. The panel's manual route
is the supported path; if a site rejects Arcana, the native fallback opens the
OS default browser.

## Exit assessment

M4's ordinary-page manual-help requirement is met. The sign-in spike result is
explicit: all three classes require user handoff for the sensitive step, while
Arcana remains usable for navigation up to that boundary.

M3 is also complete: live screencast frames, approval-visible activity, and
one-shot annotation pinning are covered by the activity/route tests and the real
Arcana manual-control test.
