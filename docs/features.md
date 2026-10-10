# Features

The rest of what Mana does, beyond the [highlights](../README.md#highlights).

- **Neural voice-activity detection**: the launcher's continuous-listening loop uses Silero VAD to detect speech and silence, with a fallback to RMS-threshold detection if the model isn't available.
- **Local text generation**: replies come from GGUF models through `llama.cpp`. See [Model Stack](../README.md#model-stack).
- **Local image understanding**: with a vision GGUF installed, Mana can look at screenshots and images and talk about them. See [vision_setup.md](vision_setup.md).
- **Translate the screen**: ask "translate my screen" or "what did that JP player say?", or press `Ctrl+Alt+Shift+J`, and Mana reads the Japanese in the window in front with Windows OCR and translates it. This needs the Windows Japanese OCR language pack; without it, she falls back to the vision model.
- **Gaming mode**: Mana reduces idle work while watched games are running.
- **Game-aware help**: while a game with a known wiki is running or in front, Mana answers questions from that game's wiki through local SearXNG. The lookup waits 5 seconds at most. Add or change games in `node-bot/data/game-wikis.json`.
- **Mobile and remote companion**: phone chat and summary sync over the local backend and an optional tunnel, plus opt-in Telegram and Discord bridges (DM pairing-code approval, Discord voice channels with per-speaker transcription and barge-in).
- **FFXIV, market and job-search helpers**: Universalis crafting and market data, Alpha Vantage stock summaries, and live Adzuna job postings when configured, plus a local job-application tracker with resume and cover-letter tailoring. These are optional plugins; see [plugins/README.md](../plugins/README.md).
- **MCP server (opt-in)**: Mana can expose its FFXIV market and web-access tools over the Model Context Protocol, for local MCP clients such as Claude Desktop or Claude Code. See [issue-42-mcp-support.md](roadmap/issue-42-mcp-support.md).
- **Deep Research**: a "Research" button runs a bounded, multi-source search-and-read pass and replies with a cited report. See [issue-47-deep-research.md](roadmap/issue-47-deep-research.md).
- **Better replies over time**: idle-triggered Dream Mode consolidates recent memory, Best-of-N self-voting picks the strongest of several candidate replies, and conversational-rut and formulaic-phrasing detection keep replies from going stale.
- **Procedural memory (skills)**: a `node-bot/skills/` store holds "how I did X last time" knowledge as small, readable files, loaded only when relevant.
- **Renderable artifacts**: HTML or long Markdown in a reply renders inline, with a standalone viewer window for a closer look.
- **Session trajectory export**: any session's full turn history, including tool calls, exports as ShareGPT-style JSONL.
- **Obsidian plugin**: Mana Memory Sync pulls Mana's memory into an Obsidian vault as linked notes. See [plugins/obsidian-plugin/README.md](../plugins/obsidian-plugin/README.md).
