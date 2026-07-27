---
name: diagnosing-a-stuck-tts-provider
description: What to check when Mana's replies stop producing audio after a TTS provider swap (gaming-mode auto-switch or a manual override).
category: troubleshooting
created: 2026-07-27T00:00:00.000Z
lastUsed: 2026-07-27T00:00:00.000Z
status: active
---

If Mana replies in text but no audio plays, check in this order before
assuming the TTS service itself is broken:

1. **Confirm which provider is actually active.** `GET /tts/override` on the
   backend (port 5005) returns the current override, if any. Gaming mode's
   automatic device swap and a manual override in the sidebar's voice
   provider dropdown can disagree about which provider *should* be active
   versus which one actually loaded.
2. **Check the provider process is really running.** Fish (S1-mini),
   Kokoro, and GPT-SoVITS each run as a separate local process
   (`kokoro_service.py`, `api_v2.py`, etc.) -- `npm run doctor` reports
   each one's reachability. A provider swap that killed the old process
   but failed to fully start the new one leaves Mana silently falling
   back to no audio rather than erroring loudly.
3. **Look for a stale swap-debounce lock.** `ensureServerConfig`'s swap
   debounce (added for issue #68) exists specifically to stop back-to-back
   swap requests from racing each other -- if a swap got interrupted
   mid-flight (e.g. the game that triggered gaming mode closed immediately
   after opening), the debounce window can leave the runtime believing a
   swap is still in progress. Restarting the backend clears this without
   needing to touch any config.
4. **Only then** treat it as a real synthesis failure (check the specific
   provider's own logs for a crash/exception) rather than a swap/wiring
   issue.
