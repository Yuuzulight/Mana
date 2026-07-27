# Issue 149: Image Generation Tool

## Goal

Text-to-image and image-editing, local-first where practical, with an
external API only as an explicit opt-in fallback.

## A real constraint, disclosed up front

No GPU or model weights were available in the environment that built this
-- an actual local Stable Diffusion/SDXL/FLUX model could not be
installed or run to verify against. Raised to the user before building:
agreed to build the plugin against the **Automatic1111 WebUI API
contract** (the most common self-hosted local SD HTTP API --
`POST {baseUrl}/sdapi/v1/txt2img` / `/sdapi/v1/img2img`) as the
"local-first" integration point, verified via mocked HTTP calls rather
than a live generation. Whoever runs Mana points this at their own
already-running local instance; nothing is bundled or downloaded here.

## Status: Implemented (`plugins/image-generation/`, toggleable, off by default)

- **`image-generation.js`**: `createImageGenerationStore({imagesDir})` --
  same injectable-store pattern as `acp-memory-store.js`/`cron-scheduler.js`
  (an `imagesDir` option, not a fixed module constant, so tests don't
  write into node-bot's real data directory). `generateImage(prompt,
  {backend, editImageBase64})` truncates an overlong prompt, calls the
  injected backend, and saves each returned base64 image as a local PNG.
- **Two backend factories**: `createAutomatic1111Backend({baseUrl})` (the
  local path) and `createOpenAiImagesBackend({apiKey})` (opt-in external
  fallback, throws if no key is given -- it's never silently active).
  `index.js`'s `resolveBackend(env)` prefers the local one if
  `MANA_IMAGE_BACKEND_URL` is set, falls back to the external one only if
  `MANA_IMAGE_API_KEY` is set, and returns `null` (a clear 503 from the
  route) if neither is configured.
- **Routes**: `POST /image/generate`, `GET /images`, `GET /images/:id`.
- **Displaying a result in chat needed no new frontend code**: a reply
  containing `![...](/images/<id>)` already renders as a real `<img>` tag
  through the markdown pipeline issue #148 added to both apps' chat logs.
- **Toggle**: `category: "Creative"`, `defaultEnabled: false`.

## Finding: the issue's "apps already render images from vision" premise didn't hold

Same kind of audit-before-build check as several earlier issues this
batch: searched both apps' renderer.js for any `<img>` element creation at
all -- none existed. Vision support (`/models/vision-path`) is
configuration for *sending* an image to the model, not a display path for
receiving one back. This is why "reuse it" (the issue's original plan)
became "issue #148 already built the thing to reuse" once #148 landed
markdown rendering with real `<img>` support for free.

## Deliberate simplifications

- **No model picker UI.** Explicitly out of scope per the issue -- one
  working local integration point (Automatic1111's API shape), expand
  later if a second is actually wanted.
- **No video generation.** Explicitly out of scope per the issue.
- **Not wired into any tool-calling loop.** Same reasoning as issue #142 --
  the model-facing tool loop (`runToolAwareReply`) is single-tool,
  single-round today; this ships as a plain HTTP route a future UI or
  tool-calling extension can call, not force-fit into an interface that
  can't use it yet.

## Verified

- `plugins/image-generation/test/image-generation.test.js` (9 tests):
  backend-URL scheme validation, empty-prompt/no-backend/no-images
  rejection, prompt truncation, save-and-list round trip, and both backend
  factories' request shape (txt2img vs. img2img endpoint selection, bearer
  auth header, non-ok response surfaced as an error) verified against a
  mocked `fetch`.
- `plugins/image-generation/test/image-generation-capability.test.js` (5
  tests): the 503 when unconfigured, empty list on a fresh store, 404 for
  an unknown image, plugin metadata shape, and health reporting
  transitioning from unavailable to configured.
- `node-bot/test/health-components.test.js` (3 tests): updated snapshot
  for the new `imageGeneration` component key.
- `node-bot/test/server-routes.test.js` (62 tests): unaffected.
