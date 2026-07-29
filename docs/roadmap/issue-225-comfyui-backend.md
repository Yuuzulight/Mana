# Issue 225: ComfyUI Backend for Image Generation

Status: Scoped, not yet implemented. Tracks
[GitHub issue #225](https://github.com/Yuuzulight/Mana/issues/225).

## Background

The existing [`image-generation`](../../plugins/image-generation/) plugin
(issue #149, off by default) only speaks the Automatic1111 WebUI API
(`POST {baseUrl}/sdapi/v1/txt2img` / `/sdapi/v1/img2img`). Newer/optimized
image models increasingly ship ComfyUI-first or ComfyUI-only -- issue #225
was opened after looking at a quantized Krea 2 build shipped as ComfyUI
custom nodes, and reconfirmed 2026-07-29 while evaluating
`Comfy-Org/Mage-Flow` (Microsoft's 4B MIT-licensed native-resolution
image/edit model -- see [[mana-mage-flow-image-candidate]] in memory) as a
concrete target.

## Current architecture (unchanged, for context)

- `image-generation.js`: `createImageGenerationStore()` takes an injected
  `backend` function shaped `({prompt, editImageBase64}) => Promise<{imagesBase64: string[]}>`.
- `createAutomatic1111Backend({baseUrl})` and `createOpenAiImagesBackend({apiKey, baseUrl})`
  are the two existing implementations of that shape.
- `index.js`'s `resolveBackend(env)` picks Automatic1111 if
  `MANA_IMAGE_BACKEND_URL` is set, else the OpenAI-compatible external API
  if `MANA_IMAGE_API_KEY` is set, else null (503 on `/image/generate`).

## Why this isn't a drop-in third backend

1. **You POST a whole workflow graph** to `/prompt` (nodes + connections),
   not a flat params object -- getting the prompt text in means
   string/JSON-substituting a specific node's input field in a bundled
   template graph.
2. **Results aren't synchronous.** You get a `prompt_id`, then poll
   `/history/{prompt_id}` (simpler/more testable than the `/ws` websocket
   for this pass) until it reports done, then fetch PNG bytes via `/view`.
3. **The workflow template is a real dependency**, and has to use node
   types actually present in the target install.

## Split from this issue: #271

While refining this scope (2026-07-29), evaluating `Comfy-Org/Mage-Flow` as
a concrete target surfaced a real gap: point 3 above assumed avoiding
*model-specific custom nodes* (e.g. Krea2-SVDQuant's bespoke nodes) was
enough to make one bundled workflow generically compatible. It isn't --
there are two different **stock**-node ComfyUI graph shapes in common use
(a legacy single-checkpoint shape and a split-loader shape that
FLUX/Qwen-Image/Mage-Flow-style models need), and they aren't
interchangeable. Both use only core nodes, so "stock nodes only" doesn't
disambiguate them.

Rather than growing this issue's scope, that gap is split out to
**[#271](https://github.com/Yuuzulight/Mana/issues/271)**
(`docs/roadmap/issue-271-comfyui-split-loader-workflow.md`), which depends
on this issue landing first. **This issue (#225) stays scoped to the
legacy single-checkpoint shape only** -- `CheckpointLoaderSimple` ->
`CLIPTextEncode` -> `KSampler` -> `VAEDecode` -> `SaveImage` -- since
that's the original ask (a working ComfyUI backend for the common case)
and doesn't need to block on the split-loader work to be useful on its
own.

## Proposed design

- `createComfyUiBackend({ baseUrl, workflowTemplate, fetchImpl, wsImpl })`
  in `image-generation.js`, matching the existing backend function shape.
- Bundle one default workflow JSON,
  `plugins/image-generation/workflows/comfyui-txt2img-checkpoint.json`
  (legacy single-checkpoint shape), with the target node ids for prompt
  substitution documented in a comment at the top of the backend function.
- `index.js`: add `MANA_IMAGE_BACKEND_TYPE` (`"automatic1111"` default when
  `MANA_IMAGE_BACKEND_URL` is set, `"comfyui"` to select the new backend
  against the same URL) since a bare URL alone doesn't disambiguate which
  API shape is behind it. Update `resolveBackend()`, `getHealth()`, and the
  plugin's `description` accordingly.
- Tests follow the exact pattern already used for
  `createAutomatic1111Backend`/`createOpenAiImagesBackend`: injected/mocked
  `fetch` (and a minimal mocked poll response), not a live ComfyUI
  instance -- same verification gap the existing plugin already has and
  documents in its README.

## Out of scope for this pass

- img2img/editing via ComfyUI (`LoadImage` node etc.) -- txt2img only
  first.
- Websocket-based progress/streaming -- poll `/history` instead, simpler
  and synchronous-shaped like the existing two backends.
- **Split-loader graph shape (FLUX/Qwen-Image/Mage-Flow-style models)** --
  tracked separately in #271, since it needs a second bundled workflow and
  a workflow-shape selector, not just a config value on this backend.
- Any Krea2-SVDQuant-specific nodes/checkpoints -- the bundled workflow
  targets stock ComfyUI node types so it works against whatever checkpoint
  the user has loaded, not one specific quantized model.
- Auto-discovering/listing the user's installed custom nodes or available
  checkpoints -- the user points `MANA_IMAGE_BACKEND_URL` at their own
  already-configured ComfyUI instance, same "bring your own backend"
  philosophy as the existing Automatic1111 support.

## Open questions

- Poll interval/timeout for `/history/{id}` -- needs a sensible default
  that won't hang the request forever on a slow/large model, but also
  won't give up on a legitimately slow generation.
- Whether `MANA_IMAGE_BACKEND_TYPE` is the right name/shape, versus e.g.
  inferring it from a `comfyui://` URL scheme -- leaning toward the
  explicit env var since it's harder to get wrong silently.
