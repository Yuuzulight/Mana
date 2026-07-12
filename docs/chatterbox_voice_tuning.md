Chatterbox Voice Tuning

Voice bank (reference voices)
- Mana's cloned voices live in `tts-service\references\` (git-ignored — never
  commit a personal voice). Each `.wav` is a voice.
- The service resolves bare names: `CHATTERBOX_VOICE_REF=mana-mitsuki`
  switches Mana's voice without a full path. Default is `mana-mitsuki.wav`
  when present.
- `GET http://127.0.0.1:5010/voices` lists the bank and the active voice;
  a per-request `voice_ref` field overrides for one reply.
- Adding a voice: put a clean 10-20s mono WAV in `references\`, then run
  `venv\Scripts\python.exe normalize-references.py` (levels everything to
  -27 LUFS). Runtime loudness normalization is disabled in `service.py`
  because chatterbox-tts 0.1.7 turbo crashes on it with a float64 dtype
  error, so this offline pass keeps levels consistent.

Goal
- Mana should sound like an original anime little-sister assistant.
- Direction: youthful, crisp, natural, cool but soft, lightly teasing, and caring.
- Blend calm confidence with a gentle shy softness.
- Avoid the previous slightly robotic delivery.

Recommended starting preset

```powershell
$env:TTS_PROVIDER = "chatterbox"
$env:CHATTERBOX_MODEL = "turbo"
$env:CHATTERBOX_EXAGGERATION = "0.34"
$env:CHATTERBOX_CFG_WEIGHT = "0.34"
$env:CHATTERBOX_TEMPERATURE = "0.66"
```

Tuning notes
- Raise `CHATTERBOX_EXAGGERATION` for more anime emotion.
- Lower `CHATTERBOX_EXAGGERATION` if the voice gets too theatrical.
- Raise `CHATTERBOX_CFG_WEIGHT` if the voice loses stability.
- Lower `CHATTERBOX_CFG_WEIGHT` if the voice feels too stiff.
- Raise `CHATTERBOX_TEMPERATURE` for more variation.
- Lower `CHATTERBOX_TEMPERATURE` for cleaner, more consistent speech.
- For a softer voice, keep exaggeration and temperature moderate.
- For a sharper voice, raise exaggeration slightly.

Best next step
- Use a short clean original reference clip through `CHATTERBOX_VOICE_REF`.
- Keep it around 5-15 seconds with one speaker and minimal background noise.
