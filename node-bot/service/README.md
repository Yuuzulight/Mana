# Running node-bot as a Windows service

By default, `windows-launcher` spawns `node-bot/server.js` as its own child
process (`main.js`'s `startWindowsServices()`). That ties node-bot's uptime
to whether `windows-launcher` happens to be open, and gives no auto-restart
if node-bot crashes.

This folder registers node-bot as a real Windows service via
[NSSM](https://nssm.cc/) instead: starts on boot, restarts on crash, no
terminal window needed. Docker Desktop was considered for this same
always-on goal and ruled out (Riot Vanguard refuses to run alongside its
WSL2-based virtualization) -- NSSM is a plain Windows service wrapper, no
virtualization involved, so it doesn't have that conflict.

## Setup

From an **elevated** (Run as administrator) PowerShell:

```powershell
cd node-bot\service
.\install-mana-service.ps1
```

Installs [NSSM](https://nssm.cc/) via Chocolatey if it isn't already
present, registers the `ManaNodeBot` service pointed at `node server.js`
with `node-bot` as its working directory, sets it to auto-start on boot and
restart on crash (3s delay), and points its stdout/stderr at
`node-bot/data/service-stdout.log` / `service-stderr.log`.

## The one thing you must also change

`windows-launcher` only skips spawning its own copy of node-bot when
Settings > Connection points somewhere it doesn't consider "loopback"
(`windows-launcher/backend-config.js`'s `isLoopbackHostname` -- only
`localhost`, `127.0.0.1`, and `::1` count). **Setting it to
`http://localhost:5005` does NOT work** -- that's still loopback, and
windows-launcher will spawn a second, redundant local node-bot on top of
the service. Use this machine's actual **LAN IP** instead, e.g.
`http://192.168.1.50:5005`.

`desktop-client` needs no change -- it never spawns node-bot itself; it
already assumes an externally-running backend.

## Why `USE_EMBEDDINGS=1` is set explicitly

`windows-launcher`'s own spawn call defaults `USE_EMBEDDINGS` to `"1"`, but
node-bot's own standalone default (`tools/retriever-index.js`) is **off**
unless explicitly set. Running the service without this would silently
lose semantic retrieval for session search and Deep Research, without any
visible error -- it'd just quietly degrade to keyword-only matching. The
install script sets this and the other launcher-supplied defaults
(`WHISPER_BIN`, `TTS_PROVIDER`, etc.) explicitly so the service behaves
identically to the launcher-spawned path.

## Checking on it

```powershell
cd node-bot\service
.\check-mana-service.ps1
```

One-shot health summary: `Get-Service ManaNodeBot` status, `/health`, and a
per-check `/doctor` summary -- without opening either Electron app. No
elevation needed (read-only). Exits non-zero if the service isn't running,
`/health` doesn't respond, or any `/doctor` check reports `fail` (a `warn`
alone doesn't fail it), so it's usable from a scheduled task, not just
interactively. Pass `-BaseUrl` if the service isn't on the default port
5005.

## Removing it

From an elevated PowerShell:

```powershell
cd node-bot\service
.\uninstall-mana-service.ps1
```

Stops and removes the service (leaves NSSM itself installed, since
Chocolatey manages it as a general-purpose tool). Remember to point
Settings > Connection back to `http://localhost:5005` afterward so
windows-launcher resumes spawning node-bot itself.
