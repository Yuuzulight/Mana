# Zed External Agent Setup

Mana can be launched by Zed as a local External Agent through Zed's `agent_servers` settings.

This path is local-first. The agent entry point refuses remote AI when `MANA_ALLOW_REMOTE_AI=1` unless a future explicit override path is added for that launch mode. Code edits are proposal-only in this first slice; the agent must not silently modify files.

## Zed Settings

Add this to your Zed settings, adjusting the path if Mana is installed somewhere else:

```json
{
  "agent_servers": {
    "mana": {
      "command": "node",
      "args": ["C:\\ManaAI\\Mana\\node-bot\\mana-acp-agent.js", "--acp"],
      "env": {
        "MANA_ALLOW_REMOTE_AI": "0",
        "MANA_DEFAULT_EDITOR": "zed"
      }
    }
  }
}
```

You can print the same snippet from the backend folder:

```powershell
cd C:\ManaAI\Mana\node-bot
node .\mana-acp-agent.js --print-zed-config
```

Start Mana's local backend before using the Zed External Agent:

```powershell
cd C:\ManaAI\Mana\node-bot
npm start
```

By default, the ACP process sends prompts to `http://127.0.0.1:5005/reply` with `modelProfile: "coding"`. Set `MANA_BACKEND_URL` in the Zed `env` block if your backend runs on a different local URL.

## Doctor Check

Run Doctor after configuring Zed:

```powershell
cd C:\ManaAI\Mana\node-bot
npm run doctor
```

The `Zed external agent` check verifies that `node-bot\mana-acp-agent.js` exists and that the launch policy is local-only.

The async Doctor run also checks `MANA_BACKEND_URL` or `http://127.0.0.1:5005` at `/health`. If that check warns, start `node-bot` before using the agent from Zed.

## Current Limits

- Zed can launch the Mana ACP entry point over stdio.
- The entry point supports basic JSON-RPC lifecycle messages.
- `session/prompt` uses the local backend reply endpoint with `modelProfile: "coding"` in standalone launch.
- The lower-level ACP agent can still use an injected local reply bridge for tests and future in-process wiring.
- File reads stay explicit and bounded through Mana's existing editor workspace routes.
- File edits remain reviewable proposals only; no apply action is exposed here.
