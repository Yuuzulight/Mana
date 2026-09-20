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

`docs/roadmap/hermes-desktop-eval-2026-09.md`.
