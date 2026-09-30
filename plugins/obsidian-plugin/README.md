# Mana Memory Sync (Obsidian plugin)

Pulls Mana's memory summary and entity notes into your vault as linked notes, so Obsidian's own
graph view clusters them by what they're actually about instead of one flat blob.

**Facts are not this plugin's job any more.** Mana syncs her vault herself when `MANA_VAULT_DIR`
is set in `node-bot/.env` (#935):

- `Facts/` holds one note per remembered fact, both ways and automatically.
- `Views/` holds the read-only summary, mood and entity notes.
- `Journal/` holds her diary.

On the machine Mana runs on, you don't need the sync button. The plugin is still useful for a vault
Mana can't write to directly, such as one on another machine that reaches Mana over the network.

It never writes facts, and it refuses to write into `Facts/`, `Views/` or `Journal/`, so it
never fights Mana over the same files.

- `GET /api/memory` → a single summary note (default `Mana Memory.md`), without the Key Facts
  section.
- `GET /api/memory/notes` → one note per cross-session entity Mana has tracked, each linking
  to every other entity it co-occurred with in the same conversation, plus a Connections note
  (default folder `Mana/`). The Key Facts note is skipped.

See [docs/API_KEYS.md](../docs/API_KEYS.md) for the server side.

## Install (manual, not yet on the community store)

1. `npm install && npm run build` in this folder — produces `main.js`.
2. Copy `manifest.json` and `main.js` into `<your vault>/.obsidian/plugins/mana-memory-sync/`.
3. Enable "Mana Memory Sync" in Obsidian's Community Plugins settings.
4. Open the plugin's settings tab and set your Mana server URL and API key (from `node-bot/data/auth/SETUP.txt` or the admin dashboard).

## Use

Click the brain-circuit ribbon icon, or run the "Sync Mana memory" command. It overwrites the
summary note and every note in the notes folder with Mana's current memory. Notes for
entities Mana no longer tracks aren't deleted automatically (only overwritten in place).

If you switched to Mana's own vault sync, the plugin's old output (`Mana Memory.md` and the
`Mana/` folder) duplicates `Views/`. You can delete it and disable the plugin.

## Dev

```bash
npm install
npm run dev    # esbuild watch build
npm test       # pure-logic tests, no Obsidian runtime needed
```
