# Issue 238: Redesign the Mana Crystal mark (concept AG)

## Status: Implemented, pending PR merge.

## Background

The original mark was three flat, evenly-lit triangles with no shading --
legible at 16px but visually flat once used anywhere larger (the startup
screen, the README banner). Rather than a single redesign pass, this went
through an extended concept-review process with the user: five rounds of
concept previews (~40 named concepts, A through AD) shown via published
Artifacts, researching real references live rather than from memory
(fetched Obsidian's actual logo from obsidian.md to see how their
asymmetric, few-large-facet, per-panel-gradient technique actually works,
rather than guessing). The user converged on the "small gem + small
orbiting/floating accents" family (concepts G and T), then a fifth round
of ten variations within just that family, landing on concept **AG**.

## The chosen design (AG)

A compact 3-triangle gem -- same silhouette as the original mark's core
shape, just resized smaller to leave room around it -- surrounded by 8
small dust motes placed loosely at varying distance, size, and opacity, as
if implying an orbit without actually drawing a ring/stroke line. No
literal ring, no literal orbit path -- the circular arrangement is only
suggested by where the motes sit.

## Where it's used, and how each was updated

- **`windows-launcher/renderer/index.html`**: sidebar logo (17x17) and the
  shared startup/shutdown overlay (40x40) -- 2 sites, both kept using
  `var(--accent)` / `var(--accent-dim, var(--accent))` for the gem body so
  the theme picker still works; only the motes are fixed-color highlights,
  matching the pre-existing convention where the small top facet was
  already a fixed `#c9b8f0` regardless of theme.
- **`desktop-client/renderer/index_fixed.html`**: sidebar logo, startup
  overlay, and shutdown overlay -- 3 sites, same `var(--accent-dim)` /
  `var(--accent)` convention as before.
- **`windows-launcher/assets/icon.png`** (256x256, runtime window/tray
  icon) and **`windows-launcher/build/icon.png`** /
  **`desktop-client/build/icon.png`** (512x512, packaged `.exe`/installer
  icon, shipped in #230/#232): regenerated with the same pure-Node PNG
  rasterizer approach as before (point-in-triangle + point-in-circle
  tests, 4x4 supersampling for anti-aliasing, manual PNG writer) -- these
  are static images so the gem uses a fixed `#9d8ce0`, matching the
  default theme accent.
- **`docs/images/banner-dark.svg`** / **`banner-light.svg`**: both the
  large background emblem and the small logo-beside-wordmark instance
  updated to the new gem+motes geometry, keeping the existing faceted
  gradient/shadow treatment built for the banner; mote colors adjusted
  per-variant for contrast against each background.

## Verification

- `node --check`: not applicable, no `.js` files touched.
- Full `windows-launcher` test suite (12 files, sequential) -- no
  regressions, including `renderer-script-scope.test.js` which scans
  `index.html` for issues (only SVG markup changed, no `<script>` content).
- `desktop-client`'s 3 test files -- no regressions (none of them touch
  renderer markup directly, but run for completeness since the file
  changed).
- PNG icon output verified two ways: visually (Read tool image preview)
  and programmatically (inflated the IDAT stream directly, confirmed
  corner alpha 0 / transparent, and the gem's center pixel is exactly
  `#9d8ce0` at full opacity).
- The two banner SVGs and the real sidebar/startup markup were rendered
  byte-for-byte (copied verbatim, not re-approximated) into a published
  Artifact for a final visual check before opening the PR -- the
  in-session Browser pane tooling wasn't able to load local files outside
  the project's own working directory in this environment, so Artifacts
  were the reliable rendering path used throughout this whole redesign
  process.
- Not done: a live Electron launch + screenshot of the actual running app
  (the approach used for #230's original icon fix). The SVG markup is
  identical in both the real files and the verification Artifact, and SVG
  rendering doesn't depend on Electron/IPC, so this was judged sufficient
  without the added time of a full app bring-up. Worth doing before the
  next real release build if a true pixel-for-pixel confirmation in the
  actual app matters.
