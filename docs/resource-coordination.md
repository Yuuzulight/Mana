# Resource coordination (#1380)

Mana's backend owns one shared resource coordinator. New model loads, chat,
voice, embeddings, reranking, generated skills, Python analysis and disposable
workspace tests request explicit RAM, VRAM and CPU leases before execution.
The native launcher reserves model residency through authenticated backend
routes before spawning a service. PID and creation-time checks verify launcher
ownership; backend restart recovers surviving launcher-owned services.

## Admission and priorities

- Estimates are reservations, not measurements or OS limits. Hardware free
  memory and verified per-process observations are refreshed before admission.
- Background work retains 15% system RAM headroom and leaves two logical
  processors outside background allocations. This is admission accounting,
  not CPU affinity or a guarantee that Windows leaves particular cores idle.
- Chat and voice take priority at safe boundaries. Active approved sandbox
  tests continue. Aged queued requests prevent endless small-job backfilling.
- Missing or stale GPU telemetry receives brief retries, then GPU loads queue.
  Supported CPU alternatives require a fresh human approval. Existing workloads
  and CPU-only requests do not depend on GPU telemetry.
- Only idle backend-owned models are evicted. External services, unrelated
  applications and in-use models are never killed to make space.
- Model estimates include local weights, projector, draft model, adapters,
  total parallel KV context and host prompt cache. Unlimited host caches cannot
  be admitted. GPT-SoVITS requires measured `MANA_GPT_SOVITS_RAM_MB` and
  `MANA_GPT_SOVITS_VRAM_MB` estimates; unknown capacity is not silently guessed.
- Fish device transfers are serialized, reserve their destination memory,
  and update owned residency only after the server confirms completion.

GPU observations currently use the first NVIDIA GPU reported by `nvidia-smi`,
matching the existing single-GPU guard. Unknown per-process usage (including
WDDM `N/A`) receives no credit. Estimates can therefore queue a load even when
the driver appears to have space. This implementation does not promise exact
peak-memory prediction, CPU pinning, or multi-GPU placement.

## Cleanup and diagnostics

`GET /resources/status` requires admin authentication. Mana can read the same
inventory through `resources__status` in the user's chat. It reports owners,
PIDs, execution modes, estimates, observed use, queue reasons and recent events.

Completed requests release execution slots; model residency remains until
idle unload or Stop. Streamed replies retain their model lock until their body
finishes or is cancelled. A stopped process retains its reservation until exit
is confirmed. Failed sandbox cleanup and unconfirmed external work remain
visible as retained reservations, never newly available capacity. Recovery
must confirm termination; it cannot merely clear an accounting record.

Sandbox hard budgets, separate unrestricted-rerun approvals, local-only mode,
cloud consent and existing gaming/resource guards remain unchanged.

## Verification

Coordinator and integration tests cover admission races, telemetry failures,
priorities, aging, cancellation, process crashes, asynchronous helper PIDs,
native ownership/recovery, device transitions and retained cleanup failures.

The opt-in `test/resource-hardware.test.js` uses an explicitly supplied local
GPU model and a temporary AppContainer Node test. It checks that chat progresses
while the test stays active, then verifies all owned model processes exit and
all leases release. Set `MANA_TEST_RESOURCE_LIVE=1`, `MANA_TEST_LLAMA_BIN` and
`MANA_TEST_LLAMA_MODEL` to run it. Existing live sandbox tests additionally
verify descendant cleanup and backend-termination recovery.
