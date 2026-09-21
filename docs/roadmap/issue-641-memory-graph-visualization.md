# Issue 641: Add A Memory-Graph Visualization View

## Goal

Give the user a visual way to see what Mana's memory system has actually
learned about them, instead of it being entirely invisible/internal.

## Why

Hermes Desktop's `/journey` command (aliases `/learning`, `/memory-graph`)
opens an interactive, zoomable node graph of everything the agent has
learned — skills and memories laid out with a timeline, filterable by
All/Used/Learned, with a share control that exports the map layout
without exposing memory text.

Mana's underlying memory system is arguably richer than what a straight
port would need: `node-bot/memory-graph.js`'s Hebbian association graph
(entity co-occurrence, scalar edge weights), `node-bot/entity-ontology.js`'s
typed entity classification (8 categories), and
`node-bot/acp-memory-store.js`'s bi-temporal fact store
(`validFrom`/`invalidatedAt`, supersede history). None of it has any
visual representation anywhere — a user has no way to see what Mana
actually remembers about them short of reading raw data files.

## Proposed Scope

- A read-only visual explorer (Electron renderer and/or native launcher)
  rendering `memory-graph.js`'s association edges as a node graph,
  filterable by recency/weight.
- Overlay typed entities from `entity-ontology.js` (person/place/object/
  etc.) as node categories or colors.
- Surface currently-valid facts from `acp-memory-store.js`, with
  superseded facts (per issue #431's validity windows) visible on a
  timeline rather than hidden.
- Not in scope: editing memory from this view (read-only first version),
  or porting Hermes' specific rendering tech.

## Acceptance Criteria

- A user can open a memory-graph view and see real nodes/edges/facts
  pulled from their own Mana instance, not mock data.
- The view distinguishes association strength (Hebbian weight), entity
  type, and fact validity as at least three visually distinct signals.
- No memory-writing capability added in this issue — view only.

## Related

`docs/roadmap/hermes-desktop-eval-2026-09.md`.
