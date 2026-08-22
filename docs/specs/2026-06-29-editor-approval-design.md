# Editor Approval Design

## Goal

Mana should be able to read and write project files for editor workflows, but writes must require explicit user approval through Mana's local backend API. The approval flow must be shared by Zed, VS Code, and future editor integrations.

## Scope

This design covers the first shared approval slice:

- Keep file inspection local to the active workspace.
- Keep file reads explicit and bounded.
- Create reviewable edit proposals without writing files.
- Add a local `/approve` backend endpoint that applies a pending proposal only after approval.
- Reject writes when the target file has changed since the proposal was created.
- Update Zed External Agent documentation and capability metadata to describe approval-required writes.

This slice does not add autonomous repository-wide file reading, background edits, automatic PR creation, or cloud sync. Mana remains local-first, and the Zed External Agent continues to use local AI by default.

## Architecture

The existing `node-bot/zed-integration.js` module remains the shared editor integration layer. Despite the filename, it already owns generic editor behavior for Zed and VS Code: editor launch, active workspace tracking, bounded workspace inspection, and edit proposal storage.

The approval behavior should be added to this shared module rather than the Zed ACP process. That keeps the safety boundary editor-independent:

- Zed ACP can create or reference proposals through the shared backend flow.
- VS Code integration can call the same approval endpoint through the shared backend flow.
- Any future editor adapter gets the same conflict checks and workspace containment rules.

`node-bot/server.js` exposes the local HTTP route. The route delegates to the shared editor integration object and does not perform file writes directly.

## Components

### Edit Proposal Store

Existing proposals contain:

- `id`
- `status`
- `relativePath`
- `summary`
- `originalContent`
- `proposedContent`
- `diff`
- `createdAt`

The approval slice adds an apply operation that updates proposals with:

- `status: "applied"` on success
- `appliedAt` ISO timestamp on success

If the current file no longer matches `originalContent`, the apply operation throws a conflict error and does not write. The proposal should remain pending so the user can review or replace it.

### Editor Integration API

Add a shared method:

```js
approveEditProposal(id)
```

The method should:

1. Require an active workspace.
2. Load the proposal by id.
3. Reject non-pending proposals.
4. Resolve `proposal.relativePath` inside the active workspace.
5. Confirm the target file still exists and is a file.
6. Read the current file as UTF-8.
7. Compare current content exactly with `proposal.originalContent`.
8. Write `proposal.proposedContent` only when the comparison matches.
9. Mark the proposal applied and return the updated proposal.

### Backend Route

Add:

```http
POST /editors/workspace/proposals/:id/approve
```

Success response:

```json
{
  "proposal": {
    "id": "proposal-1",
    "status": "applied",
    "relativePath": "src/app.js",
    "summary": "Update app behavior",
    "originalContent": "...",
    "proposedContent": "...",
    "diff": "...",
    "createdAt": "2026-06-29T00:00:00.000Z",
    "appliedAt": "2026-06-29T00:01:00.000Z"
  }
}
```

Failure response should match the existing proposal route style:

```json
{
  "proposal": null,
  "error": "edit proposal conflict: current file content changed"
}
```

Conflict or invalid requests should not modify files.

## Data Flow

1. A user sets or opens an active workspace through Mana's editor routes.
2. Mana reads a requested file through the explicit workspace read route.
3. Mana creates an edit proposal through `POST /editors/workspace/proposals`.
4. The user reviews the proposal diff.
5. The user approves by calling `POST /editors/workspace/proposals/:id/approve`.
6. Mana verifies the file still matches the proposal's original snapshot.
7. Mana writes the proposed content and marks the proposal applied.

## Error Handling

The implementation should preserve these failure modes:

- No active workspace: return an error and do not write.
- Proposal not found: return an error and do not write.
- Proposal already applied: return an error and do not write.
- Target path escapes workspace: return an error and do not write.
- Target file missing or not a file: return an error and do not write.
- Current file content differs from `originalContent`: return a conflict error and do not write.

## Testing

Use Node's built-in test runner and the existing focused editor tests.

Add tests for:

- `approveEditProposal` writes proposed content only after explicit approval.
- `approveEditProposal` marks the proposal as applied with `appliedAt`.
- `approveEditProposal` rejects a changed file and preserves the current file.
- `approveEditProposal` rejects an already applied proposal.
- `POST /editors/workspace/proposals/:id/approve` applies a proposal through the backend route.
- `POST /editors/workspace/proposals/:id/approve` returns an error for a missing proposal.

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\zed-integration.test.js test\mana-acp-agent.test.js
node --check zed-integration.js
node --check server.js
node --check mana-acp-agent.js
```

Before pushing or merging, also run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval
git status --short --branch
```

## Documentation

Update `docs/zed_external_agent.md` so it no longer says edits are proposal-only without an apply action. It should say:

- Reads are explicit and bounded through local workspace routes.
- Writes require reviewable proposals.
- Proposals are applied only through the local `/approve` endpoint.
- The approval endpoint verifies that file content has not changed since the proposal was created.

Update ACP capability metadata from `write: "proposal-only"` to `write: "approval-required"` so Zed-facing metadata matches the backend behavior.
