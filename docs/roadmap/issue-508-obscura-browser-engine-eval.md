# Issue 508: Evaluate Obscura As A Lighter Browser Engine

## Goal

Decide whether swapping the browser-automation plugin's engine from
Playwright+Chromium to Obscura is worth it, on measured resource savings
and correctness parity rather than the project's own claimed numbers.

## Why

`plugins/browser-automation/` (#150) drives a full headless Chromium
instance via Playwright today. h4ckf0r0day/obscura is a Rust-based
headless browser engine that's a drop-in replacement via the same CDP
protocol, claiming dramatically lower memory/binary size/startup time,
plus built-in anti-detection and native MCP support. Mana is a background
companion app designed to stay light (gaming-mode backoff, resource-
conscious throughout) -- a heavy Chromium footprint for occasional
automation tasks is exactly the kind of thing worth challenging if a
lighter engine does the same job through the same protocol.

## Proposed Scope

- Evaluation only, not a commitment to switch.
- Swap-test Obscura via its CDP server against Mana's existing
  `plugins/browser-automation/test/` suite for correctness parity.
- Measure real memory/startup/page-load numbers on Mana's own hardware,
  not the project's published benchmarks.
- Only proceed to an actual swap if correctness parity holds and the
  resource savings are real.

## Acceptance Criteria

- A documented comparison: correctness (existing test suite passes
  against Obscura), memory, startup time, page-load time, measured on
  Mana's own hardware.
- A clear build/don't-build recommendation.

## Related

#150
