# Web Access (Search, Wiki, and Page Reading)

Mana can search the web, look things up on Wikipedia, and read a specific
page you point her at — while staying local-first. Search runs through a
SearXNG instance on your own machine (a privacy-respecting meta-search
engine, no API key, nothing sent to a third-party search provider besides
the engines SearXNG itself queries). Wikipedia lookups and page reads talk
directly to the public internet (Wikipedia has no local option; reading a
page you name necessarily means fetching that page).

## Setup

`tools\searxng\` is git-ignored (it's a large Python venv), so set it up
once per machine:

```powershell
cd C:\ManaAI\Mana\tools
.\setup-searxng.ps1
```

This downloads SearXNG, creates a Python 3.11-3.13 venv, installs
dependencies, and copies in `tools\mana-searxng-settings.yml` (JSON output
enabled, rate limiter off, localhost-only, port 8890 — this file **is**
tracked in git, so it survives a fresh clone).

Nothing needs Docker — SearXNG normally recommends Docker, but Mana runs it
directly via its Python dev server for a single local user. The script also
installs one Windows compatibility shim
(`tools\searxng\venv\Lib\site-packages\pwd.py`) stubbing the POSIX-only
`pwd` module that SearXNG imports for a Linux-only log line she never hits
locally.

The launcher starts SearXNG automatically alongside the backend and TTS
services once it's set up. Set `MANA_START_SEARXNG=0` to skip that.

## How Mana decides what to do

Sent to the backend on every `/reply`, in this priority order:

1. **A URL in your message** → she fetches and reads that page (HTML only,
   3&nbsp;MB read cap, ~6000 characters handed to her prompt).
2. **"wiki"/"wikipedia" in your message** → Wikipedia summary lookup.
3. **Search phrasing** ("search for...", "look up...", "google...", "what's
   the latest news on...") → SearXNG web search, top 5 results.
4. Otherwise, no web context is added — ordinary chat doesn't touch the
   network.

Toggle the whole feature with `MANA_WEB_ACCESS_ENABLED=0`.

## API endpoints

- `POST /web/search` — `{ "query": "...", "limit": 5 }`
- `POST /web/read` — `{ "url": "https://..." }`
- `GET /wiki/:term`

## Safety

- **SSRF guard**: every URL Mana fetches (including redirect targets, hop by
  hop) is resolved and checked against loopback, RFC1918, and link-local
  ranges — including `169.254.169.254`, the common cloud metadata address.
  Private/internal targets are refused with a clear error instead of being
  fetched.
- **Content-type check**: only `text/html` pages are read; PDFs, binaries,
  etc. are rejected rather than dumped into her prompt as garbage.
- **Size caps**: page reads stop after 3&nbsp;MB downloaded and 6000
  characters handed to the model, so a huge page can't blow out her context.
- Search and page reads only run when your message asks for them (or names a
  URL) — Mana never browses on her own initiative.

## Troubleshooting

Run `npm run doctor` in `node-bot` — the `searxng` check reports whether
local search is reachable. Wiki lookups and page reads only need working
internet, not SearXNG, so they keep working even if SearXNG is down; only
the search feature depends on it.

To restart SearXNG by hand:

```powershell
cd C:\ManaAI\Mana\tools\searxng
$env:SEARXNG_SETTINGS_PATH = "C:\ManaAI\Mana\tools\searxng\mana-settings.yml"
.\venv\Scripts\python.exe -m searx.webapp
```
