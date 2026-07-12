Third-party components and models used by Mana

This file lists notable third-party components, binaries, and model artifacts
that the project references. Many of these are governed by their own
licenses and must be obtained separately and used according to their terms.

Common items referenced by Mana:

- whisper.cpp / whisper.cpp binaries
  - Not distributed in this repo. Obtain from the upstream project and follow
    its license and usage terms.

- llama.cpp / GGUF models
  - Model weights (GGUF) are not included and are subject to the model
    provider's license. You must obtain model files separately and comply with
    their terms.

- FAISS
  - Native binding may be required for performance. Follow FAISS's license and
    installation instructions if you choose to enable it.

- TTS providers (Kokoro, Chatterbox, Fish Speech)
  - Some integrations rely on external services or binaries. See their docs for
    licensing and usage restrictions.

- Other NPM dependencies
  - See each package's package.json for license details.

Note: The presence of a dependency in this list does not imply distribution
or bundling in this repo. This project intentionally keeps large binaries and
model weights out of source control; please follow the docs to download and
install required artifacts.

- pixi.js (npm)
  - MIT license. Bundled via npm in `windows-launcher` for the built-in
    Live2D avatar renderer.

- pixi-live2d-display (npm)
  - MIT license. Bundled via npm in `windows-launcher`; renders Live2D
    Cubism models inside the avatar window.

- Live2D Cubism Core (live2dcubismcore.min.js)
  - Proprietary — Live2D Proprietary Software License Agreement. NOT
    distributed in this repository. Fetched from Live2D's official CDN by
    `npm run fetch-live2d-core` in `windows-launcher` and kept git-ignored.
    Use is subject to Live2D's terms: https://www.live2d.com/en/terms/

- Live2D avatar model files (`windows-launcher/avatar/model/`)
  - Personal/proprietary artwork, git-ignored. See LICENSE-ARTWORK.

- SearXNG (tools/searxng, git-ignored, fetched by tools/setup-searxng.ps1)
  - AGPL-3.0 license. Runs as a separate local process; Mana's backend talks
    to it only over localhost HTTP, so this does not affect the license of
    Mana's own code. See https://github.com/searxng/searxng for terms.

- GPT-SoVITS (tools/gpt-sovits, git-ignored, downloaded per docs/gpt_sovits_setup.md)
  - MIT license. Trial voice-cloning provider running as a separate local
    process (Windows self-contained package incl. its own Python runtime);
    Mana's backend talks to it only over localhost HTTP. See
    https://github.com/RVC-Boss/GPT-SoVITS for terms.
