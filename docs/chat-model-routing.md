# Chat Model Routing (#1332)

The native Windows launcher's chat header selects Automatic, a local profile,
or an available configured cloud endpoint. The choice belongs to the chat's
session, persists across restart, and is inherited by a fork. It does not change
the global active model or self-work escalation. Electron controls are unchanged.

When a saved cloud choice becomes unavailable (including revoked permission or
local-only mode), that chat uses the active local profile automatically. The
picker shows the effective local choice, and the answer is labelled with the
local model. This recovery cannot route back into another cloud endpoint.
The saved cloud preference is retained for when access is restored; new cloud
selections still require permission and valid configuration.

Settings > Model > Chat Cloud Fallback is opt-in and disabled by default. Its
confirmation grants permission for chat fallback only, not general remote AI.
Local-only mode blocks activation, cloud picker entries, and runtime fallback.
API keys use the existing protected settings storage and are never returned by
status/picker endpoints. A blank key field preserves a saved key; Clear key then
Save removes it. Existing session token-stop limits apply to cloud requests.

Timing options are 30 seconds, 60 seconds, and No timeout (the initial selection).
All three allow fallback after an unsuccessful local reply. The timed settings
start their deadline when the main local inference attempt begins, including
model startup. Prompt/context preparation precedes this deadline. Any visible
reply text or tool execution disables handoff for that attempt, preventing an
interrupted reply or repeated actions. Thinking alone does not count as a reply.

Timed requests carry an AbortSignal through startup and completion paths. A
cancelled request releases its in-flight state. If its owned model is not serving
another active request, Mana tree-kills it and waits for exit before fallback;
externally owned servers are not killed. Cancellation does not mark a model
build as broken or trigger a build rollback. Cleanup failure prevents handoff.
Timed fallback uses llama-server rather than the blocking llama-cli path.
The cloud HTTP request has its own bounded wall deadline and response size;
this is independent of the local timing selector.

Replies and stored history carry the answering model and fallback flag. Cloud
fallback does not replay local tool actions, and its answer is not subsequently
rewritten by a local retry. Scheduled/background work retains its existing routing.
