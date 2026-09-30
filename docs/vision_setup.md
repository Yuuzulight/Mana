# Vision Setup (Local Image Understanding)

Mana can look at images — screenshots, photos, game UI — and talk about them
using a fully local vision model. Nothing leaves your machine.

## How it works

- Vision replies run through the persistent `llama-server` runtime with a
  multimodal GGUF model plus its `mmproj` projector file.
- The backend exposes `POST /vision/describe`. `POST /reply` and
  `POST /reply/stream` accept `image` (or `images`), and an image turn goes
  through the normal chat path: same persona, session history, memory and
  tools (#679).
- If `LLAMA_MODEL` and `LLAMA_VISION_MODEL` point at the **same**
  natively-multimodal model (some newer models, e.g. Qwen3.5, understand
  both text and images from one set of weights, unlike Qwen3 which needed
  a separate `-VL` variant), images go straight into the chat request. The
  chat llama-server starts without the mmproj; the first image restarts it
  with the mmproj (one reload), and later image and text turns reuse it.
  After `MANA_VISION_IDLE_MS` (default 10 minutes) without an image it
  restarts without the mmproj again, once no reply is in progress; a
  watched game starting does that straight away (#872).
- If they're different files, the vision model first describes the image
  (a swap to the vision model), then the chat model answers from that
  description (a swap back). Each swap costs one model load.
- The server auto-releases RAM/VRAM after 10 minutes idle either way
  (`LLAMA_SERVER_IDLE_MS`).

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
$env:LLAMA_VISION_MMPROJ = "C:\ManaAI\Mana\tools\llama\gguf-models\mmproj-Qwen3.5-9B-Q8_0.gguf"
```

Use the Q8_0 mmproj. On Qwen3.5-9B it read 8 test images as accurately as
F16 at +842 MiB VRAM instead of +1,126 MiB (its `ffn_down` tensors stay F16
because their width isn't a multiple of 32). When the mmproj is
auto-detected, a `*-Q8_0.gguf` one is preferred over F16.

Worth doing only if you've actually verified the model's vision quality
holds up -- don't assume a chat model's multimodal tag means its vision
performance matches a dedicated vision model without checking. In Mana's
own case, Qwen3.5-9B was benchmarked against both Qwen3-VL-4B and Gemma 4
E4B on real image-description tasks before this became the default; see
`docs/roadmap/README.md` for that comparison.

## Launcher hotkey

With the launcher running, press **Ctrl+Alt+Shift+M** (**Ctrl+Alt+M** in the Electron launcher) anywhere — including inside a
game — and Mana captures the primary display, looks at it with the vision
model, replies in the launcher, and speaks the answer through TTS.

- Change the shortcut with `MANA_VISION_HOTKEY` (Electron accelerator syntax,
  e.g. `Control+Shift+V`); set it to `off` to disable.
- If the shortcut is already taken by another app, the launcher logs a
  warning at startup and the hotkey stays inactive.
- The first press after a text chat swaps the loaded model to the vision
  model (one model load). With chat and vision consolidated onto the same
  model, only the first image after startup or an idle unload costs one
  reload (to add the mmproj); presses while a reply is
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
