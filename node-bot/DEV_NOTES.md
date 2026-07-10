Development helper notes

1) Generating mobile auth (passcode + session secret)
- Run the provided node helper to create a passcode hash and session secret:
  cd node-bot
  node scripts/generate_mobile_auth.js  # or pass a passcode as an arg

- The script prints both PowerShell `setx` commands (to persist) and ` $env:...` assignments for the current session.

2) Quick dev environment setup (PowerShell)
- Use the helper to set conservative defaults and avoid heavy model runs during development:
  pwsh .\node-bot\scripts\setup-dev.ps1 -Passcode 2468 -AdminToken "your-admin-token"

- This sets SKIP_HEAVY_MODEL_TESTS=1 and disables advanced llama flags in the current shell. It does not persist across sessions; to persist, use the printed `setx` commands from the generator.

3) Check retriever health
- If the Doctor reports the retriever is unreachable, run:
  pwsh .\node-bot\scripts\check-retriever.ps1

4) Starting services
- Backend (node-bot):
  cd node-bot
  npm start

- Desktop (electron):
  cd desktop-client
  npm start

5) Enabling advanced llama options (only if your llama binary supports them)
- Example (PowerShell):
  $env:LLAMA_ENABLE_FLASHATTN = '1'
  $env:LLAMA_ARG_FLASH_ATTN = 'auto'
  $env:LLAMA_KV_COMPRESS = 'q4_0'
  $env:LLAMA_ENABLE_SMART_CONTEXT = '1'
  $env:LLAMA_ENABLE_NO_KV_OFFLOAD = '1'
  npm restart

6) Notes about security and persistence
- Use `setx` to persist environment variables across shells (Windows). Example:
  setx MOBILE_PASSCODE_HASH "<value>"
  setx MOBILE_SESSION_SECRET "<value>"

7) If you want me to run any of these steps for you, I can prepare scripts or a single combined PowerShell script to run locally.
