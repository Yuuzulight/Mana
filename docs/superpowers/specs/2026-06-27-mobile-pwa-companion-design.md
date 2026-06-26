# Mana Mobile PWA Companion Design

Date: 2026-06-27

## Summary

Build a mobile Progressive Web App companion for Mana. The phone app connects to the existing PC Mana runtime through Cloudflare Tunnel, with Cloudflare Access plus a local Mana passcode protecting access. The first version is local-first: chat history is stored on the phone, shared memory summaries are stored on the PC, and there is no cloud database.

The PWA is the first step toward later iOS and Android apps. It should be designed so the mobile UI, API contracts, and sync model can be reused when native wrappers or native apps are built later.

## Goals

- Let the user access Mana away from home from a phone browser.
- Make the PWA installable from the phone home screen.
- Support text chat, push-to-talk voice input, and spoken replies.
- Persist all mobile chats locally on the phone across app closes and reopens.
- Let the user send chat summaries from the phone to PC Mana.
- Let PC Mana expose memory notes or summaries back to the phone.
- Keep persistent data local to phone and PC in the first version.
- Avoid paid cloud storage or hosted AI runtime costs.

## Non-Goals

- Do not build a native iOS or Android app in the first version.
- Do not add a permanent cloud memory store.
- Do not expose the whole PC or unrelated local services through the tunnel.
- Do not run the LLM, Whisper, or TTS stack on the phone in the first version.
- Do not rely on passive phone context such as location, notifications, or calendar data.

## Architecture

The PC remains the main Mana runtime.

- `node-bot` handles mobile chat requests, summary exchange, local memory storage, and calls to existing transcription, reply generation, and TTS paths.
- The mobile PWA is served by the PC backend or by a small companion static route in the same local service.
- Cloudflare Tunnel exposes only the mobile web/API surface.
- Cloudflare Access is the outer authentication gate.
- Mana app passcode/session auth is the inner authentication gate.

The phone is a lightweight companion.

- The PWA stores full local chat history in IndexedDB.
- The PWA records push-to-talk audio in the browser and sends it to PC Mana.
- The PWA plays synthesized audio replies when available.
- The PWA queues unsent summaries locally if PC Mana is unreachable.
- The PWA pulls PC-origin summaries or memory notes when opened and when manually synced.

There is no cloud database in version 1. Cloudflare only routes protected traffic from phone to PC.

## Authentication

Remote access uses two layers.

1. Cloudflare Access protects the public URL and allows only the approved user identity.
2. Mana requires a local app passcode after the PWA loads.

The passcode should not be stored in plaintext. The backend stores a passcode hash and a session signing secret in local environment configuration. After passcode unlock, the backend returns a short-lived session token. All private mobile API routes require that token.

If the token expires, the app locks and asks for the passcode again.

## Mobile UI

The first screen is the chat experience, not a landing page.

Core screens:

- Chat list with locally saved sessions.
- Active chat view with user messages and Mana replies.
- Text input.
- Push-to-talk microphone button.
- Speaker toggle for spoken replies.
- Connection state indicator: connected, locked, offline, retrying.
- Send Summary action for the current chat/session.
- Sync/memory view for queued summaries, sent summaries, and PC-origin memory notes.
- Settings view for server status, app lock, audio preferences, and local history clearing.

All chat sessions persist locally. Closing and reopening the PWA restores the chat list and message history.

Each local chat session stores:

- session id
- title
- messages
- timestamps
- summary text when generated
- summary sent/queued state
- linked PC-origin memory notes where applicable

The user can manually delete a chat session or clear all local mobile history.

## Voice And Audio

Push-to-talk is the first voice input mode.

Flow:

1. User holds or taps the microphone button.
2. Browser records audio.
3. PWA sends the audio to PC Mana.
4. PC Mana transcribes the audio and generates a reply.
5. PC Mana returns reply text and synthesized audio when available.
6. PWA stores the text exchange locally and plays the reply audio if enabled.

