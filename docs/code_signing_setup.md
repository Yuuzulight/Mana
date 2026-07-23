# Code Signing (Windows Installer)

Right now `desktop-client`'s installer and `.exe` are unsigned, which makes
Windows SmartScreen show an "Unknown Publisher" warning on every install.
This doc covers what's needed to fix that -- see
[issue #119](https://github.com/Yuuzulight/Mana/issues/119).

## What's already in place

`.github/workflows/heavy-ci.yml`'s `build-windows` job already runs
`npm run dist` with `CSC_LINK`/`CSC_KEY_PASSWORD` wired from GitHub Actions
secrets -- electron-builder signs automatically when those are set, no
`package.json` config needed. `signAndEditExecutable: false` in
`desktop-client/package.json` is unrelated to signing (it only controls
whether electron-builder edits the exe's icon/metadata via rcedit).

**However**, that `CSC_LINK`/`CSC_KEY_PASSWORD` pair assumes a portable
`.pfx` file, and that assumption is now outdated: since June 2023, the
CA/Browser Forum's baseline requirements mandate that *all* newly issued
public code-signing certificates (OV and EV alike) have their private key
generated and stored on a FIPS 140-2 Level 2+ hardware token or cloud HSM --
a CA will no longer just hand you a downloadable `.pfx`. So buying a cert
today means picking one of two real paths, not just topping up the existing
secrets.

## Option A: Azure Artifact Signing (recommended for this repo)

Microsoft's cloud signing service (formerly "Trusted Signing"). The private
key never leaves Microsoft's HSM; signing happens over an API call, which
is exactly what a hosted GitHub Actions runner (no physical hardware) needs.

- **Cost**: $9.99/month for up to 5,000 signatures on one certificate
  profile -- far cheaper than a traditional EV cert.
- **Eligibility**: individual developers currently limited to the USA and
  Canada (organizations also covered in the EU/UK). Worth confirming this
  applies before signing up.
- **electron-builder support**: native, via `sign: { type: "azure", endpoint,
  certificateProfileName }` in the `win` build config, authenticated through
  standard Azure Entra ID environment variables (`AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`).
- **CI impact**: `heavy-ci.yml`'s `CSC_LINK`/`CSC_KEY_PASSWORD` env vars
  would be replaced with the Azure Entra secrets above, and
  `desktop-client/package.json`'s `build.win` would need the `sign` block
  added.

Sign-up: https://azure.microsoft.com/en-us/products/artifact-signing

## Option B: Traditional CA cert + physical USB token

A standard Authenticode cert from a CA (DigiCert, Sectigo, SSL.com,
GlobalSign, etc.), shipped as a hardware-backed token.

- **Cost**: roughly $100-500/year depending on CA and validation level (OV
  vs EV), plus the token itself.
- **CI impact**: this **cannot run on GitHub's hosted `windows-latest`
  runner** -- there's no way to plug a physical USB token into it. Either
  sign locally (plug the token into your own machine, run `npm run dist`
  there, then upload the built installer to the release manually) or switch
  to a CA's own cloud-signing add-on (SSL.com eSigner, DigiCert KeyLocker,
  Sectigo cloud signing) if they offer one, which would need a custom
  `sign` hook since electron-builder's built-in `azure` type is
  Microsoft-specific.
- Some CAs also offer newer validity limits (460 days max as of March 2026
  per the CA/Browser Forum's Ballot CSC-31) -- factor renewal cadence into
  cost comparisons.

## What I can't do

Buying a certificate or signing up for Azure Artifact Signing needs a real
identity/payment decision -- that's for @Yuuzulight to make, not something
to automate. Once you've picked a path and have the actual credentials
(Azure Entra app registration, or a `.pfx`/token), I can wire the
`package.json`/CI config to match and verify a signed build end to end.
