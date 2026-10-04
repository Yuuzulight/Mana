# Native Windows execution boundary (#352)

Generated JavaScript skills and chat/self-work tests now run through Mana's
own background Windows helper. No Docker, container manager or additional
application window is required. Node `vm` remains defense in depth, not the
security boundary. Direct network access is denied; the existing named tool
proxy remains the only allowed route to trusted network-capable tools.

## Generated JavaScript

Each skill receives a private copy of Node and the worker, a secret-free
environment, and exactly three inherited protocol/output handles. The Job
Object limits execution to one process, 512MB, 10% CPU rate and 15 seconds.
Messages and tool responses are limited to 1MB, logs to 20,000 characters,
and broker calls to 16 concurrent / 1,024 total calls. Filesystem monitoring
limits skill scratch to 256MB including the runtime and 5,000 entries.
Trusted tools execute in Mana's backend under their existing approval policies;
terminating a skill does not undo a tool action that has already begun.

## Chat And Self-Work Tests

Every run requires fresh human approval, even after a session-wide grant.
Mana estimates the workload and recommends one of two fixed profiles:

| Profile | Wall Time Including Setup | Job Memory | Processes |
| --- | --- | --- | --- |
| Standard | 15 minutes | 2GB | 32 |
| Large | 30 minutes | 4GB | 64 |

CPU rate is capped at 50%. Tests receive a disposable workspace copy, not
access to the live checkout. Copying happens in a cancellable background
worker; the Terminal tool exposes Stop during setup as well as execution.
Private runtime data and credential filenames are excluded. Dependency
build directories and fixtures are preserved; source build outputs are not.
External links must resolve inside an explicitly approved copy-source root.
Copy and execution storage are bounded to 8GB / 500,000 entries. Execution
storage is checked once per second, not enforced as a hard disk quota.

Approved external sources live in the protected, local-only
`node-bot/data/native-sandbox-copy-sources.json`, with `dependencyRoots` (an
array of absolute paths) and optional `nugetRoot`. Defaults grant no external
copy access. Approvals display these sources; machine-specific paths are
not committed. Only packages are copied from NuGet, not its user configuration.
The sandbox uses an empty package-source configuration and cannot download
missing packages. Node, npm and .NET build/test adapters are supported;
other commands fail closed rather than silently using a host shell.

AppContainer compatibility requires Node's single-process test mode for a
focused file. Mana's sequential suite runner still starts one process per
file, preserving file isolation. .NET build servers and shared compilation
are disabled. Windows benchmark callers must supply a human approval gate;
the standalone benchmark has no automatic unrestricted fallback.

After the exact sandboxed command fails, Mana can request an **unrestricted
rerun**. This requires another explicit approval warning that host files and
network are accessible under the user's Windows account. It still gets a
new disposable copy, clean environment, fixed Job Object limits and cleanup.
It never happens automatically, and a successful sandbox run clears the
retry eligibility. Generated skills and Python analysis have no such bypass.

## Lifecycle And Deployment

The helper assigns the suspended child to its kill-on-close Job Object before
resuming it. On normal exit, failure, timeout or Stop it terminates descendants
and waits for the job to empty before removing scratch and AppContainer
metadata. The backend performs a second cleanup/recovery pass before reporting
completion, and surfaces cleanup failures. Owned process resources are released;
Mana's normal model/runtime allocations are not unloaded by a test run.
The helper holds a synchronization handle to its owning backend and checks
that process during execution; an unexpectedly terminated backend stops the
script and triggers helper cleanup without relying on a backend exit handler.
A simultaneous backend/helper crash can leave disk/profile metadata, but not
a live process in the closed Job Object.

Native launcher builds and updates publish the self-contained helper. Electron
packaging does so through `prepare-portable-python`. Windows CI checks live
isolation, approval, offline .NET compatibility, Stop and cleanup.

## Python Analysis Infrastructure (#1327 Integration)

Mana calls `analysis__run_python` from her own tool-enabled chat. Python runs
in a background Windows AppContainer created by Mana's helper; no additional
app window or container manager is opened. The tool is available automatically
when the bundled helper and runtime are present. `MANA_ANALYSIS_ENABLED=0`
disables it; `=1` exposes it for development even before preparation completes.
It follows the normal per-call tool approval policy.

The packaged build's existing `prepare-portable-python` step builds the helper
and a dedicated Python runtime with pandas, matplotlib and openpyxl. On first
use Mana copies the bundled runtime into her private data directory. She does
not install packages or download anything while running a script.
For development, publish `tools/analysis-sandbox/Mana.AnalysisSandbox.csproj` in
Release to `tools/analysis-sandbox/bundle` and prepare the portable `analysis`
Python bundle. Trusted deployment
configuration may override `MANA_ANALYSIS_HELPER` and `MANA_ANALYSIS_PYTHON_DIR`.

Only files explicitly named in the current user message are copied into the
scratch directory (up to eight, 4MB total). Credential files are refused.
Code is capped at 40,000 characters. Output is tagged as untrusted text;
up to four PNG charts (256KB each) are appended as an HTML artifact without
passing base64 through the model. Save charts under Python's `output_dir`.

The AppContainer has no capabilities for networking. Windows restricts private
host-file access; system resources already readable by AppContainers remain
readable. Its unique per-run SID gets read/execute access to the dedicated
runtime and write access to its scratch directory. No host secrets or handles
are inherited. AppContainer is an OS boundary, unlike Python/vm language-only
isolation, but it shares the Windows kernel rather than using a VM.

Before Python is resumed, the helper assigns it to a Job Object with a 512MB
memory cap, 10% CPU rate cap, 30 seconds of CPU time, one-process limit and
kill-on-close. Mana serializes runs so parallel tool calls do not multiply the
resource budget. Wall time is limited to 60 seconds. Numerical library threads
are capped at one and matplotlib uses the CPU-only Agg renderer. Scratch
storage is monitored at 100ms intervals with a 64MB/5,000-entry budget;
this is a monitored limit, not a hard filesystem quota.

On success, script error, timeout or helper termination, the backend waits for
process termination and cleans the scratch directory, AppContainer profile
and runtime ACL grant. Cleanup failures are surfaced. Killing the helper
closes its Job Object and kills Python even before backend cleanup runs.
A simultaneous crash of the backend and helper can leave disk/profile metadata
until recovery, but the Job Object does not keep the script alive.
There is no unrestricted Python fallback. The chat-facing analysis tool and
artifact presentation are delivered separately in #1327.

Verify live isolation and cleanup with `MANA_TEST_ANALYSIS_LIVE=1` and
`node --test node-bot/test/analysis-sandbox.test.js` after preparing the runtime.

References:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
