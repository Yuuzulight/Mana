# Backend and Desktop Module Boundaries

## Backend

`server.js` remains the composition root: it constructs per-app stores and
runtimes, applies request guards, and passes dependencies to route registrars.

- `routes/chat.js`: typed, streaming, and voice chat; input hooks, attachment
  preparation, and per-app group conversation state.
- `routes/speech.js`: transcription-only/partial, synthesis, screen OCR, and
  vision request/capture-result endpoints.
- `routes/plugins.js`: categorized capability listing and enable/disable.
- `plugin-store-routes.js`: existing install/uninstall, store, and consent flow.
- `ai/chat-reply.js`: prompt assembly, model/tool execution, reply finalization,
  and group reactions.
- `ai/speech-runtime.js`: speech providers, uploaded audio conversion, and OCR.
- `admin-token-cache-routes.js`: token-cache administration.

`registerCoreRoutes` preserves the existing public API and composes chat,
speech, and restart routes. Authentication and request guards remain outside
these modules. Runtime factories do not start workers or acquire resources
during construction. Their state accessors refer to the composition root's
live state, including retries, cancellation tokens, and cached worker promises;
they must not be replaced with snapshots of mutable values.

## Desktop

The launcher loads `renderer/index_fixed.html` with Node integration disabled.
Controller scripts are classic browser scripts loaded before `renderer.js`:

- `core.js`: microphone capture, voice activity detection, transcription,
  continuous listening, and voice turns.
- `voice-playback.js`: streaming playback, interruption, and held-reply resume.
- `chat-history.js`: sessions, history pagination, safe markdown, and artifacts.
- `settings.js`: presets, skills, memory facts, and model/provider settings.
- `plugins.js`: plugin/add-on list, details, installation, and status.
- `ui.js`: startup, avatar state, navigation, and onboarding.

`renderer.js` owns DOM wiring and shared state. Factories receive lazy live
accessors, so constructing a controller never reads a variable declared later
in the renderer. Markdown still goes through the existing safe preload API;
it is not parsed directly in the renderer.

This extraction reduces the composition roots, but does not impose an
arbitrary file-size limit or claim that the reply pipeline needs no further
decomposition. The llama-server process runtime is a separate boundary.
