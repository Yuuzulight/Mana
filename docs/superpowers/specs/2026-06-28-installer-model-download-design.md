# Mana Installer With Downloadable Local Models Design

## Goal

Make Mana easy to move to a new Windows PC by building a normal Windows installer that installs the app and creates shortcuts, while downloading the large local AI model files during first-run setup instead of bundling them into the installer.

## Scope

This design covers the Windows installer path for the current Electron-based launcher and Node backend. It keeps Mana local-only for chat inference: downloaded models are stored on disk and used through local `llama.cpp`. The installer may use the internet to download models and update model-source metadata, but chat replies still run locally after setup.

This design does not replace the current development flow. `npm run start` in `windows-launcher` remains useful for development.

## User Experience

The new PC flow should be:

1. Run `ManaSetup.exe`.
2. Installer copies Mana app files into a predictable install folder.
3. Installer creates Start Menu and Desktop shortcuts named `Mana`.
4. User launches Mana from the shortcut.
5. Mana checks for required local runtime files and models.
6. If GGUF models are missing, Mana opens a setup/download screen before starting the normal voice loop.
7. The setup screen downloads the 4B model first, then the 1.5B fallback, then the 8B backup.
8. After the 4B model is present, Mana can run. The 1.5B and 8B downloads can continue or be retried from setup if interrupted.

## Install Layout

Default install folder:

```text
C:\ManaAI\Mana\
```

Important paths:

```text
C:\ManaAI\Mana\windows-launcher\
C:\ManaAI\Mana\node-bot\
C:\ManaAI\Mana\tts-service\
C:\ManaAI\Mana\tools\whisper\
C:\ManaAI\Mana\tools\llama\
C:\ManaAI\Mana\tools\llama\gguf-models\
C:\ManaAI\Mana\config\model-sources.json
```

The installer should install app code, package dependencies needed for runtime, launcher assets, backend files, and local runtime helpers. It should not bundle the 1.5B, 4B, or 8B GGUF files by default because that would make the installer too large.

## Model Manifest

Model sources must be updateable without rewriting installer logic. Mana should use a JSON manifest stored at:

```text
C:\ManaAI\Mana\config\model-sources.json
```

The repository should include a default manifest, and the installed app should be able to refresh it from a configured remote URL when the user clicks an update/check button.

