# Avatar Notice

The Live2D avatar shown in the desktop client is a **temporary testing
placeholder**, not Mana's final avatar. It exists so the avatar rendering
pipeline (Live2D driving, lip sync, emotion states, zoom) can be built and
exercised end to end while a final, original avatar is still pending.

## Attribution

The placeholder model currently loaded (HuoHuo) is a character from
**Genshin Impact**. All character design rights belong to **miHoYo /
HoYoverse**. This project does not claim any ownership over the character
design, and the model file itself is never committed to this repository
(it's git-ignored — see `.gitignore`) or bundled into any installer build.
It is used strictly for local, non-distributed development and testing.

This placeholder will be replaced before any public release build ships
with an avatar enabled by default.

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
