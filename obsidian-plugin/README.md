# Mana Memory Sync (Obsidian plugin)

Pulls Mana's memory into your vault as linked notes, so Obsidian's own graph view clusters
them by what they're actually about instead of one flat blob.

- `GET /api/memory` → a single summary note (default `Mana Memory.md`).
- `GET /api/memory/notes` → one note per cross-session entity Mana has tracked, each linking
  to every other entity it co-occurred with in the same conversation, plus a Key Facts note
  and a Connections note (default folder `Mana/`).

See [docs/API_KEYS.md](../docs/API_KEYS.md) for the server side.

## Install (manual, not yet on the community store)

1. `npm install && npm run build` in this folder — produces `main.js`.
2. Copy `manifest.json` and `main.js` into `<your vault>/.obsidian/plugins/mana-memory-sync/`.
3. Enable "Mana Memory Sync" in Obsidian's Community Plugins settings.
4. Open the plugin's settings tab and set your Mana server URL and API key (from `node-bot/data/auth/SETUP.txt` or the admin dashboard).

## Use

Click the brain-circuit ribbon icon, or run the "Sync Mana memory" command — overwrites the
summary note and every note in the notes folder with Mana's current memory. Notes for
entities Mana no longer tracks aren't deleted automatically (only overwritten in place).

## Dev

```bash
npm install
npm run dev    # esbuild watch build
npm test       # pure-logic tests, no Obsidian runtime needed
```
