# Mana Memory Sync (Obsidian plugin)

Pulls Mana's consolidated memory (`GET /api/memory`, see [docs/API_KEYS.md](../docs/API_KEYS.md)) into a note in your vault.

## Install (manual, not yet on the community store)

1. `npm install && npm run build` in this folder — produces `main.js`.
2. Copy `manifest.json` and `main.js` into `<your vault>/.obsidian/plugins/mana-memory-sync/`.
3. Enable "Mana Memory Sync" in Obsidian's Community Plugins settings.
4. Open the plugin's settings tab and set your Mana server URL and API key (from `node-bot/data/auth/SETUP.txt` or the admin dashboard).

## Use

Click the brain-circuit ribbon icon, or run the "Sync Mana memory" command — overwrites the configured note (default `Mana Memory.md`) with Mana's current memory markdown.

## Dev

```bash
npm install
npm run dev    # esbuild watch build
npm test       # pure-logic tests, no Obsidian runtime needed
```
