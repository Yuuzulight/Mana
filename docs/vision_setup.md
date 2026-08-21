# Vision Setup (Local Image Understanding)

Mana can look at images — screenshots, photos, game UI — and talk about them
using a fully local vision model. Nothing leaves your machine.

## How it works

- Vision replies run through the persistent `llama-server` runtime with a
  multimodal GGUF model plus its `mmproj` projector file.
- The backend exposes `POST /vision/describe`, and `POST /reply` accepts an
  optional `image` field so image questions flow through the normal chat path
  (same persona, same session memory).
- Chat and vision share one llama-server process. If they're different
  model files, asking about an image swaps the loaded model to the vision
  model, and the next text chat swaps back -- each swap costs one model
  load. If `LLAMA_MODEL` and `LLAMA_VISION_MODEL` point at the **same**
  natively-multimodal model (some newer models, e.g. Qwen3.5, understand
  both text and images from one set of weights, unlike Qwen3 which needed
  a separate `-VL` variant), there's no swap at all -- chat and vision
  share the already-loaded model. The server auto-releases RAM/VRAM after
  10 minutes idle either way (`LLAMA_SERVER_IDLE_MS`).

## Installing a vision model

Download a vision GGUF **and its matching mmproj file** into
`tools\llama\gguf-models\`. Mana auto-detects them (filenames containing
`vl`, `vision`, `llava`, `minicpm-v`, `moondream`, or `gemma-3`; mmproj files
are matched by the `mmproj` prefix).

Recommended for 8 GB VRAM (fits alongside a running game):

```powershell
cd C:\ManaAI\Mana\tools\llama\gguf-models
curl -L -O "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"
curl -L -O "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf"
```

Higher quality (needs ~6 GB VRAM free, better when not gaming):

```powershell
curl -L -O "https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf"
curl -L -O "https://huggingface.co/ggml-org/Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf"
```

## Explicit configuration (optional)

Auto-detection can be overridden:

```powershell
$env:LLAMA_VISION_MODEL = "C:\ManaAI\Mana\tools\llama\gguf-models\Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"
$env:LLAMA_VISION_MMPROJ = "C:\ManaAI\Mana\tools\llama\gguf-models\mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf"
```

Run `npm run doctor` in `node-bot` to confirm the vision model check.

### Consolidating chat + vision onto one natively-multimodal model

If your default chat model is natively multimodal, point `LLAMA_VISION_MODEL`
at the **same file** as `LLAMA_MODEL`, plus its mmproj -- this must be
explicit even if the model would otherwise be auto-detected as a chat
model, since its filename won't contain a vision-signaling token like
`vl`/`gemma-4` and so won't be picked up by auto-detection as a vision
candidate either:

```powershell
$env:LLAMA_MODEL = "C:\ManaAI\Mana\tools\llama\gguf-models\Qwen3.5-9B-Q4_K_M.gguf"
$env:LLAMA_VISION_MODEL = "C:\ManaAI\Mana\tools\llama\gguf-models\Qwen3.5-9B-Q4_K_M.gguf"
$env:LLAMA_VISION_MMPROJ = "C:\ManaAI\Mana\tools\llama\gguf-models\mmproj-Qwen3.5-9B-F16.gguf"
```

Worth doing only if you've actually verified the model's vision quality
holds up -- don't assume a chat model's multimodal tag means its vision
performance matches a dedicated vision model without checking. In Mana's
own case, Qwen3.5-9B was benchmarked against both Qwen3-VL-4B and Gemma 4
E4B on real image-description tasks before this became the default; see
`docs/roadmap/README.md` for that comparison.

## Launcher hotkey

With the launcher running, press **Ctrl+Alt+M** anywhere — including inside a
game — and Mana captures the primary display, looks at it with the vision
model, replies in the launcher, and speaks the answer through TTS.

- Change the shortcut with `MANA_VISION_HOTKEY` (Electron accelerator syntax,
  e.g. `Control+Shift+V`); set it to `off` to disable.
- If the shortcut is already taken by another app, the launcher logs a
  warning at startup and the hotkey stays inactive.
- The first press after a text chat swaps the loaded model to the vision
  model (one model load) unless chat and vision are consolidated onto the
  same model, in which case there's no swap; presses while a reply is
  still being generated are ignored.

## API usage

Describe an image directly:

```
POST http://localhost:5005/vision/describe
{ "image": "data:image/png;base64,....", "prompt": "What is on this screen?" }
```

Or attach an image to a normal chat reply (text optional; `sessionId` keeps
the exchange in Mana's conversation memory):

```
POST http://localhost:5005/reply
{ "text": "what am I looking at?", "image": "data:image/png;base64,....", "sessionId": "desktop" }
```

`image` accepts a data URL or raw base64 (PNG assumed). Responses return 503
with a hint when no vision model is installed.

## Notes

- OCR via `POST /screen/read` still exists and stays the cheaper option when
  you only need readable text; the vision model understands layout, icons,
  and pictures.
- Vision has no llama-cli fallback: if llama-server cannot start (e.g. VRAM
  exhausted mid-game), the request returns an error instead of silently using
  a text model.
