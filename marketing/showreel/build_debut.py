"""Builds the VTuber-debut video page: debut/index.html (every screen's layer,
laid out on an 800x450 logical stage scaled to 1920x1080) and debut/data.json
(screen/line timings from timeline.json, subtitles, and a per-frame mouth
curve taken from the narration clips). debut/engine.js animates it all from a
single seek(t); render_debut.py drives that frame by frame.
Run: python build_debut.py
"""

import itertools
import json
import math
import pathlib

import librosa
import numpy as np

from narrate import LINES

HERE = pathlib.Path(__file__).parent
OUT = HERE / "debut"
FPS = 60

ACCENT, INK, MUTED, PANEL, BORDER, GROUND = "#9d8ce0", "#ece8f4", "#a39cb5", "#221e2c", "#3a3450", "#17141f"
MANA_BUBBLE, USER_BUBBLE, ERR = "#2a2536", "#3a3560", "#e0707a"
SHAPE = (f"background: {PANEL}; border: 1px solid {BORDER}; box-sizing: border-box; "
         f"box-shadow: 0 10px 32px rgba(0,0,0,0.45), 0 0 48px rgba(157,140,224,0.12)")
MONO = "font-family: 'Geist Mono', ui-monospace, monospace"
DISPLAY = "font-family: Fraunces, Georgia, serif"
CARD = "left: 300px; right: 30px; top: 50%; transform: translateY(-54%)"  # right-hand card stage; Mana presents on the left
SUBTITLE = {"13-otsumana": "Otsumana~!"}  # on-screen text where it differs from the spoken script


def at(css, inner="", pop=None, fade=None, id=None):
    """Absolutely placed element. pop/fade = seconds after its screen starts to spring in."""
    attrs = (f' data-pop="{pop}"' if pop is not None else "") + (f' data-fade="{fade}"' if fade is not None else "") \
        + (f' id="{id}"' if id else "")
    return f'<div{attrs} style="position: absolute; {css}">{inner}</div>'


_crystal_ids = itertools.count()


def crystal(h=30):
    """Mana's crystal, from her hair-tie design (marketing/concept/DESIGN_NOTES.md): a slender
    needle-pointed shard, a pale lit face and a periwinkle face deepening to indigo, a glassy
    streak, a white rim and a soft blue glow. Same box and centre as before; the glow overflows it.
    Each copy gets its own gradient/filter ids so none depends on another screen's SVG."""
    n = next(_crystal_ids)
    return (f'<svg width="{h * 14 // 30}" height="{h}" viewBox="-7.47 -18 14.93 32" overflow="visible" aria-hidden="true"><defs>'
            f'<linearGradient id="crLit{n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3f5ff"/><stop offset="1" stop-color="#b3c8f6"/></linearGradient>'
            f'<linearGradient id="crShade{n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a3b3f6"/>'
            f'<stop offset="0.6" stop-color="#7684f5"/><stop offset="1" stop-color="#3d4fbf"/></linearGradient>'
            f'<filter id="crGlow{n}" x="-80%" y="-60%" width="260%" height="220%">'
            f'<feDropShadow dx="0" dy="0" stdDeviation="2.5" flood-color="#8fb4ff" flood-opacity="0.7"/></filter></defs>'
            f'<g filter="url(#crGlow{n})">'
            f'<path d="M0 -18 L-4.6 1 L0 14 Z" fill="url(#crLit{n})"/>'
            f'<path d="M0 -18 L4.6 1 L0 14 Z" fill="url(#crShade{n})"/>'
            f'<path d="M1.1 -10 L2.9 0 L1.4 5 Z" fill="#ffffff" opacity="0.45"/>'
            f'<path d="M0 -18 L-4.6 1 L0 14 L4.6 1 Z" fill="none" stroke="#ffffff" stroke-width="0.9" stroke-linejoin="round" opacity="0.95"/>'
            f'</g></svg>')


