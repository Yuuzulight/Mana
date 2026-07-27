# image-generation

Generate or edit an image from a text description. Disabled by default
(Settings > Plugins).

## Backend resolution: local-first

- **Local** (preferred): set `MANA_IMAGE_BACKEND_URL` to a running
  Automatic1111-compatible WebUI instance (the most common self-hosted
  Stable Diffusion/SDXL HTTP API -- `POST {url}/sdapi/v1/txt2img` /
  `/sdapi/v1/img2img`). Nothing is bundled or downloaded by this plugin;
  it speaks that API's existing contract to whatever you already have
  running.
- **External API** (opt-in only, never a default): set `MANA_IMAGE_API_KEY`
  (and optionally `MANA_IMAGE_API_BASE_URL`) to use an OpenAI-compatible
  images endpoint instead.
- If neither is set, `GET /health` reports this plugin as `unavailable`
  and `POST /image/generate` returns a 503 explaining what to configure.

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

No local Automatic1111 instance or external API key was available to
exercise this against a real backend in the session that built this --
`createAutomatic1111Backend`/`createOpenAiImagesBackend` are verified via
injected/mocked `fetch` in tests, matching each API's documented request/
response shape, not a live generation.
