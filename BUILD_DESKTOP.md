Building the Desktop Installer (Windows)

This guide walks through producing a Windows installer for the Electron desktop client locally.

Prerequisites

- OS: Windows 10/11 (recommended for building Windows installer). You can build on Windows runner in CI or locally.
- Node.js: v18 LTS (install from https://nodejs.org/). Ensure `node` and `npm` are in PATH.
- Git: repository checkout.
- NSIS: Install Nullsoft Scriptable Install System (makensis) and ensure `makensis` is in PATH. Download: https://nsis.sourceforge.io/Download
- Disk space: Electron downloads are large — allow at least 2-4 GB for the build.

Notes about the backend (node-bot)

- The packaged installer will include the backend files under the app's resources (configured as extraResources). However, the packaged Electron app spawns the `node` executable to run the backend. Therefore, the target machine must have a compatible Node runtime installed and accessible via PATH.
- If you prefer a truly standalone EXE that does not require a system Node, you must bundle a Node runtime (e.g., a portable node.exe) into the installer and update `desktop-client/main.js` to use the bundled Node executable. This repo currently assumes Node is available on target systems.

Build steps (local)

1. Open a Developer PowerShell / CMD as administrator (recommended) and navigate to the repo root:

   cd C:\ManaAI\Mana

2. Install dependencies for backend (node-bot) and desktop client:

   cd node-bot
   npm ci

   cd ..\desktop-client
   npm ci

3. Run the build (this will produce an installer in desktop-client/dist):

   npm run dist

   - The command uses electron-builder to create an NSIS installer by default.
   - Build logs will appear in the console. The first build downloads Electron and can take several minutes.

4. Find artifacts:

   - After a successful build, installers will be in `desktop-client/dist/` (e.g., Mana Setup 0.1.0.exe).

5. Test the installer on a clean Windows machine (or VM):

   - Ensure Node is installed on the test machine (same major/minor as your dev Node version recommended).
   - Run the installer, then run the installed app and confirm it spawns the backend and that audio recording/transcription/reply flows work.

Environment variables for code signing (optional)

- If you want to sign the installer with a code-signing certificate, set the following environment variables before building (or configure in electron-builder settings):
  - CSC_LINK: base64-encoded PKCS#12 (p12) certificate or a link to a certificate
  - CSC_KEY_PASSWORD: password for the certificate

- On GitHub Actions, set these as repository secrets if you want CI to produce signed installers.

Troubleshooting

- makensis not found: ensure NSIS is installed and makensis is on PATH.
- Build fails downloading Electron: check network, retry, or use a faster connection.
- Packaged app cannot spawn backend: ensure Node is installed on target machine and in PATH.

Optional: Bundle Node runtime

- To make the app fully standalone, bundle a node.exe next to the backend files in extraResources and change `desktop-client/main.js` to spawn that bundled binary. I can help implement this if you want a fully self-contained installer.

Questions / Next steps

- Would you like me to bundle a portable node binary into the installer and update `main.js` so the app runs without requiring Node on the target machine? If yes, tell me whether you want to include Node from official distribution (ensure license compatibility) or use another approach (e.g., pkg conversion of backend).
