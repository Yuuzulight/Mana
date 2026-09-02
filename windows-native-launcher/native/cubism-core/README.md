# Live2D Cubism Core (native)

`Live2DCubismCore.dll`, `Live2DCubismCore.lib`, and `Live2DCubismCore.h` go
in this directory. They are **not** committed to the repository (see
`.gitignore`) — Cubism Core is proprietary (Live2D Proprietary Software
License), same reasoning `windows-launcher/assets/live2d/` and
`desktop-client/assets/live2d/` already document for the WebAssembly build
this project also uses.

Unlike that WebAssembly build, there's no unauthenticated public URL for the
native SDK to auto-fetch from — Live2D gates it behind their own EULA
click-through. Setup is manual:

1. Go to <https://www.live2d.com/en/sdk/download/native/> and download
   **Cubism SDK for Native** (accept Live2D's license — read the terms
   yourself; `LICENSE.md` in the SDK zip has the details, including the
   Cubism SDK Release License requirement for business users above a
   revenue threshold).
2. From the extracted zip, copy these three files into this directory:
   - `Core/dll/windows/x86_64/Live2DCubismCore.dll`
   - `Core/dll/windows/x86_64/Live2DCubismCore.lib`
   - `Core/include/Live2DCubismCore.h`
3. Build `windows-native-launcher` as normal — the `.csproj` copies the DLL
   next to the built app automatically (see its `Content` item).

Without these files present, avatar rendering falls back to the existing
static idle/talking PNG swap (`AvatarOverlayForm`'s original behavior) --
matching how the Electron apps degrade gracefully without their own Live2D
runtime present.
