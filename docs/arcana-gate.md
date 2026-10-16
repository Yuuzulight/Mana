# Arcana gate: real jobs on real sites before the week starts

`tools/arcana-gate.js` runs jobs through Mana's browser plugin (the code her tools call) on Arcana, each with a
fresh browser. The jobs are in `tools/arcana-gate-jobs.js`: open pages, follow links, search, tick boxes, choose
from dropdowns, press keys, hover menus, scroll pages that load more, drag, download, work in two tabs, read the
console, test a page at phone size, click by screen position, and refuse to type on a login page. Every browser
action Mana has is named by at least one job, and the report says which ones no passing job reaches.

- A job passes when the page shows it worked. A bot wall, a slow page that times out, or a missing control is a
  fail: a gate that excuses failures proves nothing.
- `node tools/arcana-gate.js` runs everything; `ARCANA_GATE_ONLY=wikipedia` runs the jobs whose site or name
  contains the text (a partial run is never a gate result).
- Results go to `node-bot/data/arcana-gate`: `gate.jsonl` (a line per job) and `gate-report.md`.
- A job marked `tracked` runs and is printed every time but is not counted: a site that stops Edge too, or a
  gap in the engine that is written up. Today that is YouTube alone (its app element is created but never
  finishes starting).
- Frames, framesets, a file upload and a drag are tested on a small local site (`tools/arcana-fixture-site.js`),
  not on someone else's page. The same site backs the real-engine test in CI.
- `node tools/arcana-gate-streak.js --runs 5 --then "<command>"` runs the gate until it has passed that many
  full runs in a row, keeps the PC awake meanwhile, and then runs the command (the weekly soak is registered
  that way). One failure resets the count and stops.

## What the engine leaves out, and how the plugin covers it

Arcana's engine has no layout or scrolling to speak of, and some DOM is missing; the bigger gaps (child frames, file uploads) are fixed in the engine itself, as patches Arcana applies when it builds it (Arcana `docs/engine-patches.md`). `plugins/browser-automation/arcana-dom-shim.js`
is injected into every Arcana page and fills in: the table API; the box of an inline link; `<option>`; jQuery's own
selectors throwing as they do in a browser; stepping number and range inputs with the arrow keys; a scroll offset
the page can read; and inline display for custom elements. The plugin turns an attachment response into a
download, runs drags inside the page, and clicks the element itself when it is below the first screen.
