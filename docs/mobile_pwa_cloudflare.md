# Mana Mobile PWA Cloudflare Setup

This guide exposes the Mana backend through a dedicated Cloudflare-protected hostname for mobile PWA use. With the tunnel target below, Cloudflare Access protects the hostname, but all routes on `http://127.0.0.1:5005` are reachable behind Access; keep the hostname dedicated to Mana and rely on Mana's own passcode for the mobile app.

## Local prerequisites

- Mana backend starts successfully on `http://127.0.0.1:5005`.
- `MOBILE_PASSCODE_HASH` is set.
- `MOBILE_SESSION_SECRET` is set.
- `node-bot/data/` is ignored by Git.
- A Cloudflare account and domain are available for the tunnel hostname.

Generate a passcode hash from `node-bot`:

```powershell
cd C:\ManaAI\Mana\node-bot
$passcode = Read-Host -AsSecureString "Mana mobile passcode"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passcode)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) | node -e "const fs = require('fs'); const { hashPasscode } = require('./mobile-auth'); const pass = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, ''); console.log(hashPasscode(pass));"
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
```

Generate a session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Local test

Start Mana, then open:

```text
http://127.0.0.1:5005/mobile/app/
```

Unlock with the configured passcode.

## Cloudflare Tunnel

Install `cloudflared`, authenticate it, and create a tunnel that routes your chosen hostname to:

```text
http://127.0.0.1:5005
```

In Cloudflare Zero Trust, add an Access application for the hostname and allow only your email or identity provider account.

Because this tunnel routes the hostname to the full Mana backend, every backend route is reachable after Cloudflare Access login. Do not route other local services through this hostname, and keep Mana's mobile passcode enabled.

Optional hardening: in the Cloudflare Access application, restrict the application path to the mobile URL paths you intend to use, such as `/mobile/*`, if that fits your deployment. This is an Access policy boundary, not something enforced by the tunnel target itself.

Use a dedicated hostname such as:

```text
https://mana.example.com/mobile/app/
```

Do not expose unrelated local services through this tunnel.

## Phone install

On iPhone Safari:

1. Open the Cloudflare-protected Mana URL.
2. Complete Cloudflare Access login.
3. Unlock with the Mana passcode.
4. Use Share -> Add to Home Screen.

## Verification

- Open the app on cellular data, not Wi-Fi.
- Confirm Cloudflare Access blocks an unauthorized browser.
- Confirm Mana passcode is still required after Cloudflare login.
- Send a text chat.
- Record a push-to-talk message.
- Close and reopen the PWA and confirm chats remain.
- Tap Send Summary and confirm the summary appears in `node-bot/data/mobile-summaries.json`.
