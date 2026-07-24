# First-Run Setup Wizard (desktop-client)

A guided on-ramp for someone who just installed Mana with no prior setup --
no terminal, no docs required to get a working local model and voice
transcription. See [issue #123](https://github.com/Yuuzulight/Mana/issues/123).

## What it checks

- **Local AI model** -- via `GET /models/status`, using the same
  hardware-aware recommendation (issue #46) and GGUF auto-detection
  already used everywhere else in the app. If the recommended profile's
  model isn't found, the wizard names the exact filename(s) to download
  and says to drop them under `tools/llama/`.
- **Whisper (voice transcription)** -- via `GET /doctor`'s `whisper-config`
  check. Previously `WHISPER_MODEL` had no auto-detection at all (unlike
  everything else -- `LLAMA_BIN`, `LLAMA_MODEL`, and even `WHISPER_BIN`
  already scanned `tools/`), so this was fixed as part of the same work
  (see `node-bot/whisper-discovery.js`): both the binary and the model are
  now auto-detected under `tools/whisper/`, the wizard just surfaces
  whatever's true.
- **Desktop avatar (optional)** -- a "Fetch a free default avatar" button
  runs the same script as `npm run fetch-sample-avatar` (issue #123 doesn't
  require this one; it's a nice-to-have shown alongside the required two).

## When it shows

Not a one-time "seen it" flag -- the wizard shows whenever the model or
Whisper checks aren't both passing, and stays out of the way once they are.
Dismissing ("Remind Me Later") just closes it for the current session; it's
evaluated fresh on every launch and after every "Recheck" click.

## Why no separate config system

Every value the wizard cares about already had (or, for `WHISPER_MODEL`,
now has) real auto-detection based on where files actually sit on disk --
`tools/llama/`, `tools/whisper/`. So the wizard doesn't write any config of
its own; it's purely a friendlier view onto detection that already exists,
with guidance on exactly what file to fetch and where to put it. Dropping a
correctly-named file in the right folder and clicking Recheck is the whole
flow, no restart required.
