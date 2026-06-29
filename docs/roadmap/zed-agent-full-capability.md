# Zed Agent Full Capability

## Goal

Make Mana's Zed External Agent capable of local coding workflows with workspace tools, approval-backed edits, explicit autonomous edit/test loops, and registry-ready ACP metadata.

## Implementation Notes

- Added ACP backend bridge helpers for local backend editor and reply APIs.
- Added active workspace plus outside-path allowlist guardrails.
- Added a guarded test runner for allowlisted test commands.
- Added an explicit autonomous coding loop.
- Added Mana-specific ACP methods for workspace, edit, test, and autonomous agent operations.
- Added registry-ready metadata under `zed-agent/`.

## Verification

- `node --test test\mana-acp-agent.test.js test\acp-backend-bridge.test.js test\acp-path-guard.test.js test\acp-test-runner.test.js test\acp-autonomous-loop.test.js test\zed-agent-package.test.js`
- `node --check mana-acp-agent.js`
- `node --check acp-backend-bridge.js`
- `node --check acp-path-guard.js`
- `node --check acp-test-runner.js`
- `node --check acp-autonomous-loop.js`
- `npm test`
- Forbidden external-project reference scan.