def sparkles(seed=0, n=14):
    """Four-point sparkles; engine.js twinkles each by its data-tw phase."""
    out = []
    for i in range(n):
        x, y, s = (i * 137 + seed * 53) % 780 + 10, (i * 89 + seed * 31) % 430 + 10, 3 + (i * 7 + seed) % 5
        k = s * .28
        out.append(f'<path data-tw="{(i * 1.7 + seed) % 6.28:.2f}" d="M{x} {y - s} L{x + k} {y - k} L{x + s} {y} L{x + k} {y + k} L{x} {y + s} '
                   f'L{x - k} {y + k} L{x - s} {y} L{x - k} {y - k} Z" fill="{INK if i % 3 else ACCENT}" opacity="0.3"/>')
    return at("inset: 0", f'<svg width="800" height="450" viewBox="0 0 800 450" aria-hidden="true">{"".join(out)}</svg>')


def label(text):
    return f'<div style="{MONO}; font-size: 11px; letter-spacing: 0.14em; color: {ACCENT}">{text}</div>'


def bubble(text, user=False, pop=None):
    p = f' data-pop="{pop}"' if pop is not None else ""
    if user:
        return (f'<div{p} style="align-self: flex-end; padding: 9px 13px; border-radius: 14px 14px 4px 14px; background: {USER_BUBBLE}; '
                f'border: 1px solid rgba(157,140,224,0.45); font-size: 13.5px; color: {INK}">{text}</div>')
    return (f'<div{p} style="display: flex; gap: 8px; align-items: flex-start">{crystal(20)}<div style="padding: 9px 13px; '
            f'border-radius: 14px 14px 14px 4px; background: {MANA_BUBBLE}; border: 1px solid {BORDER}; font-size: 13.5px; '
            f'line-height: 1.45; color: {INK}">{text}</div></div>')


def card(inner, extra="", pop=0.12):
    return at(f"{CARD}; {SHAPE}; border-radius: 20px; padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; {extra}",
              inner, pop=pop)


