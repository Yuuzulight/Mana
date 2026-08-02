# Issue 258: Mobile app -- scoping notes (not scheduled)

## Status: Open questions decided, still not started

The four open questions below (engine, backend connectivity, platform
priority, feature scope) now have decisions behind them -- see "Decisions"
further down. This still isn't a commitment to build the app; it means a
future build session has a concrete spec to start from instead of a menu of
options to argue over first.

Mana's native desktop presence is two Electron apps (`windows-launcher`,
`desktop-client`) plus a local Node backend (`node-bot`) -- there is no
native mobile app, and specifically no mobile avatar rendering of any kind.
There is already a working mobile *companion*, though: a chat/text PWA
(`node-bot/mobile-routes.js`, `mobile-auth.js`, `mobile-device-store.js`,
`admin/mobile_devices_ui.html`, backed by `docs/mobile_pwa_cloudflare.md`)
with passcode auth, per-device pairing, and Cloudflare Tunnel remote access
-- it has no avatar rendering at all, which is exactly the problem this doc
is about. This document exists so a future "let's actually build a native
avatar-rendering mobile app" session starts from a real blueprint instead of
from zero -- it is explicitly **not** a commitment or an estimate.

## The problem, in one sentence

A phone's WebView cannot render Mana's avatar (PIXI/Live2D or Three.js/VRM)
without either crashing on mid/low-end devices or giving up smoothness --
this is not a hunch, it's a number Project AIRI hit and published.

## What Project AIRI found (their DevLogs, translated/summarized)

They went through this exact problem two months before writing it up, in
this order:

1. **Wrapped their existing Vue web app in Capacitor** for native device
   access (background task persistence, alarms, calendar, pedometer) --
   this part worked fine; it's just a WebView with native plugin bridges.
2. **Live2D/VRM in that WebView's WebGL context was the actual blocker.**
   Their own numbers (from the 2026.03.23 DevLog, measured on a mid-range
   Samsung A34): a VRM model alone used **724MB RAM / 566MB GPU memory**
   baseline in Three.js -- enough to crash outright on some devices. Live2D
   was lighter (354MB/210MB) but still heavy for a phone WebView budget.
3. **Considered a full native-engine rewrite (Unity, then Godot)** to move
   rendering off the WebGL/WebView path entirely. Unity WebGL and Unity
   Android-Renderer modes both improved the numbers (Unity Android Renderer:
   309MB GPU / 7% CPU / smooth FPS for Live2D) but at the cost of either a
   large binary or requiring Unity/C# expertise from contributors.
4. **Rejected replacing the UI with the engine's own UI system.** Both
   Unity's and (later) Godot's own UI toolkits couldn't match the
   complexity of their existing Vue-based UI, and rewriting all of it
   wasn't worth it just to solve a rendering problem.
5. **Landed on a hybrid** (2026.03.29 DevLog): **the game engine (Godot)
   owns only the avatar rendering; a transparent native WebView is
   layered on top for everything else** (chat UI, settings, all existing
   logic) -- same web app, just composited over a native 3D/2D view
   instead of sharing a WebGL context with it.
   - **Android**: grab the Godot Activity's root `FrameLayout` (found via
     `adb shell uiautomator dump`), stack a `WebView` on top with
     `setBackgroundColor(Color.TRANSPARENT)`, load the existing web app's
     URL into it. No official plugin existed for this; they hacked it
     directly into `GodotApp.java`'s `onGodotMainLoopStarted()` hook.
   - **iOS**: no such shortcut exists inside a Godot plugin (no
     `AppDelegate` access), so they wrote a proper Godot iOS plugin
     (`.gdip` config + an Objective-C shim calling into Swift) that
     resolves the host `UIWindowScene`'s key window and overlays a
     transparent `WKWebView`, pinned to edges via Auto Layout.

## The one-sentence takeaway

**Don't try to make the avatar rendering itself lighter -- separate
rendering from UI entirely.** A native/engine layer renders only the
avatar; a thin transparent web overlay (reusing all of Mana's existing
HTML/CSS/JS) handles everything else. This is a genuine architecture
decision, not a WebGL optimization pass.

## What this means for Mana specifically

Background for each call, kept for context even though these are now
decided:

- **Engine choice**: Godot (free, open-source, matches AIRI's own choice
  and their published Android/iOS overlay code) is the most-derisked
  option since a working reference implementation exists to study. Unity
  is the other option AIRI evaluated first, with its own licensing/binary-
  size tradeoffs. Neither has been evaluated against Mana's specific avatar
  stack (PIXI for Live2D, Three.js/`@pixiv/three-vrm` for VRM) -- both
  would likely need each avatar format re-implemented in the engine's own
  renderer (Godot's own VRM importer exists per its Godot addon
  ecosystem; Live2D has an official Cocos/native Cubism SDK for
  non-web engines that would need separate integration).
