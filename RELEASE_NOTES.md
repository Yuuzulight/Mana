Developer Preview - Mana v0.1.0-beta

Label: Developer Preview

Short install & test instructions

1) Standalone installer (recommended)
   - Download the produced installer (attached as an artifact on CI or from the release page once available).
   - Run the installer on a Windows 10/11 machine.
   - Launch Mana from the Start menu or Desktop shortcut. The app bundles a Node runtime and should start the local backend automatically.

2) Manual setup (if not using standalone installer)
   - Install Node.js v18 (LTS) and ensure `node` is on PATH.
   - From the repo: `cd node-bot && npm ci` then `cd ../desktop-client && npm ci`
   - Start the app in dev: `cd desktop-client && npm start`

Quick smoke test

- On app start, confirm the status indicator shows the backend is running.
- Press "Hold to Talk" (or the record control) and speak a short phrase.
- Verify transcript appears and a reply is generated. If a reply is returned, TTS should play and the avatar will animate.

Known issues & caveats

- Developer Preview: This is an early release for developers and testers. Expect rough edges and manual steps.
- Code signing: Installer is unsigned in CI unless you provide code-signing secrets. Unsigned installers may trigger Windows SmartScreen warnings.
- Models & large binaries: The repo does not include model weights (LLAMA, GGUF, whisper models) or some native bindings. You must download those separately as documented in THIRD_PARTY.md and BUILD_DESKTOP.md.
- Antivirus / SmartScreen: Some AV/SmartScreen products may flag unsigned installers or executables — this is expected for beta builds.
- Artwork: Sprites/images in `sprites/` are proprietary and are NOT licensed under Apache-2.0. Do not reuse artwork without permission.
- FAISS/native bindings: If FAISS or other native bindings are not present on the target, the server falls back to JS/JSON adapters (functional but slower).

Contact / Feedback

- Report issues on GitHub Issues (use the "Contribution request" template for contribution proposals).
- For CLA or contributor inquiries contact: yuuzulight@gmail.com

Notes for reviewers

- CI will (when complete) upload a standalone Windows installer artifact. I will update this release with the installer artifact and a SHA256 checksum once the build finishes.
