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

The service listens on this PC only (`MANA_BIND_HOST=127.0.0.1`), and every
backend route needs an admin key. A launcher's own per-run key only works
for a node-bot that launcher started, so a launcher using the service needs
`ADMIN_TOKEN`: set it in `node-bot/.env`, then the same value in the native
launcher's Settings > Admin token (or as `ADMIN_TOKEN` in the Electron
launchers' environment).

The native launcher finds a backend already running at
`http://127.0.0.1:5005` and uses it instead of starting its own.
`windows-launcher` starts its own node-bot for any loopback address
(`backend-config.js`'s `isLoopbackHostname`), so don't run it alongside the
service. `desktop-client` never spawns node-bot itself.

To reach the service from other devices, change `MANA_BIND_HOST` with
`nssm edit ManaNodeBot` -- but then every device on your network can reach
the backend, and anything with the key can make Mana reply and run tools.

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
