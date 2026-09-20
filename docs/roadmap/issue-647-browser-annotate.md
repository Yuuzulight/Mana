# Issue 647: Add An In-App Browser Preview With Click-To-Annotate

## Goal

Let a user point at something specific on a browsed page and attach a
note about it to their next message, instead of only describing it in
words.

## Why

Mana's `plugins/browser-automation/` is headless and API-driven
(`createBrowserSession({page})` with `navigate`/`click`/`type`/
`snapshot`/`screenshot`) — there's no in-app browser preview surface for
a human to interact with directly.

Hermes Desktop's in-app browser pane has an Annotate mode: click any
element (or drag a box) on the live page, type a note, and each saved
comment becomes a numbered pin. Saving comments never sends a turn by
itself — "Add N comments" attaches a cropped screenshot per pin to the
composer, and each comment carries its CSS selector, markup, and computed
layout styles so the agent can locate the element in source, not just see
a picture of it. Password/hidden field values are redacted from the page
markup before it leaves the browser.

This is a different capability than what `browser-automation` does today
(the agent driving the browser) — it's the user pointing something out to
the agent within a page Mana is already showing.

## Proposed Scope

- Add an in-app browser preview pane (if one doesn't already exist as
  part of the tool-rail/panel system) that can render a live page.
- Add click-to-annotate: click/drag-select an element, attach a text
  note, producing a numbered pin.
- On "attach," bundle a cropped screenshot per pin plus the element's
  selector/markup/computed-style data into the next composer turn.
- Redact password/hidden-field values from captured markup before it
  reaches the model, matching Hermes' approach.

## Acceptance Criteria

- A user can annotate a specific element on a rendered page and have
  that annotation (screenshot + selector/markup) reach the model in
  their next message.
- Password and hidden field values are confirmed redacted in captured
  markup.

## Related

`docs/roadmap/hermes-desktop-eval-2026-09.md`.