def screens(t_rel):
    """Layer markup per screen key. t_rel: {line key: seconds after its screen starts}."""
    L = {}
    rays = "".join(f'<line x1="400" y1="215" x2="{400 + 460 * math.cos(a):.0f}" y2="{215 + 460 * math.sin(a):.0f}" '
                   f'stroke="{ACCENT}" stroke-width="{2 if i % 2 else 1}" opacity="{0.35 if i % 2 else 0.18}"/>'
                   for i, a in enumerate(k * math.pi / 12 for k in range(24)))
    L["reveal"] = (
        at("inset: 0", f'<svg width="800" height="450" viewBox="0 0 800 450" aria-hidden="true">{rays}</svg>', id="rays")
        + at("inset: 0", f'<svg width="800" height="450" viewBox="0 0 800 450" aria-hidden="true">'
                         f'<circle cx="400" cy="215" r="150" fill="{ACCENT}" opacity="0.10"/><circle cx="400" cy="215" r="80" fill="{ACCENT}" opacity="0.16"/></svg>',
             id="glow")
        + sparkles(1, 22)
        + at("left: 379px; top: 170px", crystal(90), id="revealCrystal")
        + at("inset: 0; background: radial-gradient(circle at 50% 48%, #f1edff 0%, rgba(157,140,224,0.85) 22%, rgba(23,20,31,0) 60%)", id="flash"))
    title = "".join(f'<span data-pop="{0.2 + i * 0.09:.2f}" style="display: inline-block">{c}</span>' for i, c in enumerate("Mana"))
    L["name"] = (
        sparkles(2)
        + at("left: 300px; right: 30px; top: 50%; transform: translateY(-58%); display: flex; flex-direction: column; gap: 4px",
             f'<div style="display: flex; align-items: center; gap: 16px"><div data-pop="0.1">{crystal(56)}</div>'
             f'<div style="{DISPLAY}; font-size: 104px; font-weight: 500; line-height: 1; letter-spacing: 0.02em; color: {INK}">{title}</div></div>'
             f'<div data-pop="0.75" style="font-family: \'Noto Sans JP\', sans-serif; font-size: 30px; color: {ACCENT}; margin-left: 4px">マナ</div>'
             f'<div data-pop="1.0" style="font-size: 17px; color: {MUTED}; margin-top: 10px; margin-left: 4px">your desktop companion</div>'))
    L["nice"] = sparkles(3, 18)
    L["talk"] = sparkles(4) + card(label("VOICE CHAT") + bubble("“Hey Mana!”", user=True, pop=0.35)
                                   + bubble("Hi hi! What are we doing today?", pop=0.95))
    code_lines = "".join(f'<div style="height: 6px; width: {w}px; border-radius: 3px; background: {ERR if r else MUTED}; opacity: {0.9 if r else 0.35}"></div>'
                         for w, r in [(200, 0), (260, 0), (150, 0), (300, 1), (180, 0)])
    L["screen"] = sparkles(5) + card(
        label("SCREEN · Ctrl+Alt+M")
        + f'<div style="position: relative; background: #1e1a27; border: 1px solid {BORDER}; border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 9px">{code_lines}'
        + f'<div data-pop="0.45" style="position: absolute; left: 8px; top: 64px; width: 318px; height: 18px; border: 1.5px dashed {ACCENT}; border-radius: 5px; box-shadow: 0 0 18px rgba(157,140,224,0.4)"></div></div>'
        + bubble("Line 42 is getting an empty date.", pop=0.8))
    L["code"] = sparkles(6) + card(
        label("PROPOSED FIX")
        + f'<div style="font-size: 15px; font-weight: 600; color: {INK}">Handle a missing date</div>'
        + f'<div style="{MONO}; font-size: 12px; color: {MUTED}; background: rgba(236,232,244,0.05); padding: 6px 8px; border-radius: 6px">−  const due = parse(input.date);</div>'
        + f'<div data-pop="0.5" style="{MONO}; font-size: 12px; color: {INK}; background: rgba(157,140,224,0.16); padding: 6px 8px; border-radius: 6px">+  const due = input.date ? parse(input.date) : null;</div>'
        + f'<div style="display: flex; gap: 10px"><div id="approve" style="border-radius: 18px; padding: 8px 20px; background: {ACCENT}; color: {GROUND}; font: 600 13px Geist, system-ui, sans-serif">Approve</div>'
        + f'<div style="border: 1.5px solid {BORDER}; border-radius: 18px; padding: 8px 20px; color: {MUTED}; font: 13px Geist, system-ui, sans-serif">Reject</div></div>')
    game = ('<svg width="100%" height="100" viewBox="0 0 200 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">'
            '<rect width="200" height="100" fill="#2a2140"/><circle cx="150" cy="30" r="14" fill="#9d8ce0" opacity="0.5"/>'
            '<path d="M0 70 L40 40 L70 62 L110 32 L150 64 L200 50 L200 100 L0 100 Z" fill="#4a3a78"/></svg>')
    L["game"] = sparkles(7) + at(
        f"{CARD}; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px",
        f'<div data-pop="0.12" style="{SHAPE}; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column">{game}'
        f'<div style="padding: 10px 12px"><div style="font-size: 13.5px; font-weight: 500; color: {INK}">Game detected</div>'
        f'<div style="font-size: 12px; color: {MUTED}">she goes quiet, frees your GPU</div></div></div>'
        f'<div data-pop="1.75" style="{SHAPE}; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; position: relative">{game}'
        f'<div style="position: absolute; left: 8px; top: 8px; {MONO}; font-size: 10px; font-weight: 500; color: {GROUND}; background: {ERR}; padding: 2px 6px; border-radius: 3px">LIVE</div>'
        f'<div style="padding: 10px 12px"><div style="font-size: 13.5px; font-weight: 500; color: {INK}">VTube Studio · Wave</div>'
        f'<div style="font-size: 12px; color: {MUTED}">she co-hosts your stream</div></div></div>')
    nodes = ["Discord", "Phone", "Telegram", "Matrix", "Image Gen", "Web Access", "Browser", "Documents", "Obsidian", "Cron",
             "Video Watch", "MCP", "Stock Market", "FFXIV Market", "Job Search", "Short Video"]
    cx, cy = 235, 150
    pts = [(n, cx + (95 if i % 2 else 190) * math.cos(-math.pi / 2 + 2 * math.pi * i / len(nodes)),
            cy + (58 if i % 2 else 112) * math.sin(-math.pi / 2 + 2 * math.pi * i / len(nodes))) for i, n in enumerate(nodes)]
    svg = "".join(f'<g data-fade="{0.25 + i * 0.07:.2f}"><line x1="{cx}" y1="{cy}" x2="{x:.0f}" y2="{y:.0f}" stroke="{ACCENT}" stroke-width="0.8" opacity="0.3"/>'
                  f'<circle cx="{x:.0f}" cy="{y:.0f}" r="2.6" fill="{ACCENT}"/></g>' for i, (_, x, y) in enumerate(pts))
    labels = "".join(at(f"left: {x:.0f}px; top: {y + 5:.0f}px; transform: translateX(-50%); font-size: 11px; "
                        f"color: {INK if n in ('Discord', 'Phone') else MUTED}; white-space: nowrap", n, pop=round(0.3 + i * 0.07, 2))
                     for i, (n, x, y) in enumerate(pts))
    L["everything"] = sparkles(8) + at("left: 300px; top: 70px; width: 470px; height: 310px",
                                       f'<svg width="470" height="310" viewBox="0 0 470 310" aria-hidden="true" style="position: absolute; inset: 0">{svg}</svg>'
                                       + labels + at(f"left: {cx - 18}px; top: {cy - 38}px", crystal(76), pop=0.05))
    L["memory"] = sparkles(9, 20) + card(
        label("DREAM MODE")
        + "".join(f'<div data-pop="{0.35 + i * 0.3:.2f}" style="{SHAPE}; box-shadow: none; border-radius: 10px; padding: 7px 11px; font-size: 13px; color: {INK}">{m}</div>'
                  for i, m in enumerate(["fixed the date test", "streamed for two hours", "call Mum at 8"]))
        + f'<div data-pop="1.6" style="display: flex; align-items: center; gap: 10px; margin-top: 4px">{crystal(30)}<div style="font-size: 13px; color: {MUTED}">new skill: fixing date tests</div></div>')
    heads = [("Happy", "greeting"), ("Surprised", "interrupted"), ("Sulky", "pout"), ("Sleepy", "dozing"), ("Smug", "smug"), ("Teasing", "wink")]
    L["tease"] = sparkles(10) + at(
        "left: 50%; top: 50%; width: 538px; transform: translate(-50%, -54%); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px",
        "".join(f'<div data-pop="{0.1 + i * 0.11:.2f}" {"id=\"teaseTile\" " if n == "Teasing" else ""}style="{SHAPE}; border-radius: 16px; overflow: hidden; width: 170px; '
                f'display: flex; flex-direction: column; align-items: center">'
                f'<img src="../avatar/{f}-head.png" alt="Mana looking {n.lower()}" style="width: 100px; display: block; margin-top: 8px">'
                f'<div style="font-size: 12px; color: {MUTED}; padding: 6px 0 8px">{n}</div></div>' for i, (n, f) in enumerate(heads)))
    L["promise"] = sparkles(11) + card(
        f'<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="{ACCENT}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        f'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>'
        f'<div style="{DISPLAY}; font-size: 30px; font-weight: 500; line-height: 1.15; color: {INK}">Runs on your PC.</div>'
        f'<div data-pop="0.6" style="font-size: 14px; color: {MUTED}">Nothing leaves it unless you say so.</div>')
    L["signoff"] = sparkles(12, 24) + at(
        "left: 300px; right: 30px; top: 50%; transform: translateY(-56%); display: flex; flex-direction: column; gap: 10px",
        f'<div data-pop="0.1" style="display: flex; align-items: center; gap: 12px">{crystal(44)}<div style="{DISPLAY}; font-size: 64px; font-weight: 500; line-height: 1; color: {INK}">Mana</div></div>'
        f'<div data-pop="{t_rel["13-otsumana"]:.2f}" style="{DISPLAY}; font-style: italic; font-size: 30px; color: {ACCENT}">Otsumana~!</div>'
        f'<div data-pop="{t_rel["13-otsumana"] + 0.9:.2f}" style="align-self: flex-start; {MONO}; font-size: 15px; color: {ACCENT}; padding: 7px 14px; border-radius: 18px; border: 1px solid rgba(157,140,224,0.5); background: rgba(157,140,224,0.10); margin-top: 6px">github.com/Yuuzulight/Mana</div>'
        f'<div data-pop="{t_rel["13-otsumana"] + 1.1:.2f}" style="font-size: 13px; color: {MUTED}">#ManaAI · Open source · Apache 2.0</div>')
    return L