- **Backend connectivity**: option (a) -- talking to the same desktop
  backend over the local network/tunnel -- isn't just a plan, it's a
  working feature already: `node-bot/mobile-routes.js`'s passcode auth and
  rate-limited unlock, `mobile-device-store.js`'s per-device pairing, and
  the Cloudflare Tunnel path in `docs/mobile_pwa_cloudflare.md`. A native
  avatar-rendering app would almost certainly reuse this auth/tunnel layer
  rather than build its own. Option (b) (on-device inference, no discrete
  GPU) remains a much bigger, genuinely separate question, unaffected by
  this.
- **Platform priority**: AIRI's writeup shows Android as the easier path
  (no official plugin needed, direct `Activity` access) and iOS as
  meaningfully harder (custom Godot plugin, Objective-C/Swift bridge).
- **What "the avatar" needs to do on phone**: screen space and battery
  constraints are both much tighter than desktop.

## Decisions

Resolved in a scoping conversation, not baked in speculatively:

1. **Engine: Godot.** Follows directly from it being the only option with
   a published, working reference implementation (AIRI's own
   Android/iOS overlay code) to study instead of prototyping the
   engine-hosts-a-transparent-WebView trick from scratch.
2. **Backend connectivity: reuse the existing mobile PWA's auth/tunnel
   layer directly**, not a separate transport. The native avatar shell
   talks to `node-bot` the same way the PWA already does --
   `mobile-routes.js`'s passcode auth, `mobile-device-store.js`'s
   per-device pairing, Cloudflare Tunnel for remote access. No new backend
   surface to build or secure.
3. **Platform priority: Android first.** Matches AIRI's own finding that
   Android needs no official plugin (direct `Activity`/`FrameLayout`
   access) while iOS requires writing a custom Godot plugin with an
   Objective-C/Swift bridge -- meaningfully more work before anything
   renders. iOS stays a possible follow-up, not committed to.
4. **Feature scope: reduced set for the first build** -- idle, talking,
   and basic expressions only. Full parity with the desktop avatar's state
   machine (zoom framing, gaze drift, the full expression set) is
   explicitly deferred past a first working proof-of-concept.

## Build plan (not started)

A concrete task sequence for whenever this is picked up, one level past the
Decisions above. Nothing here has been installed or written yet -- this
machine has no Godot, no JDK, and no Android SDK/NDK. Each phase names its
own deliverable so progress is checkable, and the phases that carry a real
open technical risk (not just "time to do it") are flagged explicitly
rather than assumed away.

**Phase 0 -- toolchain.** Install Godot 4.x (with Android export templates),
a JDK (17+), and the Android SDK/NDK (via Android Studio's SDK manager or
the standalone command-line tools) plus `adb`. Deliverable: `godot
--version` succeeds and a brand-new empty Godot project exports a debug
APK that installs and opens on a device/emulator. This phase alone is a
multi-GB download and a real chunk of setup time -- worth doing in its own
sitting, not folded into "start the app." Prefer a real Android device
over an emulator for every later phase's testing if one is available --
Godot's rendering (and GDExtension native code in Phase 4) is a much
less reliable signal on emulated GPU/Vulkan support than on real hardware,
and a rendering failure that's actually an emulator limitation is easy to
misdiagnose as a Godot/plugin bug.

**Phase 1 -- project skeleton.** New Godot project as a sibling of
`windows-launcher`/`desktop-client` (e.g. `mobile/`), Android export preset
configured against a real package id and debug keystore. Deliverable: an
installable APK showing just a blank/colored screen -- proves the full
toolchain end to end before touching anything AIRI-specific.

