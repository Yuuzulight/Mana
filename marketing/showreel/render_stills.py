"""Preflight check: one still per story-beat (23 total), reviewed for
off-grid timing / cramped layout / illegible text before the full render.
Run: python render_stills.py
"""

import pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
HTML_PATH = HERE / "showreel.html"
OUT_DIR = HERE / "stills"
OUT_DIR.mkdir(exist_ok=True)

BAR_DUR = 1.9969
BARS = 23


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1440})
        page.goto(HTML_PATH.as_uri())
        page.wait_for_function("typeof window.seek === 'function'")

        for i in range(BARS):
            t = i * BAR_DUR + BAR_DUR * 0.55  # a representative mid-bar moment
            page.evaluate("(t) => window.seek(t)", t)
            out = OUT_DIR / f"bar{i+1}_t{t:.2f}.png"
            page.screenshot(path=str(out))
            print(f"bar {i+1}: t={t:.3f}s -> {out.name}")

        browser.close()


if __name__ == "__main__":
    main()
