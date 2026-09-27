"""Renders debut/index.html frame by frame at 1920x1080/60fps and pipes the
frames straight into ffmpeg with the narration mix -- no image folder on disk.
Serves the repo root over HTTP because the Live2D model loads via fetch.

  python render_debut.py --stills   # one still per screen -> debut_stills/
  python render_debut.py            # full render -> debut_final.mp4
"""

import functools
import http.server
import json
import pathlib
import subprocess
import sys
import threading
import time

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
REPO = HERE.parents[1]
PORT = 8765
URL = f"http://127.0.0.1:{PORT}/marketing/showreel/debut/index.html"
AUDIO = HERE / "audio" / "narration-mix.wav"
OUT = HERE / "debut_final.mp4"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(QuietHandler, directory=str(REPO)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def open_page(p):
    browser = p.chromium.launch(args=["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"])
    page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_function("window.debutReady === true || window.debutError", timeout=120000)
    err = page.evaluate("window.debutError || null")
    if err:
        raise RuntimeError(f"page failed to start: {err}\nconsole: {errors}")
    return browser, page, errors


def stills(page, data):
    out = HERE / "debut_stills"
    out.mkdir(exist_ok=True)
    t = 0.0
    for i, s in enumerate(data["screens"]):
        target = s["start"] + 0.62 * (s["end"] - s["start"])
        while t < target:  # step in order so hair physics settle naturally
            t = min(target, t + 1 / 30)
            page.evaluate("t => window.seek(t)", t)
        page.screenshot(path=str(out / f"{i + 1:02d}-{s['key']}.png"))
        print(f"{i + 1:02d} {s['key']:<11} t={t:6.2f}s", flush=True)


def full(page, data):
    fps, n = data["fps"], int(data["duration"] * data["fps"]) + 1
    ff = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
         "-i", str(AUDIO), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(OUT)],
        stdin=subprocess.PIPE)
    t0 = time.time()
    for f in range(n):
        page.evaluate("t => window.seek(t)", f / fps)
        ff.stdin.write(page.screenshot(type="jpeg", quality=95))
        if f % 120 == 0:
            rate = (f + 1) / (time.time() - t0)
            print(f"frame {f}/{n}  {rate:.1f} fps  eta {(n - f) / rate:.0f}s", flush=True)
    ff.stdin.close()
    if ff.wait() != 0:
        raise RuntimeError("ffmpeg failed")
    print(f"done in {time.time() - t0:.0f}s -> {OUT}")


def main():
    data = json.loads((HERE / "debut" / "data.json").read_text(encoding="utf-8"))
    srv = serve()
    try:
        with sync_playwright() as p:
            browser, page, errors = open_page(p)
            (stills if "--stills" in sys.argv else full)(page, data)
            if errors:
                print("console errors:", *errors[:10], sep="\n  ")
            browser.close()
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
