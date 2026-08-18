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

- TTS providers (Kokoro, Fish Speech, GPT-SoVITS)
  - Some integrations rely on external services or binaries. See their docs for
    licensing and usage restrictions.

- Other NPM dependencies
  - See each package's package.json for license details.

Note: The presence of a dependency in this list does not imply distribution
or bundling in this repo. This project intentionally keeps large binaries and
model weights out of source control; please follow the docs to download and
install required artifacts.

- pixi.js (npm)
  - MIT license. Bundled via npm in `windows-launcher` and `desktop-client`
    for the built-in Live2D avatar renderer.

- pixi-live2d-display (npm)
  - MIT license. Bundled via npm in `windows-launcher` and `desktop-client`;
    renders Live2D Cubism models inside the avatar UI.

- Live2D Cubism Core (live2dcubismcore.min.js)
  - Proprietary — Live2D Proprietary Software License Agreement. NOT
    distributed in this repository. Fetched from Live2D's official CDN by
    `npm run fetch-live2d-core` in `windows-launcher` and `desktop-client`
    and kept git-ignored. Use is subject to Live2D's terms:
    https://www.live2d.com/en/terms/

- Live2D avatar model files (`windows-launcher/avatar/model/`,
  `desktop-client/avatar/model/`)
  - Personal/proprietary artwork, git-ignored. See LICENSE-ARTWORK. The
    model currently loaded in `desktop-client` is a temporary testing
    placeholder, not the final avatar — see
    `desktop-client/AVATAR_NOTICE.md` for the character's real-world IP
    attribution (miHoYo/HoYoverse).

- SearXNG (tools/searxng, git-ignored, fetched by tools/setup-searxng.ps1)
  - AGPL-3.0 license. Runs as a separate local process; Mana's backend talks
    to it only over localhost HTTP, so this does not affect the license of
    Mana's own code. See https://github.com/searxng/searxng for terms.

- GPT-SoVITS (tools/gpt-sovits, git-ignored, downloaded per docs/gpt_sovits_setup.md)
  - MIT license. Trial voice-cloning provider running as a separate local
    process (Windows self-contained package incl. its own Python runtime);
    Mana's backend talks to it only over localhost HTTP. See
    https://github.com/RVC-Boss/GPT-SoVITS for terms.

What the built installer adds back in (issue #363)
--------------------------------------------------

The notes above describe this *repository*, which deliberately excludes
large binaries and model weights. The `desktop-client` installer is a
different artifact and bundles more than the repo contains.

- SearXNG (`tools/searxng`) is bundled into the desktop-client installer via
  electron-builder `extraResources`, and is licensed **AGPL-3.0**. It is
  gitignored and untracked here, so the repository distributes no AGPL code
  -- but an installer built from a working checkout does.

  SearXNG runs as a separate process reached over HTTP on localhost, so this
  is mere aggregation rather than a derivative work: Mana's own Apache-2.0
  licensing is unaffected. Distributing it does carry AGPL obligations for
  that component -- ship the licence text, offer corresponding source, and
  state whether it was modified. The copy here is unmodified upstream, with
  Mana's configuration kept outside it in `tools/mana-searxng-settings.yml`.

- Also bundled: `node-bot` and `plugins` (Mana's own, Apache-2.0), an
  official Node.js binary (MIT), `tts-service` (Mana's own wrappers; heavy
  dependencies install at runtime rather than being bundled), and a
  portable Python runtime.

- `windows-launcher` declares no `extraResources`, so its installer is not
  affected.

Model weights -- GGUF, whisper, and the TTS voices -- are never bundled by
either installer. Their licences (including the non-commercial terms on
S1-mini and S2-Pro) govern the user's own copies and do not constrain the
installer.

Full analysis: `docs/roadmap/issue-363-installer-licensing-audit.md`.
