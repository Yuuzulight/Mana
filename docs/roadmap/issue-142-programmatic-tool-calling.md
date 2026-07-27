# Issue 142: Programmatic Tool Calling

## Goal

Let Mana emit a single script that chains multiple tool/capability calls
locally, so a multi-step task doesn't cost one model round-trip per call.

## Finding: the named first target doesn't have this problem

The issue's acceptance criteria assumed Deep Research's source-gathering
pays a model round-trip per source. On audit, `tools/deep-research.js`
already runs that loop as plain sequential JS -- the model is only called
twice total (`decompose`, `synthesize`), regardless of how many sources are
searched/read. It was already a "script"; there was nothing to collapse.

The actual place a chained-round-trip cost could exist is
`llama-server-runtime.js`'s `runToolAwareReply` (issue #51) -- but that's
deliberately single-round, single-tool (`read_file` only) today. No caller
in the codebase currently pays the N-round-trip cost this issue describes.

Raised to the user before building anything further; decided to build the
primitive as standalone foundational infra rather than force it into Deep
Research (which doesn't need it) or defer indefinitely (a real caller --
a multi-round `runToolAwareReply`, or #145's subagent delegation -- is
expected to want it soon).

## Status: Implemented (standalone primitive, not yet wired into a caller)

- **`node-bot/tools/script-runner.js`**: `runToolScript(code, {tools,
  timeoutMs})` forks `script-runner-worker.js` as a child process, sends it
  the generated code plus the whitelisted tool names, and relays each
  `tool-call` message back to the real function (supplied by whoever calls
  `runToolScript` -- e.g. a future caller would pass `{ webSearch:
  capability.search, memoryQuery: acpMemoryStore.getRelatedFacts }`).
  Enforces a wall-clock timeout by killing the child process; captures
  `console.log` calls from the script as `logs` for debugging without
  polluting the return value.
- **`node-bot/tools/script-runner-worker.js`**: runs the generated code
  inside a `vm.createContext` sandbox whose only globals are `tools`
  (the IPC-backed proxy functions), `console.log`, `setTimeout`, and
  `Promise` -- no `require`, no `process`, no `fs`/network access of its
  own. A tool call the script makes is just an ordinary awaited function
  call from the script's point of view.

## Deliberate simplifications

- **No dependency added.** `child_process.fork` + `vm.createContext` are
  both Node stdlib -- covers "sandboxed, no network/file access beyond
  what's needed" without a VM/container library.
- **`vm`'s `timeout` option is a synchronous-execution guard only,** not a
  real wall-clock bound on awaited code -- the actual enforcement is the
  parent killing the whole child process after `timeoutMs`. Documented
  inline so a future reader doesn't assume the vm option alone is enough.
- **Not wired into any capability yet.** No route, no capability module --
  this is a library other code will `require()` once it actually has a
  multi-step tool chain to collapse. Wiring it in prematurely (into Deep
  Research, which doesn't need it) would be exactly the kind of unrequested
  abstraction this issue's own "Out of scope" section warns against.
- **No approval gate yet.** Issue #152 (approval gate for agent-authored
  content) explicitly names this as one of its two hook points -- once #152
  lands, whatever caller first uses `runToolScript` for a *model-generated*
  script (as opposed to a hardcoded one) should route it through that gate
  first. Not needed for this issue in isolation since nothing calls it yet.

## Verified

- `node-bot/test/script-runner.test.js` (9 tests): returns the script's
  final value, chains multiple tool calls in one script, surfaces a tool's
  rejection and a script's own thrown error, rejects a call to a
  never-provided tool name, has no `require`/`fs` access, enforces the
  wall-clock timeout, and captures `console.log` output.
