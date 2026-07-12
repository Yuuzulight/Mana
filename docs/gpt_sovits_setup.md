# GPT-SoVITS (Trial Voice Provider)

GPT-SoVITS is a trial alternative to Chatterbox for Mana's voice. It's the
model most of the anime/VTuber voice-cloning community actually uses, and
can be a better stylistic fit for an anime-character voice than Chatterbox.
It runs entirely locally, alongside Chatterbox and Kokoro — nothing is
removed, and switching back is one environment variable.

## Setup

`tools\gpt-sovits\` is git-ignored (it's an ~15-20 GB self-contained
package), so set it up once per machine:

```powershell
cd C:\ManaAI\Mana\tools
.\setup-gpt-sovits.ps1
```

This downloads the official Windows package (V2ProPlus — the fastest
current architecture, important for a live voice companion, and what
GPT-SoVITS's own public demo runs), which bundles its own Python runtime
and pretrained base models, so none of GPT-SoVITS's normal pip/conda setup
is needed. It also points the default inference config at V2ProPlus (the
package ships pointed at plain V2).

Extraction needs real 7-Zip (the package uses a BCJ2-compressed section
that Python's `py7zr` cannot read); the script installs it via `winget` if
missing, which may prompt for admin approval once.

## Preparing a reference voice

GPT-SoVITS clones from a short reference clip **and an exact transcript**
of what's said in it — an inaccurate transcript measurably hurts output
quality, more so than for Chatterbox. A 5-15 second clean clip works well.

1. Pick a short segment of the recording with clear, unaccompanied speech.
2. Get its exact transcript. The most reliable way is Mana's own local
   Whisper:
   ```powershell
   cd C:\ManaAI\Mana
   tools\whisper\Release\whisper-cli.exe -m tools\whisper\models\ggml-tiny.en.bin -f your-clip.wav -otxt -of transcript
   ```
   Read the output — Whisper's tiny model can occasionally hallucinate
   (e.g. printing "(speaking in foreign language)") on stylized or
   effects-heavy audio; if that happens, transcribe by ear instead of
   trusting a bad automatic transcript.
3. Save the clip as a plain 16-bit PCM WAV under `tts-service\references\`
   (the same folder Chatterbox's voice bank uses).

## Configuration

```powershell
$env:TTS_PROVIDER = "gpt_sovits"
$env:GPT_SOVITS_REF_AUDIO = "C:\ManaAI\Mana\tts-service\references\gpt-sovits-mitsuki.wav"
$env:GPT_SOVITS_PROMPT_TEXT = "In a quiet village where the sky brushes the fields in hues of gold, young Mia discovered a map leading to forgotten treasures."
$env:GPT_SOVITS_PROMPT_LANG = "en"   # language spoken in the reference clip
```

Other variables:

- `GPT_SOVITS_TTS_URL` — default `http://127.0.0.1:9880`.
- `GPT_SOVITS_TTS_FALLBACK_PROVIDER` — default `kokoro`. GPT-SoVITS is the
  heaviest voice option (full pretrained checkpoints, largest VRAM
  footprint of the three providers); if it fails to load or answer, Mana
  falls back automatically instead of going silent. Set to `none` to
  disable the fallback.
- `GPT_SOVITS_TEXT_LANG` — normally leave unset. Without it, every reply's
  target language is auto-detected from its text and mapped to the code
  GPT-SoVITS expects (see **Multi-language support** below). Setting this
  forces every request to that one code and skips detection entirely.

## Multi-language support

GPT-SoVITS's cross-lingual synthesis (same cloned voice, different target
language) only covers a fixed set of languages, regardless of GPT-SoVITS
version: **English, Chinese, Japanese, Korean** (`GPT_SoVITS/text/cleaner.py`'s
`language_module_map`). Mana auto-detects each reply's language and:

- Routes English/Chinese/Japanese/Korean text to GPT-SoVITS, so it keeps
  Mana's cloned voice identity across those four languages from the single
  English reference clip.
- Routes anything else (German, Russian, Malay, Spanish, ...) straight to
  the fallback provider (Kokoro by default), which has its own voice and
  per-language profiles for those — see `DEFAULT_KOKORO_LANGUAGE_PROFILES`
  in `node-bot/tts-runtime.js`. This is automatic; GPT-SoVITS is never even
  called for a language it can't speak.

This means with `TTS_PROVIDER=gpt_sovits` and Kokoro running alongside (the
launcher does this by default), Mana can speak all of English, Chinese,
Japanese, Korean, German, Russian, and Malay — just with two different
voices depending on the language of that specific reply.

The launcher starts GPT-SoVITS automatically when `TTS_PROVIDER=gpt_sovits`
and keeps Kokoro warm alongside it as the fallback voice (same pattern as
Chatterbox). Set `MANA_START_KOKORO_FALLBACK=0` to skip that.

## Switching back

```powershell
$env:TTS_PROVIDER = "chatterbox"   # or "kokoro"
```

Restart the launcher. GPT-SoVITS's process only starts when it's the
selected provider, so leaving it configured but unused costs nothing at
runtime — only the disk space of the install.

## Notes

- First reply after starting pays a model-load cost (checkpoints load into
  VRAM); subsequent replies are fast.
- Reference clip and prompt text quality matter more here than for
  Chatterbox — if the cloned voice sounds off, try a cleaner/shorter
  reference clip before assuming the model itself is the problem.
- The trial reference clip and transcript shipped with this setup are cut
  from Mana's Mitsuki source recording (the same one used for her default
  Chatterbox voice), for a consistent voice identity across providers.

## Known issue: silent audio despite HTTP 200 (fixed by the launcher)

GPT-SoVITS's `TTS.py` prints a Chinese debug line on every inference call.
Windows' console defaults to the cp1252 codepage, which cannot encode those
characters, so the `print()` throws `UnicodeEncodeError`. GPT-SoVITS's own
except-block treats this as a fatal inference error and — by design, to
avoid leaking GPU memory — falls back to yielding exactly **one second of
digital silence** instead of raising an HTTP error. The response is still
`200 OK` and a structurally valid WAV file, so nothing downstream (Mana's
backend, this doc's own earlier verification) can tell the difference
without checking the audio's actual amplitude.

The launcher works around this by starting GPT-SoVITS with
`PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`, which makes the print succeed
so real inference actually runs. If you ever start GPT-SoVITS by hand
outside the launcher, set those two variables first — otherwise every
reply will "succeed" while producing no sound.

To verify audio is real (not silent) yourself:

```powershell
cd C:\ManaAI\Mana\tts-service
.\venv\Scripts\python.exe -c "import soundfile as sf, numpy as np; a,sr=sf.read('path\to\file.wav'); print('rms=%.4f' % np.sqrt((a.astype(np.float64)**2).mean()))"
```

An `rms` of `0.0000` means silence regardless of a valid WAV header.
