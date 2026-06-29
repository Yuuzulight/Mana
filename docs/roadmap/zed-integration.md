# Zed Integration Roadmap

Status: Done for current planned slices

## Completed

- Issue #22, PR #23: Added local editor CLI integration for Zed and VS Code.
- Issue #24, PR #25: Added Mana as a Zed External Agent entry point.
- Shared approval flow merged on 2026-06-29: added `POST /editors/workspace/proposals/:id/approve` with content verification before writes.

## Current Capabilities

- Detects configured Zed and VS Code commands.
- Opens files, folders, and line/column targets through safe process launch.
- Tracks active editor workspace paths locally.
- Exposes bounded, explicit read-only workspace inspection routes.
- Creates reviewable edit proposals instead of silently changing files.
- Applies proposals only through the local backend approval route after verifying the file still matches the original proposal snapshot.
- Provides `node-bot/mana-acp-agent.js` for Zed `agent_servers` configuration.
- Keeps the External Agent path local-first by default.

## Follow-Up

- Any deeper Zed context integration should build on the existing approval-required safety model.
- Future editor integrations should reuse the same backend approval flow instead of adding editor-specific write paths.
