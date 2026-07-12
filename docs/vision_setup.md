# Vision Setup (Local Image Understanding)

Mana can look at images — screenshots, photos, game UI — and talk about them
using a fully local vision model. Nothing leaves your machine.

## How it works

- Vision replies run through the persistent `llama-server` runtime with a
  multimodal GGUF model plus its `mmproj` projector file.
- The backend exposes `POST /vision/describe`, and `POST /reply` accepts an
  optional `image` field so image questions flow through the normal chat path
  (same persona, same session memory).
- Chat and vision share one llama-server process: asking about an image swaps
  the loaded model to the vision model, and the next text chat swaps back.
  Each swap costs one model load. The server auto-releases RAM/VRAM after 10
  minutes idle (`LLAMA_SERVER_IDLE_MS`).

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

## Launcher hotkey

With the launcher running, press **Ctrl+Alt+M** anywhere — including inside a
game — and Mana captures the primary display, looks at it with the vision
model, replies in the launcher, and speaks the answer through TTS.

- Change the shortcut with `MANA_VISION_HOTKEY` (Electron accelerator syntax,
  e.g. `Control+Shift+V`); set it to `off` to disable.
- If the shortcut is already taken by another app, the launcher logs a
  warning at startup and the hotkey stays inactive.
- The first press after a text chat swaps the loaded model to the vision
  model, which costs one model load; presses while a reply is still being
  generated are ignored.

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
