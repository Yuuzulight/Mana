# Mana product showreel

## Debut video (current)

A ~48s VTuber-debut-style self-introduction, 1920x1080/60fps, narrated by Mana
in her own voice (`debut_final.mp4`). Mana is the live Live2D model rendered by
the same runtime the Electron launcher uses (pixi-live2d-display), with lip-sync
driven by the narration audio. Screen order and timing live in `timeline.json`.

```powershell
# narration (needs ~4GB free RAM while the voice model loads)
tools\fish-speech\.venv-native\Scripts\python.exe marketing\showreel\narrate.py [line keys]
python pick_takes.py [line keys]   # whisper-checks each take, keeps the best per line
python mix_narration.py            # polish + music bed -> audio/narration-mix.wav

python key_poses.py                # Live2D pose renders -> avatar/*.png (expression tiles)
python build_debut.py              # debut/index.html + debut/data.json
python render_debut.py --stills    # one still per screen -> debut_stills/
python render_debut.py             # ~2.5 min -> debut_final.mp4
```

- Voice: Fish Speech S1-mini cloned from two expressive Mitsuki clips
  (`audio/refs/`); the app's own reference clip is the flattest one available.
  `mix_narration.py`'s `polish()` softens S1-mini's metallic codec edge.
- "Otsumana" is written in kana (おつ〜まな〜〜!!) so it's pronounced the
  Japanese way; its delivery was modelled on Gigi Murin's "Gii muriiin!".
- The Live2D model is Live2D's Hiyori sample (`hiyori_pro`), usable
  commercially by individuals and small businesses under Live2D's Free
  Material License.

## Original 23-beat abstract reel

A ~46s looping showreel: one morphing rounded shape, 23 story-beats synced to
the real detected beat grid of the audio track, no cuts, no cursor. Covers
Mana's full feature set -- plugins, add-ons, settings and hotkeys are shown
as clustered chip grids rather than one beat each.

## Pipeline

```powershell
pip install librosa soundfile playwright
python -m playwright install chromium

python analyze_beats.py audio/im-fine.mp3   # confirms the real tempo/beat grid
python trim_audio.py                        # trims the ~8s ambient lead-in to the real downbeat
python render_stills.py                     # 23 preflight stills, one per beat -- check before the full render
python render_full.py                       # ~13min: ~11,000 subframes (4 per output frame @ 60fps)
./composite.sh                               # ffmpeg: tmix motion blur, mux audio, -> showreel_final.mp4
```

## Track

**"I'm Fine" by Michael Ramir C.** — [Mixkit](https://mixkit.co/free-stock-music/mood/confident/),
free for commercial use, no attribution required. Detected tempo: 120.19 BPM
(target was "around 120"). The file has an ~8s ambient intro before its
confident beat pattern locks in at 8.022s -- `trim_audio.py` uses that
detected downbeat as the video's own t=0 rather than stretching the loop to
include the dead air.

## Timing

`BAR_DUR = 1.9969` (seconds per bar, from the real detected grid), 23 bars,
loop point `LOOP_T = BAR_DUR * 23 = 45.9287s` (hardcoded in `trim_audio.py`,
`render_stills.py`, `render_full.py` and `composite.sh` too -- keep all five
in sync). One bar = one story-beat, not
one musical beat (a bar's 4 real beats all land inside a single scene).

`showreel.html`'s `seek(t)` is a pure function -- a damped-spring engine
(closed-form step responses, no simulation state) drives every shape,
camera, and layer-opacity value from keyframe events, so it's safe to
evaluate at any `t` in any order. `LOOP_XFADE = 0.6s` gives the final
resolve->idle crossfade enough settle time to land within floating-point
noise of frame 0 -- the ordinary mid-video crossfades use a tighter 0.2s
since they don't need to hit an exact target, just read as a natural swap.

## Known-good vs. rough edges

Confirmed via `render_stills.py` + direct DOM/CTM inspection (not just
eyeballing): shape geometry, all layer opacities, and the loop-closing
frame match frame 0 to floating-point precision. Beat order lives in the
`order` array; layer windows derive from it automatically, but the bespoke
beats' custom `seek()` timing uses `barStart(i)` with the 0-based `order`
index -- an off-by-one there (1-based bar numbers) once blanked five beats. One real bug was caught
and fixed this way -- a chip-scale transform composed as
`translate(c)·scale(s)·translate(-c)` collapsed to a no-op identity
whenever `s === 1`, clipping the 4th plugin chip out of view for the whole
plugins beat; fixed to `translate(c)·scale(s)` since that chip's own
geometry is drawn at local-origin, not at the pivot point.