def mouth_curve(clip_path):
    """Per-video-frame mouth openness 0..1 from the clip's loudness."""
    y, sr = librosa.load(clip_path, sr=22050, mono=True)
    hop = sr // FPS
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop, center=True)[0]
    rms = rms / (rms.max() + 1e-9)
    return np.clip((rms - 0.08) / 0.92, 0, 1) ** 0.6


def main():
    tl = json.loads((HERE / "timeline.json").read_text(encoding="utf-8"))
    bar = tl["bar_dur"]
    text = {k: t for k, t, _ in LINES}
    total = sum(s["bars"] for s in tl["screens"]) * bar
    mouth = np.zeros(int(math.ceil(total * FPS)) + 1)
    screens_out, lines_out, t_rel, t = [], [], {}, 0.0
    for s in tl["screens"]:
        dur = s["bars"] * bar
        screens_out.append({"key": s["key"], "start": round(t, 4), "end": round(t + dur, 4)})
        for ln in s.get("lines") or ([{"line": s["line"], "offset": s["offset"]}] if "line" in s else []):
            clip = HERE / "audio" / "narration" / f"{ln['line']}.wav"
            start = t + ln["offset"]
            m = mouth_curve(clip)
            i = int(round(start * FPS))
            mouth[i:i + len(m)] = np.maximum(mouth[i:i + len(m)], m[:len(mouth) - i])
            end = start + librosa.get_duration(path=clip)
            lines_out.append({"key": ln["line"], "start": round(start, 4), "end": round(end, 4),
                              "text": SUBTITLE.get(ln["line"], text[ln["line"]])})
            t_rel[ln["line"]] = ln["offset"]
        t += dur

    OUT.mkdir(exist_ok=True)
    (OUT / "data.json").write_text(json.dumps({
        "fps": FPS, "duration": round(total, 4), "screens": screens_out, "lines": lines_out,
        "mouth": [round(float(v), 3) for v in mouth],
    }), encoding="utf-8")

    layers = "\n".join(f'<div class="layer" id="L-{k}" data-key="{k}">{html}</div>' for k, html in screens(t_rel).items())
    (OUT / "index.html").write_text(f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mana debut</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;1,9..144,500&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Noto+Sans+JP:wght@500&display=swap">
<style>
html, body {{ margin: 0; background: {GROUND}; overflow: hidden; }}
.stage {{ position: absolute; left: 0; top: 0; width: 800px; height: 450px; transform: scale(2.4); transform-origin: 0 0;
         font-family: Geist, system-ui, sans-serif; color: {INK}; }}
.layer {{ position: absolute; inset: 0; opacity: 0; }}
[data-pop] {{ transform-box: fill-box; transform-origin: center; }}
#avatar {{ position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }}
#sub {{ position: absolute; left: 50%; bottom: 14px; translate: -50% 0; max-width: 520px; text-align: center; font-size: 17px; font-weight: 500;
       line-height: 1.35; color: {INK}; background: rgba(23,20,31,0.8); padding: 6px 14px; border-radius: 8px; opacity: 0; white-space: nowrap; }}
</style>
</head>
<body>
<div class="stage" id="stage" style="background: {GROUND}">
{layers}
</div>
<canvas id="avatar" width="1920" height="1080"></canvas>
<div class="stage"><div id="sub"></div></div>
<script src="/windows-launcher/assets/live2d/live2dcubismcore.min.js"></script>
<script src="/windows-launcher/node_modules/pixi.js/dist/browser/pixi.min.js"></script>
<script src="/windows-launcher/node_modules/pixi-live2d-display/dist/cubism4.min.js"></script>
<script src="engine.js"></script>
</body>
</html>
''', encoding="utf-8")
    print(f"{len(screens_out)} screens, {len(lines_out)} lines, {total:.2f}s, {len(mouth)} mouth frames")


if __name__ == "__main__":
    main()