**Phase 2 -- the transparent-WebView-overlay trick.** AIRI's writeup hooks
`GodotApp.java`'s `onGodotMainLoopStarted()` directly, but that's Godot's
older Java-based Android runtime. **Confirmed** (not just assumed): Godot
4.2+ replaced that with a new v2 Android plugin architecture -- a Kotlin
`GodotAndroidPlugin` class extending `GodotPlugin`, with methods exposed to
GDScript via `@UsedByGodot` annotations, per Godot's own docs and the
official [Godot-Android-Plugin-Template](https://github.com/m4gr3d/Godot-Android-Plugin-Template)
(see also the [Godot 4.4 Android plugin docs](https://docs.godotengine.org/en/4.4/tutorials/platform/android/android_plugin.html)).
So the specific hook from the writeup won't exist verbatim in a current
Godot project -- **the plugin needs to be written against this v2 API**,
re-verified against whatever exact Godot version Phase 0 installs. The
underlying technique (grab the root `FrameLayout`, stack a `WebView` with
`setBackgroundColor(Color.TRANSPARENT)`) is still the right approach, just
reached through a current-generation plugin instead of AIRI's older hook.
Deliverable: an APK where a transparent WebView renders a placeholder HTML
page on top of a visibly different-colored Godot background, proving the
compositing actually works.

**Phase 3 -- backend connectivity.** Wire the WebView to `node-bot`'s
already-existing mobile API, reusing it exactly as decided (see
Decisions #2) rather than writing new client code: `/mobile/pair/request`
+ `/mobile/pair/complete` for device pairing, `/mobile/auth/unlock` for
session unlock, `/mobile/chat/text` for text chat, `/mobile/chat/audio`
for voice (uploads a recorded clip, runs it through the same Whisper
transcription the desktop apps use, then the same reply pipeline), and
`/mobile/synthesize` for TTS playback (all in `node-bot/mobile-routes.js`).
The existing PWA client at `node-bot/mobile-app/app.js` already implements
this exact pairing/auth/chat flow against these routes -- load it into the
WebView (or adapt it directly) instead of re-deriving the request shapes
from scratch. Note the voice UX this API implies is fundamentally
different from desktop's: `/mobile/chat/audio` is upload-a-recorded-clip,
not the continuous wake-word/VAD listening loop `windows-launcher` and
`desktop-client` run -- there's no backend route for streaming/continuous
audio at all. Whether the mobile app gets a "hold to talk and release"
button (matching the existing PWA) or something closer to always-listening
is a real product decision to make in this phase, not an assumption to
carry over from desktop. Deliverable: the WebView shows a real chat
(including at least one voice round-trip through `/mobile/chat/audio`)
that actually reaches the backend (needs the desktop machine reachable,
per `docs/mobile_pwa_cloudflare.md`).

**Phase 4 -- avatar rendering in Godot.** A real candidate now exists,
narrowing this from "no known path" to "evaluate this specific option":
[GDCubism](https://github.com/MizunagiKB/gd_cubism) (`MizunagiKB/gd_cubism`)
is an actively-maintained, unofficial GDExtension bridging the Live2D
Cubism Native Framework into Godot 4.1.1+ via GDScript/C#, with a v0.9+
rewrite specifically aimed at reducing GPU/memory load through direct
rendering -- the same problem AIRI's writeup hit head-on in the WebView
path. **Still an open question, not fully resolved**: GDCubism's
documented baseline targets are Godot 4.1.1+/4.3+, but Mana's actual
runtime models are Cubism SDK **5.1.0** (per `Live2D Cubism Core version:
05.01.0000` in the real windows-launcher console log captured for issue
#137) -- whether GDCubism's bundled Cubism Native Framework build actually
supports Cubism 5-format models needs checking against its own docs/repo
before assuming it "just works" with Hiyori or any of Mana's real models.
If it doesn't, the fallback is still hand-binding the native Cubism SDK
into a custom GDExtension, just with GDCubism's source available as a
working reference instead of starting from nothing. Deliverable, staged:
first checkpoint is idle animation rendering inside the Godot layer with a
real model; "talking" and the basic expression set (Decisions #4's full
reduced scope) layer on once idle is proven, not required for this phase's
first deliverable.

**Phase 5 -- state sync between the WebView and the Godot layer.** ⚠️ *Real
open risk*: the WebView (chat UI, text) and Godot (avatar) run in separate
rendering contexts once split this way, and AIRI's writeup doesn't detail
how they pass state to each other (e.g. "user is talking" -> avatar's
talking animation). Options to evaluate: Android's `Intent`/broadcast
mechanism between the WebView's JS-to-native bridge and the same Phase 2
Godot Android plugin, or a tiny loopback WebSocket/HTTP bridge between the
two processes. Deliverable: sending a chat message in the WebView visibly
drives the Godot avatar into its talking state.

**Phase 6 -- packaging.** Debug keystore -> a real release-signing setup,
plus an equivalent to desktop's `AVATAR_NOTICE.md`/`LICENSE-ARTWORK` split
for whatever avatar model actually ships in a public APK (Hiyori's Live2D
Free Material License terms apply the same way on mobile as on desktop --
see issue #137's PR history for how that was verified there). Shares the
"we haven't set up code signing yet" gap with the already-open issue #119
(desktop-client Windows installer signing) -- different platform, same
unaddressed problem, worth solving with half an eye on both at once rather
than twice independently. Deliverable: a signed release APK, installable
outside Godot's own debug/export flow, with its avatar licensing story as
clear as the desktop apps' already is.

Phases 0-1 are pure setup with no open questions. Phase 2's risk is now
resolved into a concrete implementation target (the v2 plugin API) rather
than an open unknown. Phase 4's risk is narrowed to one checkable question
(Cubism 5 support in GDCubism) instead of "does anything exist at all."
Phase 5 remains the least-scoped of the three -- worth resolving (or at
least time-boxing as its own short investigation) before estimating it,
not discovered mid-implementation.

## Not a commitment

Deciding these four questions and sketching this build plan removes the
"which direction do we even go" ambiguity, but nothing here is scheduled,
estimated as a real timeline, or actually started -- no tooling installed,
no code written. The value of this document is in not having to re-derive
"why can't I just put the avatar in a WebView," re-litigate
engine/platform/scope choices, or rediscover which phases carry real risk
-- from scratch whenever this is actually picked up.
