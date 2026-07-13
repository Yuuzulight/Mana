Fish Speech TTS

Mana can optionally call a local Fish Speech server as a TTS provider.

Recommended checkpoint: S1-mini
- Model: https://huggingface.co/fishaudio/s1-mini
- 0.5B parameters (a distilled version of Fish Audio's larger S1 model) —
  small enough to run comfortably on an 8GB-VRAM GPU, unlike Fish Audio's
  newer S2 Pro (5B params, ~10GB of BF16 weights alone; see
  docs/roadmap notes on issue #65 if that's ever revisited on stronger
  hardware).
- Gated on Hugging Face: you must accept the model's terms (sharing
  contact info, agreeing not to use it for DMCA-violating purposes)
  before you can download the weights.
- License: CC-BY-NC-SA-4.0 — non-commercial use only, share-alike,
  attribution required. Fine for personal use; do not distribute a
  commercial build of Mana with this checkpoint bundled.
- Supports emotion/tone markers in the input text (e.g. `(angry)`,
  `(whispering)`, `(laughing)`) and voice cloning via a reference
  sample — see `FISH_TTS_REFERENCE_ID` below.

Reference
- Fish Speech repository (serves the `/v1/tts` API Mana expects, via
  `tools/api_server.py`): https://github.com/fishaudio/fish-speech
- S1-mini model card: https://huggingface.co/fishaudio/s1-mini

Important notes
- Fish Speech is heavier than Kokoro and Chatterbox.
- The official setup path is separate from Mana and may require WSL/Linux plus a strong CUDA GPU.
- Keep Kokoro as fallback until Fish Speech quality and latency are verified on this machine.

Mana environment variables
- `$env:TTS_PROVIDER = "fish"`
- `$env:FISH_TTS_URL = "http://127.0.0.1:8080"`
- `$env:FISH_TTS_FALLBACK_PROVIDER = "kokoro"`
- `$env:FISH_TTS_REFERENCE_ID = "your-reference-id"` if you have a saved Fish Speech reference voice.
- `$env:FISH_TTS_API_KEY = "your-token"` if your Fish Speech server requires a bearer token.

Expected Fish Speech server
- Mana calls `POST /v1/tts` on `FISH_TTS_URL`.
- Mana expects the server to return audio bytes.
- Mana uses Kokoro or Chatterbox fallback if Fish Speech fails, unless `FISH_TTS_FALLBACK_PROVIDER=none`.

Quick test
- Start Fish Speech separately using its official instructions.
- Start Mana with `TTS_PROVIDER=fish`.
- Call Mana's backend synth endpoint:

```powershell
$body = @{ text = "Fish Speech test." } | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:5005/synthesize" -Method Post -ContentType "application/json" -Body $body -OutFile "$env:TEMP\mana-fish-test.wav"
```

Fallback behavior
- `FISH_TTS_FALLBACK_PROVIDER=kokoro` uses Kokoro if Fish Speech is unavailable.
- `FISH_TTS_FALLBACK_PROVIDER=chatterbox` uses Chatterbox if Fish Speech is unavailable.
- `FISH_TTS_FALLBACK_PROVIDER=none` makes Fish failures visible immediately.
