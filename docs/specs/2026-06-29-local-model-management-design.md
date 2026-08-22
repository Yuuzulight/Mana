# Local Model Management Design

## Goal

Make Mana's configured local model stack visible and switchable from the backend without editing batch files by hand.

## Scope

- Add a backend status API that lists the configured local model profiles.
- Add a runtime active-profile API for switching the default local profile during the current backend session.
- Add a `fast` profile that prefers the 1.5B model before falling back to the 4B and 8B models.
- Report which configured model files are present or missing.
- Warn when remote AI is enabled through environment variables.
- Keep local-only behavior as the default.

This slice does not persist profile switching to disk. The selected active profile resets when the backend restarts.

## Profiles

Mana will expose these local profiles:

- `default`: normal chat, preferring `Qwen3-4B-Q4_K_M.gguf`, then `qwen2.5-1.5b-instruct-q4_k_m.gguf`, then `Qwen3-8B-Q4_K_M.gguf`.
- `fast`: fast fallback, preferring `qwen2.5-1.5b-instruct-q4_k_m.gguf`, then `Qwen3-4B-Q4_K_M.gguf`, then `Qwen3-8B-Q4_K_M.gguf`.
- `quality`: higher quality fallback, preferring `Qwen3-8B-Q4_K_M.gguf`, then `Qwen3-4B-Q4_K_M.gguf`, then `qwen2.5-1.5b-instruct-q4_k_m.gguf`.
- `coding`: coding assistance, preferring `qwen2.5-coder-7b-instruct-q4_k_m.gguf` or `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`, then the chat fallback stack.

Unknown profile names normalize to `default` in existing model-selection helpers, but the profile switching API rejects unknown names so users get a clear error.

## Architecture

Add a focused `node-bot/model-management.js` module. It will own runtime active-profile state and build model status data from existing local AI helpers.

The module will expose:

- `createModelManagement(options)`: creates an isolated runtime model manager.
- `getActiveProfile()`: returns the current active profile.
- `setActiveProfile(profile)`: validates and switches the active profile.
- `getModelStatus()`: returns profile metadata, selected models, missing model files, and remote-AI warning state.

The manager will depend on injected `env`, `fs`, `searchDir`, and `localGgufs` options where useful for tests. Production will use the current process environment and `tools/llama` model directory.

## API

Add the following backend routes:

### `GET /models/status`

Returns model-management state:

```json
{
  "activeProfile": "default",
  "remoteAiEnabled": false,
  "remoteAiWarning": null,
  "profiles": {
    "default": {
      "key": "default",
      "label": "Default chat",
      "selectedModel": "C:\\ManaAI\\Mana\\tools\\llama\\gguf-models\\Qwen3-4B-Q4_K_M.gguf",
      "available": true,
      "candidates": [
        {
          "name": "Qwen3-4B-Q4_K_M.gguf",
          "path": "C:\\ManaAI\\Mana\\tools\\llama\\gguf-models\\Qwen3-4B-Q4_K_M.gguf",
          "exists": true
        }
      ],
      "missing": []
    }
  }
}
```

If a configured model is missing, its candidate entry uses `exists: false`, `path: null`, and appears in `missing`.

### `POST /models/active-profile`

Accepts:

```json
{ "profile": "coding" }
```

Returns the same status shape as `GET /models/status`, with `activeProfile` updated.

Invalid profiles return:

```json
{ "error": "profile must be one of: default, fast, quality, coding" }
```

with HTTP status `400`.

## Reply Behavior

`POST /reply` keeps its explicit `modelProfile` override. When the request body includes a valid `modelProfile`, that profile controls the reply.

When `modelProfile` is omitted, `/reply` uses the active profile from model management. The active profile starts as `default`, so Mana remains local-first and 4B-primary by default.

Prompt-based automatic routing still applies inside `selectLlamaModelProfileForPrompt`. That means coding prompts can still route to the coding profile unless an explicit valid profile is provided.

## Error Handling

- Missing local model files do not break `/models/status`; they are reported in the status payload.
- Missing llama binary behavior remains owned by `local-llama-runtime`.
- Invalid profile switches return `400` without changing the active profile.
- Remote AI is never enabled by these APIs. The status payload only reports whether existing environment variables would allow it.

## Testing

Use TDD for implementation.

Add tests covering:

- `fast` profile normalization and fallback order.
- Model status listing for available and missing configured files.
- Remote-AI warning when `OPENAI_API_KEY` and `MANA_ALLOW_REMOTE_AI=1` are set.
- Active profile switching and invalid-profile rejection.
- `/models/status` and `/models/active-profile` routes.
- `/reply` using the active profile only when no explicit `modelProfile` is provided.

Focused verification should run model helper tests, runtime tests, route tests, syntax checks for changed JavaScript files, the full `npm test` suite when feasible, and the no-reference scan.