If transcription fails, the app shows a retryable error and preserves the current message state when practical. If TTS fails, the app still shows the text reply.

## Memory And Sync

Memory sync is explicit and local-first.

Phone-to-PC:

- The phone keeps full chats locally.
- The user taps Send Summary for a chat/session.
- The app either asks PC Mana to summarize the chat or sends a locally prepared summary request containing the relevant messages.
- PC Mana stores the accepted summary in its local memory store.
- If PC Mana is unreachable, the summary remains queued in IndexedDB until retry.

PC-to-phone:

- PC Mana exposes local summaries or memory notes through authenticated mobile API routes.
- The phone pulls those notes when opened and when the user manually syncs.
- Pulled notes are stored locally on the phone and can be shown in the sync/memory view.

The first PC memory store can be file-backed under a local `data/` directory ignored by Git. The format should be simple JSON or JSONL so it is easy to inspect, back up, and migrate later.

## Backend API Shape

Exact route names can change during implementation, but the first version needs these capabilities:

- `GET /mobile/health`: check backend status and feature availability.
- `POST /mobile/auth/unlock`: verify passcode and create a session token.
- `POST /mobile/chat/text`: send a text message and receive Mana's reply.
- `POST /mobile/chat/audio`: send recorded audio and receive transcript plus reply.
- `POST /mobile/summaries`: send a phone-origin summary to PC Mana.
- `GET /mobile/summaries`: pull PC-origin summaries or memory notes.
- `GET /mobile/app/*`: serve PWA static assets.

All private mobile routes require the Mana session token. Summary routes should include stable ids so retries do not create duplicates.

## Cloudflare Tunnel

Cloudflare Tunnel should point only to the local mobile surface. The recommended public route is a dedicated hostname such as `mana.example.com`.

Cloudflare Access policy:

- allow only the user's approved email or identity provider account
- require HTTPS
- keep the tunnel scoped to the mobile app/API route

The repo should document the tunnel setup, but credentials and tunnel secrets must stay outside Git.

## Offline And Failure Handling

Expected behavior:

- If the PC is offline, the PWA still opens from cached app shell when possible.
- Local chat history remains readable offline.
- New summaries can be queued locally for later sync.
- Failed sends remain retryable and visible.
- Duplicate summary sends are prevented with client-generated ids.
- If auth expires, the app locks without deleting local chats.
- If audio playback fails, text remains available.
- If browser storage is unavailable, the app warns that chat persistence is disabled.

## Data Privacy

Version 1 stores persistent private data only on the phone and PC.

- Phone chat history: IndexedDB in the PWA origin.
- Phone queued summaries: IndexedDB.
- PC memory summaries: local file-backed store.
- Secrets: local environment variables or untracked config files.
- Cloudflare: routes authenticated requests but does not act as the memory database.

The PWA service worker should cache only the app shell and static assets. It should not intentionally cache private chat API responses.

## Testing

Backend tests:

- passcode unlock success/failure
- session token enforcement
- summary create/list behavior
- duplicate summary id handling
- chat route error handling when TTS or STT is unavailable

Frontend/manual tests:

- PWA loads on mobile viewport.
- Add chat messages, close app, reopen, and confirm history remains.
- Record push-to-talk audio and receive transcript/reply.
- Toggle spoken replies.
- Queue a summary while PC backend is unreachable, reconnect, and sync.
- Install PWA to iPhone home screen.
- Access through Cloudflare Tunnel from cellular data.
- Confirm unauthorized browser/session cannot reach the app.

## Future Path

After the PWA version works:

1. Package or wrap the PWA behavior for iOS.
2. Reuse the same API and storage model for Android.
3. Add an optional cloud mailbox only if offline delivery while the PC is off becomes important.
4. Consider richer native capabilities only after the core remote Mana workflow is stable.
