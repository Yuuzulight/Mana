# Mana Soft Restart Design

## Goal

Mana should be able to reload backend code changes without requiring the user to close and reopen the desktop launcher, Zed, or the terminal manually.

The first implementation should support both:

- A chat command such as `/restart`, `/soft-restart`, or `soft restart Mana`.
- A PowerShell/npm fallback command such as `npm run restart`.

This is a soft backend restart. The Electron launcher, avatar window, TTS services, and external tools remain open unless a later full-restart feature explicitly adds broader lifecycle control.

## Recommended Approach

Use launcher-managed backend restart, with a lightweight CLI fallback.

Mana's backend exposes a local-only admin endpoint that requests an intentional shutdown:

```text
POST /admin/restart
```

When the backend is owned by the Windows launcher, the backend process exits after returning a success response. The launcher already tracks the backend child process; it will be extended to recognize an intentional restart exit and respawn `node-bot/server.js`.

When the backend is started directly from PowerShell through `npm run mana`, a small supervisor script owns `server.js` and respawns it after an intentional restart exit. `npm run restart` calls the same local endpoint from another terminal.

The lightweight fallback has two small scripts:

- `npm run mana`: starts the backend under a restart-aware Node supervisor.
- `npm run restart`: asks the running local backend to restart.

This does not replace the desktop launcher as the main daily supervisor. It gives the terminal path the same restart behavior when the launcher is not being used.

## User Commands

Chat commands:

- `/restart`
- `/soft-restart`
- `soft restart Mana`
- `restart Mana`

PowerShell:

```powershell
cd C:\ManaAI\Mana\node-bot
npm run restart
```

PowerShell supervisor fallback:

```powershell
cd C:\ManaAI\Mana\node-bot
npm run mana
```

## Safety

The restart endpoint is local-only:

- Accept loopback clients only: `127.0.0.1`, `::1`, and IPv4-mapped loopback.
- Reject requests coming through LAN, mobile, or Cloudflare tunnel paths.
- Do not expose restart behavior through mobile routes.

The endpoint should return before shutdown is scheduled so the caller receives a clear result.

## Data Flow

Chat command path:

1. User sends `/restart` or equivalent text.
2. `/reply` recognizes the restart command before model inference.
3. Backend returns a short restart acknowledgement.
4. Backend schedules shutdown after the HTTP response flushes.
5. Launcher sees the intentional backend exit and starts a fresh backend process.

PowerShell path:

1. User starts Mana with `npm run mana` when using the terminal-only flow.
2. User runs `npm run restart` from another terminal.
3. Script sends `POST http://127.0.0.1:5005/admin/restart`.
4. Script prints the response.
5. If the launcher or supervisor is running, it respawns the backend.

Launcher path:

1. Launcher starts `node-bot/server.js` as it does today.
2. Backend exits with a documented restart exit code.
3. Launcher respawns the backend after a short delay.
4. Normal unexpected exits still log and do not create an infinite restart loop.

## Error Handling

- If the restart endpoint is called from a non-loopback address, return `403`.
- If `npm run restart` cannot reach the backend, print that Mana is not currently running.
- If the launcher sees repeated restart exits too quickly, stop respawning and log the failure to avoid a tight crash loop.
- If shutdown fails, return a clear `500` response and keep serving.

## Testing

Add focused backend tests for:

- Loopback restart requests are accepted.
- Non-loopback restart requests are rejected.
- Chat restart commands bypass model generation and schedule restart.
- Normal prompts still call the model path.

Add launcher tests for:

- Intentional backend restart exits are respawned.
- Repeated fast restart exits are capped.
- Unexpected backend exits are not treated as restart requests.

Add CLI tests or direct helper tests for:

- Successful restart response formatting.
- Backend unavailable response formatting.
- Supervisor respawns only for the documented restart exit code.

## Out Of Scope

- Full Electron app restart.
- TTS service restart.
- Cloud/mobile restart control.
- Git pull, dependency install, or automatic update from GitHub.
- Hot module reload inside the existing Node process.
