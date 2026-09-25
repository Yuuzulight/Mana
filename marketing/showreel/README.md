# Mana product showreel

A ~16s looping showreel: one morphing rounded shape, 8 story-beats synced to
the real detected beat grid of the audio track, no cuts, no cursor.

## Pipeline

```powershell
pip install librosa soundfile playwright
python -m playwright install chromium

python analyze_beats.py audio/im-fine.mp3   # confirms the real tempo/beat grid
python trim_audio.py                        # trims the ~8s ambient lead-in to the real downbeat
python render_stills.py                     # 8 preflight stills, one per beat -- check before the full render
python render_full.py                       # ~3.5min: 3,836 subframes (4 per output frame @ 60fps)
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

`BAR_DUR = 1.9969` (seconds per bar, from the real detected grid), 8 bars,
loop point `LOOP_T = BAR_DUR * 8 = 15.9752s`. One bar = one story-beat, not
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
eyeballing): shape geometry, all 8 layer opacities, and the loop-closing
frame match frame 0 to floating-point precision. One real bug was caught
and fixed this way -- a chip-scale transform composed as
`translate(c)·scale(s)·translate(-c)` collapsed to a no-op identity
whenever `s === 1`, clipping the 4th plugin chip out of view for the whole
plugins beat; fixed to `translate(c)·scale(s)` since that chip's own
geometry is drawn at local-origin, not at the pivot point.
