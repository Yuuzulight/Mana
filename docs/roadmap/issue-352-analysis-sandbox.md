# Native analysis sandbox (#352, #1327)

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
There is no unrestricted Python fallback. The existing workspace test runner
and JavaScript skills retain their own approval behavior and are not migrated.

Verify live isolation and cleanup with `MANA_TEST_ANALYSIS_LIVE=1` and
`node --test node-bot/test/analysis-sandbox.test.js` after preparing the runtime.

References:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
