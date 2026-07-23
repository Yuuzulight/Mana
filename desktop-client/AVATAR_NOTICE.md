# Avatar Notice

No avatar model is committed to this repository or bundled into any
installer build — the desktop client always falls back to PNG sprites (or
no avatar) until `avatar/model/` is populated locally, either by hand or via
`npm run fetch-sample-avatar` (see below). A final, original Mana-specific
avatar is still pending; everything described here is an interim default,
not that final art.

## Attribution

`npm run fetch-sample-avatar` downloads **Hiyori Momose**, a free sample
model distributed by **Live2D Inc.** under their
[Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
and [Cubism Sample Data Terms of Use](https://www.live2d.com/learn/sample/model-terms/).
Hiyori is an original character illustrated by **Kani Biimu**. The download
comes straight from Live2D's own CDN at setup time — the same URL their own
"Download" button uses — and is never committed to this repository or
redistributed by Mana, since Live2D's license does not permit third-party
redistribution of the Material. This is a legally-clean interim default,
usable in a public build, not a placeholder needing replacement before
shipping.

Developers may also still drop in other local-only test models (e.g. an
earlier build used a Genshin Impact character as a throwaway placeholder,
gitignored and never bundled) — see `windows-launcher/avatar/model/` for
the equivalent bring-your-own-model setup. Anything placed there manually is
subject to its own license, not this one, and stays local/non-distributed
same as always.

## Scope of this port

Porting the Live2D driver into `desktop-client` (from `windows-launcher`,
where it was originally built) also required temporarily enabling
`nodeIntegration`/disabling `contextIsolation` for the desktop client's main
window — see the comment in `desktop-client/main.js`'s `createWindow()`.
This is a deliberate, documented tradeoff scoped to this testing feature,
not a permanent security posture. A context-isolation-safe rewrite of
`avatar/live2d-avatar.js` (resolving model/config over IPC instead of
`fs`/`path` directly in the renderer) is follow-up work once the avatar
itself is finalized.

See also `windows-launcher/avatar/model/` (the original, also git-ignored
copy of this same placeholder model) and the repository-wide
`THIRD_PARTY.md` / `LICENSE-ARTWORK` for the broader artwork licensing
picture.
