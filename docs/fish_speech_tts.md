Fish Speech TTS

Mana can optionally call a local Fish Speech server as a TTS provider.

Reference
- Fish Speech repository: https://github.com/fishaudio/fish-speech

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
