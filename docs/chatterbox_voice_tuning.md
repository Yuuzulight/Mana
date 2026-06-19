Chatterbox Voice Tuning

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
