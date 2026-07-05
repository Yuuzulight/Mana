Large assets (models & audio)

This repository intentionally keeps large binary assets (model weights, large audio test files) out of Git history to keep the repo small and fast to clone.

Downloader helper

Two downloader scripts are provided to fetch the required large assets into the local workspace. They require you to host the binary assets at a stable base URL (for example, a GitHub Release or S3 bucket).

Files that the downloader can fetch (default mapping)
- ggml-tiny.en.bin -> tools/whisper/models/ggml-tiny.en.bin
- test.wav -> tools/whisper/test.wav
- mana-younger-sister-voice-test.wav -> mana-younger-sister-voice-test.wav
- tts-english.wav -> tts-language-tests-single-voice/english.wav

PowerShell (Windows)
1. Set an environment variable pointing to your asset base URL (example uses a GitHub release URL):
   $env:ASSET_BASE_URL = 'https://github.com/your-user/Mana/releases/download/v1.0'
2. Run the downloader from the repo root:
   .\tools\download_large_assets.ps1 -BaseUrl $env:ASSET_BASE_URL -OutDir .

Bash (Linux / macOS)
1. Export ASSET_BASE_URL, or pass it as the first argument:
   export ASSET_BASE_URL=https://github.com/your-user/Mana/releases/download/v1.0
2. Run the downloader:
   ./tools/download_large_assets.sh "$ASSET_BASE_URL" .

Hosting assets
- Recommended: upload the binary assets to a GitHub Release attached to a tag for the repository.
  e.g. https://github.com/your-user/Mana/releases/tag/v1.0
- Alternative: use an S3 bucket, Google Cloud Storage, or any static file host and set ASSET_BASE_URL accordingly.

Security & integrity
- The downloader does not currently validate checksums. For extra safety, host a checksums file (SHA256) alongside the assets and extend the script to verify downloads.

If you'd like, I can:
- Add automatic checksum verification using a checksums manifest.
- Upload assets to a GitHub Release for you (I will need the files or a place to fetch them from).
- Add more assets to the default mapping.
