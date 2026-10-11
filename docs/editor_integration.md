# Editor integration

Mana can hand coding work to a local editor, Zed (the default) or VS Code. The integration runs in the local backend (`node-bot`), so any launcher that talks to it can use it.

- **windows-native-launcher**: reviews edit proposals and snapshots. Opening a project or file in Zed or VS Code from the launcher is a future integration.
- **windows-launcher** (Electron, retired): reviews edit proposals and snapshots.

Mana doesn't silently inspect or change code through this integration. File lists and reads need an explicit endpoint call, and edit proposals stay in memory for review instead of being written to disk.

## Setup

```powershell
$env:ZED_BIN = "C:\Program Files\Zed\zed.exe"
$env:VSCODE_BIN = "C:\Users\User\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"
$env:MANA_DEFAULT_EDITOR = "zed"
```

If `ZED_BIN` is unset, Mana checks for `zed` on `PATH`. If `VSCODE_BIN` is unset, Mana checks for `code` on `PATH`.

| Variable | Purpose |
|---|---|
| `ZED_BIN` | Path to the Zed CLI |
| `VSCODE_BIN` | Path to the VS Code CLI |
| `MANA_DEFAULT_EDITOR` | Default editor when a request doesn't name one (`zed` or `code`) |

## Behavior

- `GET /editors/status` reports Zed and VS Code CLI availability.
- `POST /editors/open` opens an existing file or folder in the requested editor. If no editor is named, Mana uses `MANA_DEFAULT_EDITOR`, falling back to Zed.
- `GET /editors/workspace` reports the active local workspace Mana last opened or was told to use.
- `POST /editors/workspace` sets the active workspace explicitly.
- `GET /editors/workspace/files` lists files in the active workspace, skipping heavy folders.
- `GET /editors/workspace/file?path=...` reads one bounded text file inside the workspace.
- `POST /editors/workspace/proposals` creates an in-memory edit proposal for review without writing the file.
- `GET /editors/workspace/proposals` and `GET /editors/workspace/proposals/:id` review pending proposals.
- `GET /editors/workspace/snapshots` lists snapshots, and their restore route brings an earlier state back.
- `GET /zed/status` and `POST /zed/open` remain as Zed-specific compatibility routes.
- An optional `line` and `column` are passed to the editor as `file:line:column`.

Coding replies still use the local coding model profile unless remote AI is explicitly enabled.

## Zed External Agent

`node-bot\mana-acp-agent.js --acp` is a protocol-generic [Agent Client Protocol](https://agentclientprotocol.com) agent that any ACP client can launch over stdio: Zed's `agent_servers` today, and other editors' ACP clients as they gain one. See [zed_external_agent.md](zed_external_agent.md) for the Zed setup steps.
