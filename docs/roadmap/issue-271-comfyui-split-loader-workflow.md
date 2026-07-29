# Issue 271: ComfyUI Split-Loader Workflow Support

Status: Scoped, not yet implemented. Tracks
[GitHub issue #271](https://github.com/Yuuzulight/Mana/issues/271).
Depends on #225 landing first (see
[issue-225-comfyui-backend.md](issue-225-comfyui-backend.md)).

## Background

Split out of #225 after evaluating `Comfy-Org/Mage-Flow` (Microsoft's 4B
MIT-licensed native-resolution image/edit model -- see
[[mana-mage-flow-image-candidate]] in memory) as a concrete target. #225's
original scope assumed one bundled "stock nodes only" workflow JSON would
generically cover ComfyUI installs. It doesn't -- there are two
incompatible **stock**-node graph shapes in common use, and Mage-Flow needs
the one #225 wasn't scoped for.

## The two shapes

- **Legacy single-checkpoint** (SD1.5/SDXL-era, what #225 covers):
  `CheckpointLoaderSimple` loads UNet+CLIP+VAE together in one file ->
  `CLIPTextEncode` -> `KSampler` -> `VAEDecode` -> `SaveImage`.
- **Split-loader** (FLUX/Qwen-Image/Mage-Flow-era, this issue): the
  checkpoint ships as separate files, loaded by separate stock nodes --
  `UNETLoader` (`diffusion_models/`), `CLIPLoader` (`text_encoders/`, a
  model-type parameter selects the encoder architecture -- Mage-Flow needs
  `qwen3vl_4b_bf16.safetensors` here), `VAELoader` (`vae/`) -- then the
  same `CLIPTextEncode` -> `KSampler` -> `VAEDecode` -> `SaveImage` tail.

Both shapes use only core ComfyUI nodes (no custom-node install required),
so #225's "stock nodes only" filter doesn't disambiguate them -- a single
bundled workflow only covers one shape; pointed at the other, it fails
outright (missing checkpoint file) or silently loads the wrong thing.

## Proposed design

- Bundle a second workflow JSON:
  `plugins/image-generation/workflows/comfyui-txt2img-split.json`
  (split-loader shape), alongside #225's
  `comfyui-txt2img-checkpoint.json`.
- Add `MANA_IMAGE_COMFYUI_WORKFLOW` env var (`checkpoint` default, or
  `split`) to `index.js`'s backend resolution to pick which bundled graph
  `createComfyUiBackend()` uses. Explicit env var, not auto-detection --
  ComfyUI doesn't expose "what shape is your loaded model" cheaply over the
  API, and guessing wrong silently is worse than asking the user to say
  which they have.
- The split workflow's `CLIPLoader` model-type parameter needs to match
  whatever text encoder is actually in use (`qwen3vl_4b_bf16.safetensors`
  for Mage-Flow specifically, but a different encoder for other
  split-loader models like FLUX) -- document this as a configuration point
  in the workflow JSON's substitution comment rather than hardcoding
  Mage-Flow, so the same graph shape serves other split-loader models
  later without a code change.
- Tests: same injected/mocked-`fetch` pattern already used for
  `createAutomatic1111Backend` and #225's checkpoint-shape backend -- not a
  live ComfyUI instance (no local ComfyUI/GPU available to exercise this
  against for real).

## Out of scope for this pass

- img2img/editing via the split-loader graph (`LoadImage` node etc.) --
  txt2img only first, matching #225's own scope cut.
- A model-type dropdown/picker UI for the `CLIPLoader` parameter -- env var
  only for this pass.
- Auto-discovering the user's installed checkpoints/text-encoder files --
  "bring your own configured ComfyUI instance," same philosophy as #225
  and the existing Automatic1111 support.

## Open questions

- Poll interval/timeout for `/history/{id}` -- Mage-Flow's own published
  numbers (~0.6s/image on its 4-step Turbo variant, but ~18-20GB peak
  memory in bf16 on an A100) suggest real timing on pre-upgrade local
  hardware could be much slower than cloud-GPU numbers; the default
  shouldn't be tuned to the fast case.
- Whether to accept a user-supplied custom workflow JSON path as a third
  option (beyond `checkpoint`/`split`) once both bundled shapes are
  verified working -- deferred until then, same reasoning #225 gives for
  not scoping an escape hatch before the common paths are proven.
