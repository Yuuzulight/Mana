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
