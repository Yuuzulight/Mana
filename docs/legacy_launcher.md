# Legacy launcher (Electron)

`windows-launcher` is the Electron desktop launcher. It's retired: kept as a fallback, and not receiving feature development. The supported launcher is [`windows-native-launcher`](native_launcher_plan.md).

## Running it

```powershell
cd windows-launcher
npm install
npm start
```

Use `npm run dev` when editing the launcher or the backend loop, for auto-restart. The launcher's tests run with `npm test`; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Avatar options

The legacy launcher can show a VRM (3D) model, driven by the same lip-sync and emotion signals as the Live2D avatar. With no VRM model configured, it falls back to Live2D. See [vrm_avatar_setup.md](vrm_avatar_setup.md).

The native launcher is Live2D only, by design; see [issue #563](https://github.com/Yuuzulight/Mana/issues/563).

## Editor review

The legacy launcher reviews editor edit proposals and snapshots through the backend's `/editors/workspace` routes. See [editor_integration.md](editor_integration.md).
