# Zed Integration Roadmap

Status: Done for current planned slices

## Completed

- Issue #22, PR #23: Added local editor CLI integration for Zed and VS Code.
- Issue #24, PR #25: Added Mana as a Zed External Agent entry point.

## Current Capabilities

- Detects configured Zed and VS Code commands.
- Opens files, folders, and line/column targets through safe process launch.
- Tracks active editor workspace paths locally.
- Exposes bounded, explicit read-only workspace inspection routes.
- Creates reviewable edit proposals instead of silently changing files.
- Provides `node-bot/mana-acp-agent.js` for Zed `agent_servers` configuration.
- Keeps the External Agent path local-first by default.

## Follow-Up

- Future apply-edit behavior should require a clear user-triggered command and content verification.
- Any deeper Zed context integration should build on the existing proposal-only safety model.
