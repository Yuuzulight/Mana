# Issue #359: Mac/Linux launcher and packaging scope

Scoping note, 2026-08-17. No code changes. The question is how much work
Mac/Linux support would actually be, and where it sits.

## The headline

**It is a launcher and packaging effort, not a rewrite.** The core AI
pipeline is already cross-platform by construction; the friction is
concentrated in the layer that touches the operating system, and it is
concentrated more narrowly than the raw grep count suggests.

79 lines across the codebase mention `process.platform`, `win32` or `.exe`.
Most of them are not portability blockers, and the distinction matters.

## What is genuinely portable today

- **`node-bot`** -- plain Node. Nothing about the server, memory store,
  skills, approval gate or plugin system is Windows-bound.
- **llama.cpp / whisper.cpp** -- both ship for macOS and Linux, with Metal
  and CUDA/ROCm backends respectively.
- **Kokoro TTS** -- ONNX, runs anywhere.
- **SearXNG** -- Python, cross-platform.
- **MCP, Zed/VS Code integration** -- both editors are cross-platform and
  their CLIs behave the same way.

None of that was an accident: those tools were chosen for portability, and
it holds up.

## What is actually Windows-bound

### 1. The launcher's OS integration (the real work)

`windows-launcher/main.js` uses `Tray` (11 sites), `screen` (20),
`globalShortcut` (5), `powerMonitor` (4), `nativeImage` (3) and
`desktopCapturer` (2).

Electron provides all of these on all three platforms, so this is not a
porting problem so much as a **behaviour** problem:

- **Global shortcuts** -- `Control+Alt+Space`, `Control+Alt+M` and
  `Control+Alt+I` need Mac equivalents (`Command`), and on Linux they depend
  on the desktop environment honouring them.
- **Screen capture** -- `desktopCapturer` needs an explicit permission
  grant on macOS, and on Linux splits on X11 versus Wayland, where Wayland
  requires the portal API rather than direct capture.
- **Tray** -- behaves differently enough per platform (menu bar on macOS,
  varying tray support across Linux DEs) to need real testing rather than
  assumption.

### 2. Path and process assumptions

Concrete, findable, and mostly small:

- `ai/local-llama-runtime.js` uses `path.win32.dirname()` deliberately,
  with a comment saying this module only supports the bundled Windows/CUDA
  build.
- `zed-integration.js` carries `quoteWindowsCmdArg()`, `buildSpawnInvocation()`
  (`.cmd`/`.bat` handling) and a `where` versus `which` branch. These are
  already platform-aware -- they branch rather than assume -- so they are
  closer to done than the rest.
- Hardcoded default paths like `C:\Program Files\Zed\zed.exe` and
  `C:\llama\llama-cli.exe` need per-platform defaults.
- `memory-inbox.js` uses `fs.watch` with a comment noting Windows has
  always supported it and Mana is Windows-only. `fs.watch` is less reliable
  on Linux and macOS; this is the one place where the *choice* of API, not
  just its configuration, may need revisiting.

### 3. Fish Speech requires WSL2

Documented across `docs/fish_speech_tts.md`,
`docs/fish_speech_install_status.md` and `docs/wsl_cuda_setup.md`: the
official setup path needs WSL2 because native Windows is unsupported
upstream.

This inverts on other platforms -- Fish Speech runs *natively* on Linux,
and the WSL layer disappears entirely. macOS is the harder case, since the
stack is CUDA-oriented. **Kokoro already exists as the cross-platform
fallback**, and the docs already recommend it as the default for real voice
interaction, so this is a smaller problem than it looks.

### 4. Packaging

Both `windows-launcher` and `desktop-client` declare `win: ["nsis"]` and
**no `mac` or `linux` targets at all**. That is the most concrete gap in the
whole scope:

- macOS needs `.dmg` plus signing and notarisation -- and notarisation
  means an Apple Developer account, which is a cost and an account, not
  just configuration.
- Linux needs AppImage, deb or flatpak, and each carries different
  assumptions about where an app may write.

Related: #119 (code-signing the Windows installer) is unresolved, and macOS
notarisation is a strictly harder version of the same problem.

### 5. VTube Studio

No native Linux build exists, regardless of what Mana does. Any Linux
avatar story is either Wine, or a different avatar pipeline.

## Sequencing

**Backend modularization first**, as the issue already suggests. The reason
is concrete rather than architectural taste: `windows-launcher` hardcodes
`http://localhost:5005` in 32 places across 4 files. Every per-OS launcher
would need to make the same decision independently until that is one
setting.

After that, in rough order of value:

1. **Linux** before macOS. The stack is CUDA-oriented and Fish Speech runs
   natively there, so Linux is mostly launcher and packaging work. macOS
   additionally means no CUDA, a different TTS story, and notarisation.
2. **Packaging targets** are the mechanical part and can be done early to
   surface problems.
3. **Screen capture on Wayland** is the single hardest technical item and
   deserves its own investigation rather than being folded in.

## Honest estimate of shape

Not a rewrite. But not a weekend either -- the work is broad rather than
deep: many small platform branches, two new packaging pipelines, one Apple
account, one genuinely hard capture problem on Wayland, and an avatar gap
on Linux with no clean answer.

**Nothing here is blocked.** It is unstarted because there is no second
machine to run it on, which is a priority question rather than a technical
one.
