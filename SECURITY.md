# Security Policy

## Supported Versions

Mana is a one-person, actively-developed project. Only the latest release
and `main` are supported -- there's no long-term-support branch, so please
upgrade to the latest version before reporting an issue if possible.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting for this repository:

1. Go to the [Security tab](https://github.com/Yuuzulight/Mana/security).
2. Click **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and its potential impact.

This opens a private advisory visible only to the maintainer, so the
report doesn't become a public roadmap for exploiting it before a fix
ships. Expect an initial response within a few days -- this is a hobby
project maintained after-hours, not a company with an on-call rotation.

## Scope Notes

Mana runs entirely on your own machine by default (local models, local
transcription, local TTS). Remote/cloud features (mobile companion access,
optional remote AI, editor integrations) are opt-in and documented in
[docs/](docs/) -- if a report is specifically about one of those opt-in
surfaces, please say so, since the local-only default has a different
threat model.
