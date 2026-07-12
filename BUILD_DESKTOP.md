Building the Desktop Installer (Windows)

This guide walks through producing a Windows installer for the Electron desktop client locally.

Prerequisites

- OS: Windows 10/11 (recommended for building Windows installer). You can build on Windows runner in CI or locally.
- Node.js: v18 LTS (install from https://nodejs.org/). Ensure `node` and `npm` are in PATH.
- Git: repository checkout.
- NSIS: Install Nullsoft Scriptable Install System (makensis) and ensure `makensis` is in PATH. Download: https://nsis.sourceforge.io/Download
- Disk space: Electron downloads are large — allow at least 2-4 GB for the build.

Notes about the backend (node-bot)

- The packaged installer will include the backend files under the app's resources (configured as extraResources). The packaged installer can also include a bundled Node runtime so the app runs standalone without Node installed on target machines.

Bundling Node runtime (standalone installer)

- To create a truly standalone installer that does not require Node on the target machine, place a portable Node distribution into a folder named `node-bin` at the repository root. The packager will include this into the app resources as `node_bin` and the launcher will prefer the bundled node executable if present.

  - Windows: place `node.exe` and its associated files into `node-bin/` (e.g., `node-bin/node.exe`, other DLLs if required).
  - Linux/macOS: place the corresponding platform-specific Node binary under `node-bin/bin/node`.

- Note: Please verify the Node distribution you bundle is permitted for redistribution. Official Node binaries are typically redistributable, but confirm licensing if you are unsure.

Build steps (local)

1. Open a Developer PowerShell / CMD as administrator (recommended) and navigate to the repo root:

   cd C:\ManaAI\Mana

2. Prepare a bundled Node runtime (optional for standalone)

   - If you want a standalone installer, create a `node-bin` folder at the repo root and copy the platform-appropriate Node binary into it (see notes above). Example:

     mkdir node-bin
     copy C:\path\to\node.exe node-bin\node.exe

3. Install dependencies for backend (node-bot) and desktop client:

   cd node-bot
   npm ci

   cd ..\desktop-client
   npm ci

   - Optional: fetch the Live2D Cubism Core runtime so the (currently
     testing-placeholder) avatar renders instead of falling back to PNG
     sprites: `npm run fetch-live2d-core`. See AVATAR_NOTICE.md.

4. Run the build (this will produce an installer in desktop-client/dist):

   npm run dist

   - The command uses electron-builder to create an NSIS installer by default.
   - Build logs will appear in the console. The first build downloads Electron and can take several minutes.

5. Find artifacts:

   - After a successful build, installers will be in `desktop-client/dist/` (e.g., Mana Setup 0.1.0.exe).

6. Test the installer on a clean Windows machine (or VM):

   - If you bundled node into node-bin, the app should run standalone.
   - If not bundled, ensure Node is installed on the target machine (same major/minor as your dev Node version recommended).
   - Run the installed app and confirm it spawns the backend and that audio recording/transcription/reply flows work.

Environment variables for code signing (optional)

- If you want to sign the installer with a code-signing certificate, set the following environment variables before building (or configure in electron-builder settings):
  - CSC_LINK: base64-encoded PKCS#12 (p12) certificate or a link to a certificate
  - CSC_KEY_PASSWORD: password for the certificate

- On GitHub Actions, set these as repository secrets if you want CI to produce signed installers.

Troubleshooting

- makensis not found: ensure NSIS is installed and makensis is on PATH.
- Build fails downloading Electron: check network, retry, or use a faster connection.
- Packaged app cannot spawn backend: if you did not bundle node, ensure Node is installed on target machine and in PATH. If you bundled node, ensure the bundled binary is valid and included in the installer.

Optional: Bundle Node runtime alternatives

- To avoid bundling Node, an alternative is to compile the backend into a single native executable using tools like pkg or nexe and include that in extraResources. This may simplify redistribution but has tradeoffs (native compilation complexity, OS/arch builds).

Questions / Next steps

- I can bundle an official Node binary into `node-bin` for you if you provide the binary or permit me to download and include it. I can also implement the bundling and test a local build here if you want me to run the build in this environment (it will consume time and download artifacts).
