# Mana Mobile PWA Cloudflare Setup

This guide exposes only Mana's mobile PWA/API surface through Cloudflare Tunnel. Persistent chat and memory data stay on the phone and PC.

## Local prerequisites

- Mana backend starts successfully on `http://127.0.0.1:5005`.
- `MOBILE_PASSCODE_HASH` is set.
- `MOBILE_SESSION_SECRET` is set.
- `node-bot/data/` is ignored by Git.
- A Cloudflare account and domain are available for the tunnel hostname.

Generate a passcode hash from `node-bot`:

```powershell
cd C:\ManaAI\Mana\node-bot
node -e "const { hashPasscode } = require('./mobile-auth'); console.log(hashPasscode('YOUR_PASSCODE'))"
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