Manifest shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-06-28",
  "models": [
    {
      "id": "qwen3-4b-primary",
      "role": "primary",
      "displayName": "Qwen3 4B Q4_K_M",
      "fileName": "Qwen3-4B-Q4_K_M.gguf",
      "targetPath": "tools/llama/gguf-models/Qwen3-4B-Q4_K_M.gguf",
      "sizeBytes": 2497280256,
      "requiredForFirstRun": true,
      "sources": [
        {
          "type": "huggingface",
          "repo": "unsloth/Qwen3-4B-GGUF",
          "revision": "main",
          "file": "Qwen3-4B-Q4_K_M.gguf"
        },
        {
          "type": "direct",
          "url": "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
        }
      ]
    },
    {
      "id": "qwen2.5-1.5b-fast-fallback",
      "role": "fast-fallback",
      "displayName": "Qwen2.5 1.5B Instruct Q4_K_M",
      "fileName": "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "targetPath": "tools/llama/gguf-models/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "sizeBytes": 1117320736,
      "requiredForFirstRun": false,
      "sources": [
        {
          "type": "direct",
          "url": "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
        }
      ]
    },
    {
      "id": "qwen3-8b-quality-backup",
      "role": "quality-backup",
      "displayName": "Qwen3 8B Q4_K_M",
      "fileName": "Qwen3-8B-Q4_K_M.gguf",
      "targetPath": "tools/llama/gguf-models/Qwen3-8B-Q4_K_M.gguf",
      "sizeBytes": 5027783488,
      "requiredForFirstRun": false,
      "sources": [
        {
          "type": "huggingface",
          "repo": "unsloth/Qwen3-8B-GGUF",
          "revision": "main",
          "file": "Qwen3-8B-Q4_K_M.gguf"
        },
        {
          "type": "direct",
          "url": "https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf"
        }
      ]
    }
  ],
  "manifestSources": [
    {
      "name": "Mana default",
      "url": "https://raw.githubusercontent.com/Yuuzulight/Mana/main/config/model-sources.json"
    }
  ]
}
```

The manifest must support both Hugging Face repo/file fields and direct URLs. A future model update should usually require only updating `config/model-sources.json` in the repo or replacing the installed manifest.

## Installer Packaging

Use the existing `electron-builder` dependency in `windows-launcher` as the installer path. Add Windows NSIS installer configuration to `windows-launcher/package.json` or a dedicated builder config file.

The installer should:

- build `ManaSetup.exe`;
- install into `C:\ManaAI\Mana` by default;
- create Desktop and Start Menu shortcuts;
- install the Electron launcher and needed app files;
- exclude `.git`, `.worktrees`, test artifacts, temporary audio, screenshots, caches, and large local GGUF model files;
- include `config/model-sources.json`;
- include a first-run setup/check screen in the app rather than putting download logic in NSIS scripts.

Download logic belongs in the Electron app, not the installer script, because Electron can show progress, retry failures, refresh the manifest, and remain easier to test.

## First-Run Setup Flow

Add a setup mode to `windows-launcher`.

Startup sequence:

1. Load local `config/model-sources.json`.
2. Optionally check configured manifest update URLs if the user clicks `Update sources`.
3. Inspect each model target path.
4. If the 4B primary model exists, allow normal startup.
5. If the 4B primary model is missing, show the setup window and block the voice loop until it downloads.
6. Show status for all three models: installed, missing, downloading, failed, or skipped.
7. Let the user download missing backup models after the primary model is installed.

The setup screen should include:

- model name and role;
- download size;
- source label, such as Hugging Face or direct URL;
- progress bar;
- current speed and downloaded bytes;
- retry button;
- update model sources button;
- open model folder button.

## Downloader Behavior

The downloader should be implemented in the Electron main process or a focused Node module called by the main process.

Rules:

- download to a temporary `.partial` file in the destination folder;
- create parent folders before downloading;
- resume only if the server supports ranges, otherwise restart cleanly;
- rename `.partial` to `.gguf` only after the expected size matches, when `sizeBytes` is present;
- use HTTPS only by default;
- reject destination paths that escape the Mana install folder;
- keep existing good model files;
- retry transient network failures with a clear error message;
- never download paid/proxy chat providers or API keys.

The first implementation will use expected file size as the basic integrity check because the current known model sizes are already recorded. The manifest schema should allow optional checksum fields so a future manifest revision can add stronger verification without changing downloader control flow.

## Runtime Model Selection

The backend already supports the desired model tier order:

1. `Qwen3-4B-Q4_K_M.gguf`
2. `qwen2.5-1.5b-instruct-q4_k_m.gguf`
3. `Qwen3-8B-Q4_K_M.gguf`

The installer/setup work should preserve that order. The app should set `MANA_ALLOW_REMOTE_AI=0` for local-only chat by default.

## Updating Hugging Face Sources And Links

The app should provide a model-source update path:

- `Update sources` downloads the manifest from the configured URL in `manifestSources`.
- The refreshed manifest replaces `config/model-sources.json` only after it parses successfully and contains the required primary model entry.
- The setup screen reloads model availability after updating.
- A local fallback manifest remains available if the update fails.

This lets future changes to Hugging Face repos, filenames, revisions, or direct links be handled by updating the manifest rather than rebuilding downloader code.

## Error Handling

If there is no internet, Mana should say the primary model is missing and explain that model download requires internet or manually placing the GGUF file in `tools\llama\gguf-models`.

If a download is interrupted, the UI should keep the `.partial` file and offer retry. If resume is not possible, retry should restart the file.

If the manifest update fails, the UI should keep using the bundled local manifest and show the error in setup details.

If the downloaded file size does not match `sizeBytes`, the UI should mark the download failed and keep the `.partial` file until the user retries or deletes it.

If the new PC lacks Node runtime behavior needed by the unpacked backend, the packaged Electron app should still launch because Electron supplies its own Node runtime for the launcher. The backend spawn path must be verified during implementation; if plain `node server.js` is unavailable on a target PC, the plan should add a packaged backend launch strategy before release.

## Tests And Verification

Automated tests should cover:

- manifest parsing;
- rejecting invalid manifests;
- choosing direct URL from Hugging Face repo metadata;
- path traversal rejection for `targetPath`;
- installed/missing model detection;
- expected size validation;
- primary model required before normal startup;
- backup models optional after first run.

Manual verification should cover:

- `npm test` in `node-bot`;
- launcher unit tests if added;
- `npm run pack` or `npm run dist` in `windows-launcher`;
- install on the current PC or a clean Windows test folder;
- first launch with no models present;
- downloading only the 4B primary model and starting Mana;
- retrying or skipping the 8B backup;
- refreshing manifest sources.

## Open Implementation Notes

The implementation plan should verify whether the packaged app can spawn the current backend without requiring a separate system Node.js install. If it cannot, the implementation should either package a Node runtime with Mana or adjust the backend launch path. This must be tested before calling the installer portable to another PC.
