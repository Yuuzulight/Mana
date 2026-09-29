# Issue 645: Add OS-Keyring / Password-Manager-Backed Credential Storage

## Goal

Let a user store provider/plugin credentials in an existing password
manager (1Password, Bitwarden) or the OS keyring instead of Mana's own
storage being the only option.

## Why

A repo-wide search for `1password`, `bitwarden`, `credential.?vault`, and
`keyring` returns zero matches anywhere in Mana's codebase — provider API
keys and plugin credentials have no vault-backed storage or retrieval
path today.

Hermes Agent added exactly this in v0.21.2: a "password-blind credential
vault" integrating with 1Password and Bitwarden, alongside
OS-keyring-encrypted storage for its own multi-gateway tokens (falling
back to an explicit plain-text opt-in only on keyring-less Linux). This
is a meaningful security posture improvement for any local-first tool
handling API keys and plugin credentials (Discord/Telegram bot tokens,
stock/job-search API keys, etc.) — the kind of software Mana already is.

## Proposed Scope

- Add OS-keyring-backed storage as the default for provider/plugin
  credentials currently stored in plaintext config, with the same
  keyring-less-Linux plain-text fallback pattern Hermes uses (explicit
  opt-in, not silent).
- Evaluate 1Password/Bitwarden CLI or API integration as an optional
  credential source, so a user with an existing vault doesn't need to
  duplicate secrets into Mana's own storage.
- Audit exactly which credentials currently live in plaintext (provider
  API keys, plugin tokens) before implementation, since scope depends on
  what's actually there.

## Acceptance Criteria

- Provider and plugin credentials are stored via OS keyring by default
  on platforms that support it, with an explicit, non-silent plain-text
  fallback where they don't.
- At least one third-party vault (1Password or Bitwarden) is supported
  as an optional credential source.
- A documented audit of what credentials existed in plaintext before
  this change, and confirmation they've been migrated or flagged.

## Related

the 2026-09 Hermes Desktop evaluation (moved out of the repo; see git history).

## Audit: credentials Mana stored in plain text (2026-09-29)

Found by reading the code, not any real install's files.

| Where | What | Plain text? | Status |
|---|---|---|---|
| `node-bot/.env` | Provider keys (`OPENAI_API_KEY`, `MANA_IMAGE_API_KEY`, `FISH_TTS_API_KEY`), plugin tokens (`MANA_DISCORD_BOT_TOKEN`, `MANA_TELEGRAM_BOT_TOKEN`, `MANA_MATRIX_ACCESS_TOKEN`, `ALPHA_VANTAGE_API_KEY`, `ADZUNA_APP_KEY`), backend secrets (`ADMIN_TOKEN`, `MANA_ADMIN_SECRET`, `MOBILE_SESSION_SECRET`, `MOBILE_TOTP_SECRET`, `PY_TOKEN_SERVER_SECRET`, `RETRIEVER_EMBEDDER_SECRET`, `CLOUDFLARE_TUNNEL_TOKEN`) | Yes | **PR 1:** each can be a `keyring:` (Windows Credential Manager) or `op://` (1Password) reference; any still in plain text is named in a startup warning |
| `node-bot/data/model-settings.json` | `brain.apiKey` for an OpenAI-compatible endpoint, set in Settings | Yes | Flagged; not covered yet (it's written by the Settings UI, not hand-edited) |
| `%LOCALAPPDATA%\Mana\native-launcher-settings.json` | Launcher's `AdminToken` | Yes | Flagged; not covered yet (C# side; Credential Manager or DPAPI) |
| `node-bot/data/auth/SETUP.txt` | First-run admin API key | Yes | Flagged; the file tells the user to save the key and delete it |
| `node-bot/data/auth/accounts.json` | Account API keys | No: salted scrypt hashes | Fine |
| `node-bot/data/mobile-devices.json` (mobile-device-store) | Device tokens | No: SHA-256 hashes | Fine |
| `.env` `MOBILE_PASSCODE_HASH` | Mobile passcode | No: PBKDF2 hash | Fine |
| Mobile PWA `localStorage` | Short-lived session token | Yes, in the phone's browser | Fine (expires; browser-scoped) |
| `data/plugin-settings.json` | Enabled flags and consents only | n/a | No credentials |

Nothing is migrated automatically: moving a secret means adding it to
Credential Manager/1Password and replacing its `.env` value with the
reference, which is reversible by putting the plain value back.

## Status

- **PR 1 (done):** `node-bot/load-env.js` resolves `keyring:<target>`
  (Credential Manager generic credential, read via `CredReadW` through
  PowerShell, no new dependency) and `op://...` (1Password CLI
  `op read`) references in `.env`; unreadable references leave the key
  unset with a warning; plain-text secrets are named at startup.
  Documented at the top of `node-bot/.env.sample`.
- **Left:** `brain.apiKey` and the launcher `AdminToken` (above);
  Bitwarden (`bw get`, needs a `BW_SESSION` unlock flow); an opt-in,
  reversible helper that moves a `.env` value into Credential Manager;
  a non-Windows keyring (`secret-tool` / macOS `security`) -- `keyring:`
  currently fails loudly off Windows and plain text stays the explicit
  fallback there.
