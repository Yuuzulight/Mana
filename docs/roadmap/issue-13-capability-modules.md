# Issue 13: Introduce Mana Capability Module Boundaries

## Goal

Create a simple internal module pattern so optional capabilities can be added without growing the main server file.

## Proposed Scope

- Define a small capability shape with route registration and status reporting.
- Apply the pattern first to one or two existing capabilities.
- Keep the pattern simple and internal to Mana.
- Avoid a full plugin system unless a later issue proves it is needed.

## Acceptance Criteria

- Capabilities can register routes through a consistent function.
- Capabilities can contribute health/status information.
- The pattern is documented in Mana terms.
- No external project names or references are added.
