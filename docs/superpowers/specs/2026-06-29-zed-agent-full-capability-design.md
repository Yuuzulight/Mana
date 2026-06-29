# Zed Agent Full Capability Design

## Goal

Make Mana's Zed External Agent capable of local coding workflows: workspace inspection, bounded file reads, reviewable edits, optional autonomous edit/test loops, and registry-ready packaging metadata.

## Scope

- Keep Mana local-only by default.
- Add ACP-facing workspace tools backed by Mana's existing local backend editor APIs.
- Add an explicit autonomous mode for multi-step coding loops that can inspect files, create/apply edit proposals, run allowed tests, and iterate without per-step approval.
- Add guardrails for autonomous mode so it cannot silently operate outside the chosen workspace or run arbitrary destructive commands.
- Add registry-ready packaging metadata and docs for Zed ACP discovery/submission.
- Preserve the current custom `agent_servers` setup path.

This feature targets parity-oriented local coding workflows. It will not claim identical behavior to commercial terminal agents because Zed ACP integrations, model quality, and runtime features differ by implementation.

## Operating Modes

### Manual Mode

Manual mode is the default.

- `MANA_AGENT_AUTONOMOUS` is unset or `0`.
- Mana can answer prompts through the local backend coding profile.
- Mana can list files, read bounded files, and create edit proposals.
- Mana cannot approve proposals or run tests automatically from ACP.
- Writes still require explicit approval through the backend approval route.

### Autonomous Mode

Autonomous mode is explicit.

- Enabled only when `MANA_AGENT_AUTONOMOUS=1`.
- Still local-only unless a separate future override is designed.
- Can perform a bounded loop:
  1. inspect workspace
  2. read selected files
  3. ask the local coding model for the next action
  4. create edit proposals
  5. approve proposals through the backend
  6. run allowed test commands
  7. repeat until success, failure, or limit

Autonomous mode does not remove safety boundaries. It removes per-step approval only inside an explicitly configured local workspace and within command/file limits.

## Guardrails

Autonomous mode must enforce:

- Workspace required: no autonomous loop runs without an active workspace.
- Workspace confinement: all file paths must resolve inside the active workspace.
- Iteration limit: default `3`, configurable through `MANA_AGENT_MAX_ITERATIONS`.
- File-change limit: default `5`, configurable through `MANA_AGENT_MAX_FILES_CHANGED`.
- Command allowlist: default allowed commands are `npm test`, `npm run test`, `node --test`, and `node --check`.
- Timeout: default command timeout is `120000` ms.
- No shell metacharacter expansion for test commands. Commands are parsed into executable plus args and spawned without shell.
- No destructive commands such as delete, move, reset, checkout, clean, format-disk, or recursive removal.
- All applied edits go through the existing proposal conflict check before writing.

If any guardrail fails, the agent returns a structured error and stops the autonomous loop.

## ACP Surface

Mana will continue to support:

- `initialize`
- `session/new`
- `session/create`
- `session/prompt`
- `prompt`
- `shutdown`

Add Mana-specific JSON-RPC methods:

- `mana/workspace/status`
- `mana/workspace/set`
- `mana/workspace/files`
- `mana/workspace/read`
- `mana/edit/propose`
- `mana/edit/list`
- `mana/edit/get`
- `mana/edit/approve`
- `mana/test/run`
- `mana/agent/run`

These method names are intentionally namespaced so they do not pretend to be standard ACP methods.

## Backend Bridge

Add a focused backend bridge used by the ACP agent.

Responsibilities:

- Normalize `MANA_BACKEND_URL`.
- Call existing backend endpoints:
  - `GET /editors/workspace`
  - `POST /editors/workspace`
  - `GET /editors/workspace/files`
  - `GET /editors/workspace/file`
  - `POST /editors/workspace/proposals`
  - `GET /editors/workspace/proposals`
  - `GET /editors/workspace/proposals/:id`
  - `POST /editors/workspace/proposals/:id/approve`
  - `POST /reply`
- Convert HTTP failures into clear ACP errors.

Test execution should not go through the backend. It should run locally in the ACP process using a command runner that enforces the guardrails above.

## Autonomous Loop

Add a small local loop module instead of embedding loop state in `mana-acp-agent.js`.

Inputs:

- user objective
- workspace path
- max iterations
- allowed commands
- backend bridge
- test runner

Outputs:

- final status: `completed`, `stopped`, or `failed`
- iteration count
- files changed
- proposals applied
- test runs and results
- final text summary

The first implementation can use a conservative action protocol:

- ask the local model for a textual plan and next command/edit intent
- require edits to be submitted as full proposed file content through `mana/edit/propose`
- approve proposals only when autonomous mode is enabled and limits allow it
- run tests only through `mana/test/run`

If the local model does not return a machine-parseable next action, the loop stops and returns the model's text as a summary. This avoids brittle or unsafe guessing.

## Registry Packaging

Add repository metadata/docs for Zed ACP packaging:

- a registry manifest candidate under `zed-agent/mana-agent.json`
- setup docs explaining both custom `agent_servers` and registry-style packaging
- version, command, args, environment defaults, local-only note, capabilities, and homepage/repo fields

Publishing to a public registry may require a Zed-side submission process, so this slice prepares the package metadata and docs inside Mana but does not claim external publication.

## Documentation

Update `docs/zed_external_agent.md`:

- replace “Current Limits” with current capabilities and explicit autonomous-mode setup.
- document manual mode.
- document autonomous mode environment variables.
- document guardrails.
- document registry packaging status.

Add a roadmap issue note for this feature.

## Testing

Use TDD for implementation.

Test areas:

- ACP initialize reports manual/autonomous capabilities accurately.
- Mana-specific workspace/edit/test methods call the backend bridge correctly.
- Backend bridge normalizes URLs and reports HTTP failures clearly.
- Autonomous mode is disabled by default.
- Autonomous loop refuses to run without a workspace.
- Autonomous loop enforces iteration, changed-file, command, and timeout guardrails.
- Test runner accepts allowed commands and rejects destructive/disallowed commands.
- Proposal approval in autonomous mode still uses the backend approval endpoint.
- Stdio framing still works.
- Registry manifest is valid JSON and references the local ACP command.

Run focused ACP/editor tests, syntax checks, full backend tests, and the forbidden-reference scan before merging.

## Out Of Scope

- Remote AI enablement.
- Bypassing proposal conflict checks.
- Silent writes in manual mode.
- Publishing to an external registry service from this repository.
- Guaranteeing identical behavior to any other commercial terminal agent.
