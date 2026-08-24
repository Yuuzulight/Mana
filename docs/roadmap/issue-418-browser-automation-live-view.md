# Issue 418: Live View For Browser Automation

## Goal

Show what the automated browser is doing while a task runs, instead of
only returning the final extracted text.

## Why

Inspired by Open-LLM-VTuber's v1.2 BrowserBase MCP integration, which
streams a live view to the frontend as the browser acts. Mana's
`plugins/browser-automation/browser-automation.js` (#150) currently acts
like a black box until it finishes -- out of step with Mana's "propose,
don't silently act" philosophy elsewhere (editor handoff, approval gate).
See `docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Stream periodic screenshots, or at minimum a lightweight action log
  ("clicked X", "typed into Y", "navigated to Z"), from the plugin to the
  launcher UI while a browser-automation task runs.
- Keep the final text-extraction result and existing approval flow
  unchanged -- this adds visibility during the run, not a new gate.

## Acceptance Criteria

- The launcher UI shows some live indication of browser-automation
  progress while a task is running, not just a final result.
- No regression to existing browser-automation behavior when the feature
  is unused or the UI surface isn't open.
