Developer Preview - Mana v0.2.0

Label: Developer Preview

SHA256 (Mana Setup 0.2.0.exe): 30c214af9520f6f3273a0aa8e6c8cc1d73859596417922e916937f9c6943cbc5

Short install & test instructions

1) Standalone installer (recommended)
   - Download "Mana Setup 0.2.0.exe" from this release's assets.
   - Verify the SHA256 checksum above matches the downloaded file, then run
     the installer on a Windows 10/11 machine.
   - Launch Mana from the Start menu or Desktop shortcut. This build bundles
     a Node runtime and should start the local backend automatically without
     requiring Node.js on the target machine.

2) Manual setup (if not using the standalone installer)
   - Install Node.js v18 (LTS) and ensure `node` is on PATH.
   - From the repo: `cd node-bot && npm ci` then `cd ../desktop-client && npm ci`
   - Start the app in dev: `cd desktop-client && npm start`
   - Or `tools\setup-mana.ps1` automates npm installs, `.env` scaffolding,
     and a doctor report across all three subprojects.

Quick smoke test

- On app start, confirm the status indicator shows the backend is running.
- Press "Hold to Talk" and speak a short phrase.
- Verify transcript appears and a reply is generated. If a reply is
  returned, TTS should play, and the Live2D avatar (if the Cubism runtime
  and a model are present — see below) should lip sync and react.

What's new since v0.1.0-beta

- Built-in Live2D avatar with lip sync, emotion reactions, zoom framing,
  and per-model tuning (`windows-launcher`), now also ported into this
  installer-packaged desktop client — see "Avatar notice" below.
- Silence-based voice endpointing, multilingual TTS with per-language voice
  profiles, and spoken-text normalization for emoji/kaomoji/interjections.
- GPT-SoVITS wired as an opt-in trial voice-cloning provider.
- Self-hosted web search/wiki/page-reading via a local SearXNG instance.
- Persistent llama-server runtime (replacing spawn-per-request calls) and
  hourly, hash-skipping background memory indexing.
- Local vision support (screen/image description via a local Qwen2.5-VL
  model).
- Relicensed the code from PolyForm Noncommercial to Apache License 2.0.
- A setup automation script (`tools\setup-mana.ps1`) for first-run npm
  installs, `.env` scaffolding, and a doctor report.

Full detail: see CHANGELOG.md's [0.2.0] entry.

Avatar notice

The Live2D avatar bundled in this build renders a **temporary testing
placeholder model**, not Mana's final avatar. Its character design rights
belong to miHoYo/HoYoverse (see `desktop-client/AVATAR_NOTICE.md` in the
repo). It is not included in this installer's `resources` — the avatar
falls back gracefully to the existing PNG sprite UI unless you separately
fetch the Cubism runtime and place a model, per
`docs/live2d_avatar_setup.md`. A 3D model option is planned as a future
alternative avatar format.

Known issues & caveats

- Developer Preview: this is an early release for developers and testers.
  Expect rough edges and manual setup steps for models/binaries not
  bundled in the installer.
- Code signing: the installer is unsigned. Unsigned installers may trigger
  Windows SmartScreen warnings — this is expected for a preview build.
- Models & large binaries: this repo/installer does not include model
  weights (LLAMA, GGUF, whisper models) or some native bindings. Download
  those separately as documented in THIRD_PARTY.md and BUILD_DESKTOP.md.
- Antivirus / SmartScreen: some AV/SmartScreen products may flag unsigned
  installers or executables — expected for preview builds.
- Artwork: sprites/images in `sprites/` and any Live2D avatar model files
  are proprietary and are NOT licensed under Apache-2.0; see
  LICENSE-ARTWORK. The bundled testing avatar model is additionally a
  third-party placeholder — see the avatar notice above.
- FAISS/native bindings: if FAISS or other native bindings are not present
  on the target, the server falls back to JS/JSON adapters (functional but
  slower).

Contact / Feedback

- Report issues on GitHub Issues (use the "Contribution request" template
  for contribution proposals).
- For CLA or contributor inquiries, contact: yuuzulight@gmail.com
