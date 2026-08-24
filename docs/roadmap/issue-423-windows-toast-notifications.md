# Issue 423: Native Windows Toast Notifications For Proactive Check-Ins

## Goal

Let Mana's proactive messages (Dream Mode insights, cron results, memory
staleness notes) reach the user without the launcher window open and
focused.

## Why

Mana's proactive surface today is chat + avatar only. Native Windows
toast notifications with action buttons let an app push low-friction,
actionable-or-dismissible messages without stealing focus. Electron
already exposes the needed notification APIs. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Use Electron's notification API to surface proactive Mana messages as
  native Windows toasts.
- Include action buttons where it makes sense (e.g. "open chat",
  "dismiss").
- Works whether the launcher window is focused, minimized, or in the
  background.

## Acceptance Criteria

- A Dream Mode insight, cron result, or staleness note can trigger a
  native Windows toast even when the launcher isn't focused.
- Toast action buttons work (open chat brings the launcher to front;
  dismiss clears it without side effects).
- No toast spam -- this shares whatever throttling/frequency judgment
  already governs proactive messages elsewhere in Mana.
