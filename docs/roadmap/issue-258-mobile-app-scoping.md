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

## Not a commitment

Deciding these four questions removes the "which direction do we even go"
ambiguity, but nothing here is scheduled, estimated, or broken into tasks.
The value of this document is in not having to re-derive "why can't I just
put the avatar in a WebView" -- or re-litigate engine/platform/scope choices
-- from scratch whenever this is actually picked up.
