# image-generation

Generate or edit an image from a text description. Disabled by default
(Settings > Plugins).

## Backend resolution: local-first

- **Local** (preferred): set `MANA_IMAGE_BACKEND_URL` to a running local
  instance. Two API shapes are supported, picked via `MANA_IMAGE_BACKEND_TYPE`:
  - `automatic1111` (default when `MANA_IMAGE_BACKEND_URL` is set): the
    most common self-hosted Stable Diffusion/SDXL HTTP API --
    `POST {url}/sdapi/v1/txt2img` / `/sdapi/v1/img2img`.
  - `comfyui`: a ComfyUI instance at the same URL (issue #225). ComfyUI's
    API is fundamentally different (POST a whole workflow graph to
    `/prompt`, poll `/history/{id}`, fetch bytes via `/view`) -- see
    `docs/roadmap/issue-225-comfyui-backend.md` for why this isn't a
    simple third case in `createAutomatic1111Backend`'s shape. **txt2img
    only, legacy single-checkpoint workflow shape only** for this pass --
    requires `MANA_IMAGE_COMFYUI_CHECKPOINT` (ComfyUI's graph always names
    an exact checkpoint file, unlike Automatic1111 which uses whatever's
    already loaded). Split-loader models (FLUX, Qwen-Image, Mage-Flow) use
    a different graph shape and aren't supported yet -- tracked in issue
    #271.
  - Nothing is bundled or downloaded by this plugin beyond the one default
    ComfyUI workflow JSON (`workflows/comfyui-txt2img-checkpoint.json`); it
    speaks each API's existing contract to whatever you already have
    running.
- **External API** (opt-in only, never a default): set `MANA_IMAGE_API_KEY`
  (and optionally `MANA_IMAGE_API_BASE_URL`) to use an OpenAI-compatible
  images endpoint instead.
- If neither is set, `GET /health` reports this plugin as `unavailable`
  and `POST /image/generate` returns a 503 explaining what to configure.

## ComfyUI-specific environment variables

- `MANA_IMAGE_BACKEND_TYPE=comfyui` -- selects the ComfyUI backend against
  `MANA_IMAGE_BACKEND_URL`.
- `MANA_IMAGE_COMFYUI_CHECKPOINT` -- required. The exact checkpoint
  filename as it appears in your ComfyUI install's `models/checkpoints/`.
- `MANA_IMAGE_COMFYUI_TIMEOUT_MS` -- optional, default `120000`. How long
  to keep polling `/history` before giving up on a generation.

## Routes

- `POST /image/generate` -- `{ prompt, editImageBase64? }`. Saves the
  result(s) locally and returns `{ prompt, images: [{ id, path }] }`.
- `GET /images` -- list previously generated images.
- `GET /images/:id` -- fetch one generated image's PNG bytes.

## Displaying a generated image in chat

No new chat-UI code was needed for this: a reply containing
`![...](/images/<id>)` renders as a real `<img>` tag through the markdown
rendering issue #148 already added to both apps' chat logs.

## Verification note

No local Automatic1111/ComfyUI instance, GPU, or external API key was
available to exercise this against a real backend in the sessions that
built this -- `createAutomatic1111Backend`/`createOpenAiImagesBackend`/
`createComfyUiBackend` are all verified via injected/mocked `fetch` in
tests, matching each API's documented request/response shape (queue,
poll, fetch-bytes for ComfyUI), not a live generation.
