# Issue 240: Upgrade the Mana Crystal mark to an organic low-poly render

## Status: Implemented, pending PR merge.

## Background

Follow-up to #238/PR #239 (concept AG: gem + drifting motes). After that
shipped, the user's feedback was that the crystal's 3 flat triangles are
"very obvious" as simple vector shapes when actually looked at, especially
blown up on the README banner -- asked for the image to be generated
rather than vectorized.

No image-generation model (DALL-E/Midjourney-style) is available in this
session's toolset. A Canva AI logo generator is available, but couldn't
match the exact chosen shape, can't be driven by `var(--accent)` for the
theme picker, and would need separate handling to stay crisp at 16-17px
tray/sidebar icon sizes. Given that tradeoff, the user explicitly chose to
upgrade the procedural render instead of switching tools.

## The upgrade

One deterministic generator script (`make-icon-ag-organic.js`, scratch
tooling, not committed -- only its output is) builds a ~24-facet low-poly
mesh: 8 irregular hull points, one jittered interior ring, and an
off-center core, fanned into triangles (8 center-to-ring + 16 ring-to-hull
as quad-pairs). Per-facet brightness comes from each triangle's centroid
angle relative to a fixed upper-left light direction, plus a small
hand-picked (not `Math.random()`) jitter so facets don't shade in one
smooth gradient -- they read as small planes each catching light
differently, like an actual cut gem. A soft radial-falloff highlight bloom
replaces the old crisp white stroke lines for the specular glint.
Deterministic jitter tables mean the geometry is stable across
regenerations, not re-randomized each run.

Two color paths from the same generator:

- **Fixed hex per facet** -- for the PNG icons and the README banner,
  which aren't theme-bound.
- **`color-mix(in srgb, var(--accent) 100%, black/white N%)`** per facet --
  for the sidebar/startup/shutdown markup in both apps, which must track
  whatever accent color the theme picker has set. Plain opacity-based
  dimming (what the old 2-facet mark used) was ruled out here: on the
  light theme preset, a *lower* opacity accent sits *closer* to the light
  background and reads as a highlight, not a shadow -- backwards from
  intended. `color-mix()` shifts the color's actual lightness instead,
  independent of whatever it's drawn over, so it shades correctly on both
  the dark and light presets.

## Where it's used

Same 5 markup sites as #239 (windows-launcher sidebar + startup/shutdown
overlay; desktop-client sidebar + startup + shutdown overlay), plus the 3
PNG icon files and both banner SVGs. Each of the 3 HTML `<svg>` instances
that now has its own `<radialGradient>` bloom def needed a unique `id`
(`crystalBloomSidebar` / `crystalBloomStartup` / `crystalBloomShutdown`)
since desktop-client's startup and shutdown overlays live in the same
document and a duplicate id would make the second `url(#...)` reference
ambiguous.

## Verification

- Rendered at 512, 256, 64, and 16px and inspected each directly (Read
  tool image preview, plus a manual nearest-neighbor upscale of the raw
  16px PNG pixels to confirm it still reads as a shaded gem at real
  tray-icon size, not just at the large preview scale).
- Full `windows-launcher` test suite (12 files) + `desktop-client`'s 3
  test files, sequential -- no regressions.
- Checked `id` uniqueness across both HTML files after the edit
  (`grep -n 'id="crystalBloom'`) -- confirmed no duplicates.
- The theme-aware `color-mix()` version was checked against both a dark
  preset accent and the light preset accent in a published Artifact before
  wiring it in, specifically to catch the opacity-inversion problem
  described above.
- The exact committed banner SVG files (not a re-transcription) were
  rendered in a final published Artifact before opening the PR.
- Not done: a live Electron launch + screenshot of the actual running app.
  As with #239, the SVG markup is identical between the real files and the
  verification Artifacts, and SVG rendering doesn't depend on Electron, so
  this was judged sufficient without a full app bring-up.
