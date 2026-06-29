# Zed External Agent Setup

Mana can be launched by Zed as a local External Agent through Zed's `agent_servers` settings.

This path is local-first. The agent entry point refuses remote AI when `MANA_ALLOW_REMOTE_AI=1` unless a future explicit override path is added for that launch mode. Code edits require reviewable proposals and explicit approval through Mana's local backend; the agent must not silently modify files.

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

## Current Capabilities

- Zed can launch Mana over stdio through `agent_servers`.
- Mana supports basic ACP lifecycle methods and Mana-specific workspace/edit/test methods.
- `session/prompt` uses the local backend reply endpoint with `modelProfile: "coding"`.
- Manual mode can inspect workspace files and create reviewable edit proposals.
- Autonomous mode can apply proposals and run allowed tests repeatedly after explicit opt-in.
- Writes still go through Mana's proposal conflict checks.

## Manual Mode

Manual mode is the default. Leave `MANA_AGENT_AUTONOMOUS` unset or set it to `0`.

In manual mode, Mana can list files, read bounded file content, and create edit proposals. It cannot run tests or approve proposals through ACP.

## Autonomous Mode

Set `MANA_AGENT_AUTONOMOUS=1` only when you want Mana to run a bounded local coding loop.

Optional controls:

- `MANA_AGENT_MAX_ITERATIONS`: default `3`.
- `MANA_AGENT_MAX_FILES_CHANGED`: default `5`.
- `MANA_AGENT_TEST_TIMEOUT_MS`: default `120000`.
- `MANA_AGENT_ALLOWED_PATHS`: absolute outside-workspace roots allowed for file access.

Autonomous mode can approve proposals and run allowed tests without per-step approval, but only inside the configured guardrails.

## Guardrails

- Local-only remains the default.
- Outside-workspace file access is denied unless the path is under `MANA_AGENT_ALLOWED_PATHS`.
- Test commands must be allowlisted.
- Destructive commands are rejected.
- Test commands run without shell expansion.
- Proposal approval still checks for file-content conflicts before writing.

## Registry Packaging

Mana includes registry-ready metadata at `zed-agent/mana-agent.json`. Public registry publication may require a separate Zed-side submission or review process.
