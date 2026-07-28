Fish Speech Install Status

Working setup (as of 2026-07-19)
- Fish Speech submodule at `tools/fish-speech`, pinned (detached HEAD) to commit
  `781bf1cd7afef831fc58928a6444a2161449dae5` ("Finetune support of OpenAudio-S1
  (#1115)") -- the last commit before upstream's S2 changes replaced the
  tiktoken-based tokenizer loader with one that calls
  `transformers.AutoTokenizer.from_pretrained()`. That newer loader chokes on
  S1-mini's `config.json` (`model_type: dual_ar` isn't a registered
  Transformers architecture), so newer commits cannot serve S1-mini. Do not
  update this submodule past that point without re-verifying the tokenizer
  loads.
- WSL `uv` at `/home/user/.local/bin/uv`, Python 3.12.13 via `uv venv`.
- Venv at `tools/fish-speech/.venv`, synced with:
  `uv sync --extra cu128 --no-install-package pyaudio`
  (`pyaudio` wasn't installed since it isn't used by `tools/api_server.py`,
  only by the demo `tools/api_client.py`; skipping it is safe. A C compiler
  is now installed anyway -- see the performance note below -- so this is no
  longer a hard blocker if `pyaudio` is ever needed.)
- S1-mini weights downloaded (gated HF repo, needs a logged-in HF account
  that has accepted the license):
  `hf download fishaudio/openaudio-s1-mini --local-dir checkpoints/openaudio-s1-mini`
- `tools/start_fish_speech_wsl.sh` passes `--llama-checkpoint-path` and
  `--decoder-checkpoint-path` explicitly pointing at that checkpoint, since
  this build's own arg defaults point at `checkpoints/s2-pro`.

Hardware note
- Local GPU: NVIDIA GeForce RTX 3070 Ti, 8GB VRAM.
- Fish Speech's docs cite 24GB VRAM for inference generally, but S1-mini
  specifically runs comfortably here -- warm-up synthesis used ~4.9GB.
- Mana can fall back to Kokoro automatically (`FISH_TTS_FALLBACK_PROVIDER`
  defaults to `kokoro`) if S1-mini is ever unreachable.

Performance note (issue #213)
- `start_fish_speech_wsl.sh` now passes `--compile`. Measured on this
  machine: ~2.5 tokens/sec baseline vs ~31 tokens/sec steady-state with
  `--compile` -- roughly 12x, at negligible extra VRAM cost.
- `torch.compile` is lazy: the trace only fires on the first real
  generation *request*, not at process launch. Expect the first TTS reply
  after each (re)start of this service to take about 4 minutes; every
  reply after that is fast. Not yet surfaced anywhere in the UI (tracked
  separately, not built as part of #213).
- Requires a C compiler for Triton's codegen. If starting the service
  fails with "Failed to find C compiler", run once:
  `sudo apt-get update && sudo apt-get install -y build-essential`.

Known oddity
- Before pinning the commit above, the submodule's HEAD carried an extra
  commit ("feat: add PendingWritesPanel and intent hook for admin
  approvals") adding Mana-specific admin-approval UI files
  (`awesome_webui/src/components/PendingWritesPanel.tsx`,
  `awesome_webui/src/hooks/useManaIntent.ts`) that have nothing to do with
  Fish Audio's project -- looks like a prior session accidentally committed
  unrelated Mana work into this vendored submodule. That commit and an
  uncommitted edit to `awesome_webui/src/App.tsx` are preserved in git
  (stash + the original commit SHA, both still reachable) but are no longer
  on the checked-out HEAD.
