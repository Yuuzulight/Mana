# VTube Studio setup

Mana can control a VTube Studio avatar through the VTube Studio Public API.

The first supported control layer is hotkey based:
- Mana connects to VTube Studio over WebSocket.
- VTube Studio asks you to approve Mana as a plugin.
- Mana can list the hotkeys on the current avatar model.
- Mana can trigger hotkeys manually or after a reply.

## 1) Enable the VTube Studio API

1. Open VTube Studio.
2. Open settings.
3. Enable the VTube Studio Public API.
4. Keep the default API port unless you changed it.

The default Mana URL is:

```powershell
ws://127.0.0.1:8001
```

If you use a different port, set:

```powershell
$env:VTUBE_STUDIO_URL = "ws://127.0.0.1:YOUR_PORT"
```

## 2) Approve Mana as a plugin

Start Mana's backend, then run:

```powershell
Invoke-RestMethod -Method Post http://localhost:5005/vtube/auth
```

VTube Studio should show a plugin approval prompt for `Mana`.

Mana stores the plugin token at:

```text
node-bot/config/vtube-studio-token.json
```

Do not commit that token file.

## 3) Check connection status

```powershell
Invoke-RestMethod http://localhost:5005/vtube/status
```

## 4) List avatar hotkeys

```powershell
Invoke-RestMethod http://localhost:5005/vtube/hotkeys
```

Use the returned hotkey names or IDs to decide what Mana should trigger.

## 5) Trigger a hotkey manually

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"hotkeyName":"Smile"}' `
  http://localhost:5005/vtube/hotkey
```

## 6) Map Mana replies to avatar reactions

Set `VTUBE_STUDIO_REACTIONS_JSON` before starting Mana.

Example:

```powershell
$env:VTUBE_STUDIO_REACTIONS_JSON = '{"hello":"Wave","thanks":"Smile","default":"Idle"}'
```

How it works:
- keys are words or phrases to look for in Mana's reply
- values are VTube Studio hotkey names
- `default` runs when no other phrase matches

This gives Mana basic avatar control without tying the core voice loop to a specific model rig.

## Current limits

- This integration controls hotkeys only.
- It does not yet drive Live2D parameters directly.
- It does not yet animate mouth movement from generated audio.
- It depends on the currently loaded VTube Studio model having useful hotkeys configured.
