"""Full-resolution subframe render: 4 subframes per output frame at 60fps,
later tmix-composited in ffmpeg for motion blur (see composite.sh).
Run: python render_full.py
"""

import pathlib
import time
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
HTML_PATH = HERE / "showreel.html"
OUT_DIR = HERE / "raw"
OUT_DIR.mkdir(exist_ok=True)

FPS = 60
SUBFRAMES = 4
LOOP_T = 1.9969 * 8  # keep in sync with showreel.html's BAR_DUR * BARS


def main():
    n_frames = int(LOOP_T * FPS) + 1  # +1 so the last output frame lands past LOOP_T, trimmed by ffmpeg/audio mux later
    total_sub = n_frames * SUBFRAMES
    print(f"rendering {n_frames} output frames x {SUBFRAMES} subframes = {total_sub} images")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1440})
        page.goto(HTML_PATH.as_uri())
        page.wait_for_function("typeof window.seek === 'function'")

        start = time.time()
        idx = 0
        for f in range(n_frames):
            frame_t0 = f / FPS
            for s in range(SUBFRAMES):
                t = frame_t0 + (s / SUBFRAMES) / FPS
                page.evaluate("(t) => window.seek(t)", t)
                out = OUT_DIR / f"sub_{idx:06d}.png"
                page.screenshot(path=str(out))
                idx += 1
            if f % 50 == 0:
                elapsed = time.time() - start
                rate = idx / elapsed if elapsed > 0 else 0
                eta = (total_sub - idx) / rate if rate > 0 else 0
                print(f"frame {f}/{n_frames}  ({idx}/{total_sub} subframes, {rate:.1f}/s, eta {eta:.0f}s)")

        browser.close()
        print(f"done in {time.time() - start:.1f}s -> {idx} images in {OUT_DIR}")


if __name__ == "__main__":
    main()
