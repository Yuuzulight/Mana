using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

internal sealed class ManaProcessManager : IDisposable
{
    private readonly HttpClient http;
    private Process? backendProcess;
    private Process? fishSpeechProcess;
    private Process? embedderProcess;
    private Process? searxngProcess;
    private Process? retrieverProcess;
    private Process? gptSovitsProcess;
    private Process? qwen3TtsProcess;

    public string RootDirectory { get; }

    // #691: opt-in services, read once at construction (node-bot/.env is
    // already loaded by then). They get a startup row only when turned on,
    // so an unused one never shows as "Unavailable".
    // The Python retriever (~0.5 GB since #809) is started on demand by
    // node-bot when a coding turn needs it and stopped when idle
    // (ai/retriever-runtime.js). MANA_START_RETRIEVER=1 force-starts it here
    // at launch instead.
    public bool UsesRetriever { get; } = Environment.GetEnvironmentVariable("MANA_START_RETRIEVER") == "1";
    // User decision: only the selected TTS provider is started. Fish is the
    // default (the same "fish" this launcher passes node-bot when unset);
    // Kokoro stays on demand in node-bot.
    public bool UsesFishSpeech { get; } = Environment.GetEnvironmentVariable("TTS_PROVIDER") is null or "" or "fish";
    public bool UsesGptSovits { get; } = Environment.GetEnvironmentVariable("TTS_PROVIDER") == "gpt_sovits";
    public bool UsesQwen3Tts { get; } = Environment.GetEnvironmentVariable("TTS_PROVIDER") == "qwen3tts";
    // #891: the same QWEN3_TTS_URL node-bot calls and the service takes its
    // port from.
    private readonly string qwen3TtsHealthUrl =
        $"{(Environment.GetEnvironmentVariable("QWEN3_TTS_URL") ?? "http://127.0.0.1:5012").TrimEnd('/')}/health";

    // #582: only captures output for a backend process THIS launcher
    // spawned -- if StartAsync's health check found node-bot already
    // running externally, backendProcess stays null and there is nothing
    // to redirect, so the buffer just stays empty (no log to show, not
    // an error).
    public BackendLogBuffer BackendLog { get; } = new();

    // #670 (Q23): node-bot no longer treats "local" as admin. A fresh key
    // each run, handed to the node-bot this launcher starts (env
    // MANA_LAUNCHER_KEY) and sent by ManaBackendClient as x-admin-token.
    // Memory only, so unlike the stored AdminToken (#804) it needs no DPAPI.
    public string LauncherKey { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    // #479 review: distinct from "did THIS launch start a process handle" --
    // true whether Fish Speech was already running externally (health check
    // passed, fishSpeechProcess stays null, nothing to start) or this
    // launch started it. False only for the actual graceful-degradation
    // case: missing native setup, or a launch failure. Lets callers (the
    // tray status) tell "fish is really answering requests" apart from
    // "TTS_PROVIDER=fish is configured but Fish Speech isn't answering" --
    // the two look identical from the configured-provider name alone.
    public bool IsFishSpeechAvailable { get; private set; }
    // Same meaning for Qwen3-TTS: running already, or launched by this run.
    public bool IsQwen3TtsAvailable { get; private set; }

    // False when the configured backend URL points at another machine --
    // that machine runs its own node-bot and its own TTS services.
    public bool IsBackendLocal => isBackendLocal;

    // The backend's own health-check URL, derived from the same configured
    // base URL ManaBackendClient/TrayNotificationClient use -- previously
    // hardcoded to 127.0.0.1:5005 here regardless of a user-configured
    // BackendBaseUrl (ManaSettingsStore), so a custom URL would health-check
    // (and, if unhealthy, try to spawn a local node-bot for) the wrong
    // address entirely. Fish Speech stays hardcoded -- it's always a
    // local child process this launcher itself manages, unrelated to
    // where the node-bot backend happens to live.
    private readonly string backendHealthUrl;
    private readonly bool isBackendLocal;
    private readonly bool localOnly;

    // handler: null (the default, and every existing call site's behavior)
    // constructs a real HttpClient for live health checks. Tests pass a
    // fake HttpMessageHandler to exercise the health-check-then-start
    // selection logic without live servers -- same pattern as
    // ManaBackendClient.
    // backendBaseUrl: null (the default) keeps the original 127.0.0.1:5005
    // behavior; pass the configured settings.BackendBaseUrl to keep the
    // backend health check consistent with where ManaBackendClient actually
    // points.
    public ManaProcessManager(string rootDirectory, HttpMessageHandler? handler = null, string? backendBaseUrl = null, bool localOnly = false)
    {
        RootDirectory = rootDirectory;
        this.localOnly = localOnly;
        http = handler is null ? new HttpClient() : new HttpClient(handler);
        backendHealthUrl = $"{(backendBaseUrl ?? "http://127.0.0.1:5005").TrimEnd('/')}/health";
        // #681: a remote backend URL means that machine starts its own
        // node-bot -- never spawn a redundant local one (windows-launcher's
        // startWindowsServices / isBackendUrlLoopback). Unparseable counts
        // as local, same as there.
        isBackendLocal = !Uri.TryCreate(backendHealthUrl, UriKind.Absolute, out var parsed) || parsed.IsLoopback;
    }

    // onServiceReady, when given, fires once per service (key "backend"/
    // "embedder"/"websearch", plus "fish-speech"/"retriever"/"gpt-sovits"/
    // "qwen3-tts" when in use) the moment its own health-check-then-start
    // resolves -- lets a caller (the startup overlay) flip that row from
    // "Starting..." to "Ready"/"Unavailable" live instead of only knowing
    // "all three are done" after StartAsync itself returns. Fires on
    // whatever context awaited into this method (the UI thread, for the
    // launcher's own real call site) -- no ConfigureAwait(false) anywhere
    // in this file to break that.
    public async Task StartAsync(Action<string, bool>? onServiceReady = null)
    {
        async Task<(Process? Process, bool Available)> StartAndReport(string key, string healthUrl, Func<Task<Process?>> start)
        {
            var result = await StartIfNotRunningAsync(healthUrl, start);
            onServiceReady?.Invoke(key, result.Available);
            return result;
        }

        // Fish Speech (S1-mini) is Mana's TTS voice (docs/fish_speech_tts.md).
        // #694 / user decision: Kokoro is no longer started here at all --
        // node-bot starts it on demand while gaming (or when configured to
        // use it) and stops it after MANA_KOKORO_IDLE_MS (kokoro-runtime.js).
        //
        // Fish Speech is only ever called by node-bot (native synthesizes
        // through the backend), so with a remote backend it'd be dead
        // weight. Skipped then, like the backend and embedder.
        //
        // These checks are independent (none needs another already
        // running before it can start), so they run concurrently instead
        // of one-after-another -- a stale/wedged listener on one port no
        // longer serializes an ~100s HttpClient timeout in front of the
        // others.
        var notUsed = Task.FromResult<(Process? Process, bool Available)>((null, false));
        var fishSpeechTask = UsesFishSpeech
            ? StartAndReport("fish-speech", "http://127.0.0.1:8080/v1/health", () => Task.FromResult(isBackendLocal ? StartFishSpeech() : null))
            : notUsed;
        var backendTask = StartAndReport("backend", backendHealthUrl, () => Task.FromResult<Process?>(isBackendLocal ? StartBackend() : null));
        // #691: the embedder only serves a backend on this machine -- a remote
        // backend calls its own 127.0.0.1:9001, never ours. When
        // MANA_EMBEDDER_MODEL names a model file, node-bot runs a GPU
        // embedder itself on demand (ai/embedder-runtime.js) instead: nothing
        // to check or start here, and the row reads Ready -- memory search
        // is the backend's.
        Task<(Process? Process, bool Available)> embedderTask;
        if (!File.Exists(Environment.GetEnvironmentVariable("MANA_EMBEDDER_MODEL")))
        {
            embedderTask = StartAndReport("embedder", "http://127.0.0.1:9001/health", () => Task.FromResult(isBackendLocal ? StartEmbedder() : null));
        }
        else
        {
            onServiceReady?.Invoke("embedder", true);
            embedderTask = Task.FromResult<(Process? Process, bool Available)>((null, true));
        }
        // #691: the rest of windows-launcher's helper services. Like the
        // embedder they only serve a node-bot on this machine, so a remote
        // backend just gets the health check.
        var searxngTask = StartAndReport("websearch", "http://127.0.0.1:8890/", () => Task.FromResult(isBackendLocal ? StartSearxng() : null));
        var retrieverTask = UsesRetriever
            ? StartAndReport("retriever", "http://127.0.0.1:9000/health", () => Task.FromResult(isBackendLocal ? StartRetriever() : null))
            : notUsed;
        // api_v2.py has no health route; FastAPI's default /docs page
        // answers 200 as soon as the server is up.
        var gptSovitsTask = UsesGptSovits
            ? StartAndReport("gpt-sovits", "http://127.0.0.1:9880/docs", () => Task.FromResult(isBackendLocal ? StartGptSovits() : null))
            : notUsed;
        var qwen3TtsTask = UsesQwen3Tts
            ? StartAndReport("qwen3-tts", qwen3TtsHealthUrl, () => Task.FromResult(isBackendLocal ? StartQwen3Tts() : null))
            : notUsed;

        try
        {
            await Task.WhenAll(fishSpeechTask, backendTask, embedderTask, searxngTask, retrieverTask, gptSovitsTask, qwen3TtsTask);
        }
        finally
        {
            // Task.WhenAll waits for every task to reach a terminal state
            // (success or failure) before it throws -- so by here all
            // three are guaranteed completed, and it's safe to store
            // whichever processes actually started even if a sibling
            // failed (e.g. the backend's start throwing). Without this, a
            // successfully-started Fish Speech or embedder process would be
            // orphaned: started, but never given a Process handle for
            // Dispose() to kill.
            if (fishSpeechTask.IsCompletedSuccessfully)
            {
                fishSpeechProcess = fishSpeechTask.Result.Process;
                IsFishSpeechAvailable = fishSpeechTask.Result.Available;
            }
            if (backendTask.IsCompletedSuccessfully) backendProcess = backendTask.Result.Process;
            if (embedderTask.IsCompletedSuccessfully) embedderProcess = embedderTask.Result.Process;
            if (searxngTask.IsCompletedSuccessfully) searxngProcess = searxngTask.Result.Process;
            if (retrieverTask.IsCompletedSuccessfully) retrieverProcess = retrieverTask.Result.Process;
            if (gptSovitsTask.IsCompletedSuccessfully) gptSovitsProcess = gptSovitsTask.Result.Process;
            if (qwen3TtsTask.IsCompletedSuccessfully)
            {
                qwen3TtsProcess = qwen3TtsTask.Result.Process;
                IsQwen3TtsAvailable = qwen3TtsTask.Result.Available;
            }
        }
    }

    // #479 review: named as worth tracking rather than a full crash-recovery
    // system (no Process.Exited watcher, no auto-restart) -- this is
    // explicitly a manual action a user can reach for (the tray's "Restart
    // Fish Speech" item) once they've noticed the fallback note above, not
    // an unattended self-healing loop. Stops whatever's there first (a
    // hung/half-working process, if any) before starting fresh, the same
    // as StartFishSpeech()'s own non-fatal degrade path.
    public void RestartFishSpeech()
    {
        StopProcess(fishSpeechProcess);
        fishSpeechProcess = StartFishSpeech();
        IsFishSpeechAvailable = fishSpeechProcess is not null;
    }

    // #991: node-bot's /restart and /admin/restart exit with this code for
    // the launcher to start it again (admin-restart.js).
    internal const int BackendRestartExitCode = 77;

    // #991: raised on a thread-pool thread when node-bot exits asking for a restart.
    public event Action? BackendRestartRequested;

    // #991: only a node-bot this launcher started -- a remote one, or one
    // already running at launch, isn't this launcher's to stop.
    public bool CanRestartBackend => isBackendLocal && backendProcess is not null;

    // #991: stops node-bot (with its children, as on exit) and starts it
    // again with the same LauncherKey; true once the new one answers its
    // health check. Throws if node can't be started at all.
    public async Task<bool> RestartBackendAsync(TimeSpan timeout, TimeSpan? pollInterval = null)
    {
        if (!CanRestartBackend)
        {
            return false;
        }
        var old = backendProcess!;
        StopProcess(old);
        using (var exited = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
        {
            try
            {
                // Its port must be free before the new one binds it.
                await old.WaitForExitAsync(exited.Token);
            }
            catch (OperationCanceledException)
            {
                // Still going; the new one fails to bind and gets retried.
            }
        }
        if (disposed)
        {
            return false; // Mana exited meanwhile: nothing would stop a new one
        }
        backendProcess = StartBackend();
        return await WaitForHealthyAsync(true, backendHealthUrl, timeout, pollInterval, backendProcess);
    }

    // Fish Speech answers its health check only once its model is loaded
    // and torch.compile has finished (up to a few minutes cold) -- StartAsync
    // only waits for the launch. The startup screen waits on this so Mana
    // appears (and listens) only once she can actually speak. False straight
    // away if Fish isn't in use (remote backend, not set up, failed start).
    public Task<bool> WaitForFishSpeechReadyAsync(TimeSpan timeout, TimeSpan? pollInterval = null) =>
        WaitForHealthyAsync(IsFishSpeechAvailable, "http://127.0.0.1:8080/v1/health", timeout, pollInterval);

    // #891: likewise for Qwen3-TTS, whose /health only answers once the
    // model is loaded and its CUDA graphs captured (~12 s).
    public Task<bool> WaitForQwen3TtsReadyAsync(TimeSpan timeout, TimeSpan? pollInterval = null) =>
        WaitForHealthyAsync(IsQwen3TtsAvailable, qwen3TtsHealthUrl, timeout, pollInterval);

    private async Task<bool> WaitForHealthyAsync(bool available, string healthUrl, TimeSpan timeout, TimeSpan? pollInterval, Process? process = null)
    {
        if (!isBackendLocal || !available)
        {
            return false;
        }
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            // A process that died won't answer, whatever else holds its port.
            if (process is { HasExited: true })
            {
                return false;
            }
            if (await IsServiceRunningAsync(healthUrl))
            {
                return true;
            }
            if (DateTime.UtcNow >= deadline)
            {
                return false;
            }
            await Task.Delay(pollInterval ?? TimeSpan.FromSeconds(2));
        }
    }

    private async Task<(Process? Process, bool Available)> StartIfNotRunningAsync(string healthUrl, Func<Task<Process?>> start)
    {
        if (await IsServiceRunningAsync(healthUrl))
        {
            // Already running externally -- nothing to start, but very
            // much available.
            return (null, true);
        }
        var process = await start();
        // For the backend, start() either returns a real process or
        // throws (fatal) -- so `process is not null` here is always true
        // whenever this line is reached at all. Fish Speech (and the #691
        // optional services) are the callers where start() can return null non-fatally (missing native
        // setup, or a launch failure) -- that's the actual degraded case.
        // #681: so is an unreachable remote backend, which is never spawned.
        return (process, process is not null);
    }

    private async Task<bool> IsServiceRunningAsync(string url)
    {
        try
        {
            using var response = await http.GetAsync(url);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    // Launches tools/fish_speech_native_server.py directly, not
    // tools/start_fish_speech_native.ps1 -- the .ps1 script's own
    // Start-Process call detaches the actual server process from the
    // launching shell (by design, so the script itself can exit after
    // polling health), which would leak that process past this app's
    // lifetime if we shelled out to the script instead of the server
    // directly. Launching it here via StartHiddenProcess gives
    // Dispose() a real, trackable, killable Process handle.
    //
    // This same tradeoff (a Start-Process-based launcher script vs. a
    // trackable handle) isn't unique to Fish Speech -- tools/start-local-
    // services.ps1 uses the identical shape for SearXNG and llama-server.
    // If this launcher adopts either of those the same way, expect to
    // re-solve this same fork, including re-porting whatever safety logic
    // that script carries (this file already had to re-port Fish Speech's
    // own RAM-headroom check below once).
    //
    // fish_speech_native_server.py's own docstring requires its working
    // directory be tools/fish-speech (it resolves checkpoint paths
    // relative to cwd) and takes no arguments of its own -- it hardcodes
    // `--compile` internally before handing off to the vendored
    // api_server.py.
    private Process? StartFishSpeech()
    {
        var fishDir = Path.Combine(RootDirectory, "tools", "fish-speech");
        var python = ResolveVenvPython(fishDir, ".venv-native");
        var serverScript = Path.Combine(RootDirectory, "tools", "fish_speech_native_server.py");
        if (!File.Exists(python) || !File.Exists(serverScript))
        {
            // Fish Speech missing its native setup is not fatal to app
            // startup -- its native setup (docs/fish_speech_tts.md) is a
            // substantial manual install most users won't have done yet.
            // Replies stay text-only until it's set up (no Kokoro fallback
            // by default; FISH_TTS_FALLBACK_PROVIDER=kokoro opts in).
            LogFishSpeechDiagnostic(
                fishDir,
                $"Fish Speech native setup incomplete (python.exe found: {File.Exists(python)}, fish_speech_native_server.py found: {File.Exists(serverScript)}); skipping -- no Fish Speech voice until it's set up (see docs/fish_speech_tts.md).");
            return null;
        }

        // Ported from start_fish_speech_native.ps1's own free-RAM check --
        // the checkpoint loads via mmap, which stages through host RAM
        // regardless of its eventual GPU destination, so a low-RAM machine
        // can crash here, not just run slowly. Warning only, not a hard
        // block, matching the .ps1 script's own behavior.
        var freeRamGB = GetFreeRamGB();
        if (freeRamGB < 6)
        {
            LogFishSpeechDiagnostic(
                fishDir,
                $"Warning: only {freeRamGB:F1}GB RAM free -- loading Fish Speech's checkpoint (peaks at ~3GB of host RAM) may be tight. Consider closing other apps first.");
        }

        try
        {
            // Redirected to the same log file names start_fish_speech_native.ps1
            // itself uses, so a failure here leaves the same diagnostic
            // trail a manual run of that script would -- unlike the
            // backend, Fish Speech's cold-compile startup is slow and
            // failure-prone enough (docs/fish_speech_tts.md) that silent
            // failure with nothing to inspect is a real cost.
            return StartHiddenProcess(
                python,
                Quote(serverScript),
                fishDir,
                stdoutLogPath: Path.Combine(fishDir, "native_server.out.log"),
                stderrLogPath: Path.Combine(fishDir, "native_server.err.log"));
        }
        catch (Exception ex)
        {
            // Same non-fatal reasoning as the missing-setup case above --
            // a launch failure here must not take down backend startup or
            // the voice loop.
            LogFishSpeechDiagnostic(fishDir, $"Fish Speech failed to start: {ex.Message} -- no Fish Speech voice until this is resolved.");
            return null;
        }
    }

    // #691: the local embedder (node-bot/tools/local_embedder.py) behind
    // semantic memory/session search, started the same way windows-launcher
    // does (main.js startEmbedderService): root venv python if present, else
    // "python" on PATH, Qwen3-Embedding-0.6B on port 9001. Optional like Fish
    // Speech -- missing script, MANA_START_EMBEDDER=0 or a launch failure just
    // leaves search keyword-only (retriever-index.js falls back when the
    // embedder doesn't answer), never a startup failure.
    private Process? StartEmbedder()
    {
        if (Environment.GetEnvironmentVariable("MANA_START_EMBEDDER") == "0")
        {
            return null;
        }
        var embedderScript = Path.Combine(RootDirectory, "node-bot", "tools", "local_embedder.py");
        if (!File.Exists(embedderScript))
        {
            return null;
        }
        var venvPython = ResolveVenvPython(RootDirectory, "venv");
        try
        {
            return StartHiddenProcess(
                File.Exists(venvPython) ? venvPython : "python",
                $"{Quote(embedderScript)} --port 9001 --model Qwen/Qwen3-Embedding-0.6B",
                RootDirectory);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Local embedder failed to start: {ex.Message} -- memory search stays keyword-only.");
            return null;
        }
    }

    // #691: local SearXNG behind web search (main.js startSearxngService).
    // Only when its venv is set up (docs/web_access_setup.md);
    // MANA_START_SEARXNG=0 skips it. Optional: web replies fail gracefully.
    private Process? StartSearxng()
    {
        var searxngDir = Path.Combine(RootDirectory, "tools", "searxng");
        var python = ResolveVenvPython(searxngDir, "venv");
        if (Environment.GetEnvironmentVariable("MANA_START_SEARXNG") == "0" || !File.Exists(python))
        {
            return null;
        }
        return StartOptional("SearXNG", python, "-m searx.webapp", searxngDir,
            new() { ["SEARXNG_SETTINGS_PATH"] = Path.Combine(searxngDir, "mana-settings.yml") });
    }

    // #691: tools/retriever_service.py (main.js startRetrieverService), only
    // with MANA_START_RETRIEVER=1 (see UsesRetriever). Optional: node-bot
    // starts it on demand otherwise.
    private Process? StartRetriever()
    {
        var retrieverScript = Path.Combine(RootDirectory, "tools", "retriever_service.py");
        if (!File.Exists(retrieverScript))
        {
            return null;
        }
        var venvPython = ResolveVenvPython(RootDirectory, "venv");
        return StartOptional("Python retriever", File.Exists(venvPython) ? venvPython : "python", $"-u {Quote(retrieverScript)}", RootDirectory);
    }

    // #691: GPT-SoVITS, only with TTS_PROVIDER=gpt_sovits (main.js
    // startGptSovitsService). It ships its own runtime python. Unlike
    // Electron, no Kokoro is started when it's missing -- node-bot starts
    // Kokoro on demand for its fallback (#745).
    private Process? StartGptSovits()
    {
        var gptSovitsDir = Path.Combine(RootDirectory, "tools", "gpt-sovits");
        var runtimePython = Path.Combine(gptSovitsDir, "runtime", "python.exe");
        var apiScript = Path.Combine(gptSovitsDir, "api_v2.py");
        if (!File.Exists(runtimePython) || !File.Exists(apiScript))
        {
            Console.WriteLine($"GPT-SoVITS not found at {gptSovitsDir}; see docs/gpt_sovits_setup.md.");
            return null;
        }
        // UTF-8 stdio: under cp1252 its Chinese debug print throws and it
        // silently returns 1 s of silence for every reply (see main.js).
        return StartOptional("GPT-SoVITS", runtimePython, $"{Quote(apiScript)} -a 127.0.0.1 -p 9880", gptSovitsDir,
            new() { ["PYTHONIOENCODING"] = "utf-8", ["PYTHONUTF8"] = "1" });
    }

    // #891: Qwen3-TTS (tools/qwen3tts_service.py), only with
    // TTS_PROVIDER=qwen3tts, from its own venv (docs/qwen3_tts.md). Logs
    // like Fish's, since a model-load failure is otherwise invisible;
    // BelowNormal so synthesis never competes with the foreground app.
    private Process? StartQwen3Tts()
    {
        var qwenDir = Path.Combine(RootDirectory, "tools", "qwen3-tts");
        var python = ResolveVenvPython(qwenDir, ".venv");
        var serviceScript = Path.Combine(RootDirectory, "tools", "qwen3tts_service.py");
        if (!File.Exists(python) || !File.Exists(serviceScript))
        {
            Console.WriteLine($"Qwen3-TTS not set up at {qwenDir}; see docs/qwen3_tts.md.");
            return null;
        }
        try
        {
            var process = StartHiddenProcess(
                python,
                Quote(serviceScript),
                qwenDir,
                stdoutLogPath: Path.Combine(qwenDir, "service.out.log"),
                stderrLogPath: Path.Combine(qwenDir, "service.err.log"));
            process.PriorityClass = ProcessPriorityClass.BelowNormal;
            return process;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Qwen3-TTS failed to start: {ex.Message}");
            return null;
        }
    }

    // A launch failure of an optional service is logged, never fatal.
    private static Process? StartOptional(string name, string fileName, string arguments, string workingDirectory, Dictionary<string, string>? environment = null)
    {
        try
        {
            return StartHiddenProcess(fileName, arguments, workingDirectory, environment: environment);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"{name} failed to start: {ex.Message}");
            return null;
        }
    }

    private Process StartBackend()
    {
        var nodeBotDir = Path.Combine(RootDirectory, "node-bot");
        var nodeServer = Path.Combine(nodeBotDir, "server.js");
        var whisperDir = Path.Combine(RootDirectory, "tools", "whisper");
        var startInfo = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = Quote(nodeServer),
            WorkingDirectory = nodeBotDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        startInfo.Environment["WHISPER_BIN"] =
            Environment.GetEnvironmentVariable("WHISPER_BIN") ??
            Path.Combine(whisperDir, "Release", "whisper-cli.exe");
        startInfo.Environment["WHISPER_MODEL"] =
            Environment.GetEnvironmentVariable("WHISPER_MODEL") ??
            Path.Combine(whisperDir, "models", "ggml-tiny.en.bin");
        // "fish" (Fish Speech / S1-mini) matches node-bot's own default
        // (tts-runtime.js: env.TTS_PROVIDER || (ttsBin ? "cli" : "fish")) and
        // docs/fish_speech_tts.md's stated default -- Kokoro only runs on
        // demand (gaming). KOKORO_TTS_FALLBACK_PROVIDER below is
        // a different, correctly-named variable (Kokoro's own fallback,
        // not Fish Speech's) and is left as-is.
        startInfo.Environment["TTS_PROVIDER"] =
            Environment.GetEnvironmentVariable("TTS_PROVIDER") ?? "fish";
        startInfo.Environment["KOKORO_TTS_FALLBACK_PROVIDER"] =
            Environment.GetEnvironmentVariable("KOKORO_TTS_FALLBACK_PROVIDER") ?? "none";
        startInfo.Environment["START_FALLBACK_CHATTERBOX"] = "0";
        // #691: matches windows-launcher (main.js), which turns embeddings on
        // by default alongside the embedder it starts; USE_EMBEDDINGS=0 opts out.
        startInfo.Environment["USE_EMBEDDINGS"] =
            Environment.GetEnvironmentVariable("USE_EMBEDDINGS") ?? "1";
        startInfo.Environment["MANA_LAUNCHER_KEY"] = LauncherKey;
        ApplyLocalOnly(startInfo.Environment, localOnly);

        var process = Process.Start(startInfo) ??
               throw new InvalidOperationException("Failed to start Mana backend.");

        // The same lines as Settings > Logs, also on disk; the last run's as
        // backend.prev.log. Under node-bot\data (never the launcher's own
        // folder, which an update renames). Once node has started, so a
        // failed start never creates folders; before reading its output.
        BackendLog.StartFile(Path.Combine(nodeBotDir, "data", "logs", "backend.log"));

        void OnLine(object? sender, DataReceivedEventArgs e)
        {
            if (e.Data is not null)
            {
                BackendLog.Add(e.Data);
            }
        }
        process.OutputDataReceived += OnLine;
        process.ErrorDataReceived += OnLine;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        process.Exited += (_, _) =>
        {
            if (process.ExitCode == BackendRestartExitCode)
            {
                BackendRestartRequested?.Invoke();
            }
        };
        process.EnableRaisingEvents = true;

        return process;
    }

    // #670: the Settings > Connection toggle. Only ever turns local-only
    // mode on; MANA_LOCAL_ONLY in node-bot/.env is node-bot's own switch.
    internal static void ApplyLocalOnly(IDictionary<string, string?> environment, bool localOnly)
    {
        if (localOnly)
        {
            environment["MANA_LAUNCHER_LOCAL_ONLY"] = "1";
        }
    }

    // Shared by StartFishSpeech/StartEmbedder -- both are "python from a
    // venv" services differing only in the venv's directory layout (Fish
    // Speech: tools/fish-speech/.venv-native/..., embedder: venv/...). What
    // to do when it's missing genuinely differs per caller and is
    // deliberately NOT folded into this helper.
    internal static string ResolveVenvPython(string venvRootDir, string venvSubdir)
    {
        return Path.Combine(venvRootDir, venvSubdir, "Scripts", "python.exe");
    }

    private static Process StartHiddenProcess(
        string fileName,
        string arguments,
        string workingDirectory,
        string? stdoutLogPath = null,
        string? stderrLogPath = null,
        Dictionary<string, string>? environment = null)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = stdoutLogPath is not null,
            RedirectStandardError = stderrLogPath is not null,
        };
        foreach (var (key, value) in environment ?? new())
        {
            startInfo.Environment[key] = value;
        }

        var process = Process.Start(startInfo) ??
               throw new InvalidOperationException($"Failed to start {fileName}.");

        if (stdoutLogPath is not null)
        {
            AttachLineLogger(process, isError: false, stdoutLogPath);
        }
        if (stderrLogPath is not null)
        {
            AttachLineLogger(process, isError: true, stderrLogPath);
        }

        return process;
    }

    // #479 review: this app is a WinExe (no console window), so
    // Console.WriteLine here previously wrote to a stream nobody was
    // attached to -- a user whose Fish Speech setup is incomplete or whose
    // launch failed had no way to find out short of the voice sounding
    // different. Appended (not truncated) so a launch failure survives
    // across restarts to actually be found, unlike the child process's own
    // fresh-per-launch stdout/stderr logs below. Best-effort: a log
    // directory that can't be written to must never fail the caller.
    private static void LogFishSpeechDiagnostic(string fishDir, string message)
    {
        Console.WriteLine(message);
        try
        {
            // No Directory.CreateDirectory here on purpose -- tools/fish-speech
            // already exists in any real checkout (it's the missing venv/
            // checkpoint inside it that triggers this), and this must stay a
            // pure best-effort write, never a reason to create directories
            // the caller (e.g. a test pointed at a nonexistent root) didn't
            // ask for.
            var logPath = Path.Combine(fishDir, "launcher.log");
            File.AppendAllText(logPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}");
        }
        catch
        {
            // Best effort.
        }
    }

    // Fresh log file per launch rather than accumulating forever, but the
    // previous run's log is kept as *.prev.log: a crash is only looked at
    // after the next launch, which used to truncate the log that had it.
    // Best-effort only: a log directory that can't be written to must
    // never prevent the service itself from starting.
    internal static void StartLogFile(string logPath)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            if (File.Exists(logPath))
            {
                File.Move(logPath, Path.ChangeExtension(logPath, ".prev.log"), overwrite: true);
            }
            File.WriteAllText(logPath, string.Empty);
        }
        catch
        {
            // Best effort.
        }
    }

    private static void AttachLineLogger(Process process, bool isError, string logPath)
    {
        StartLogFile(logPath);

        DataReceivedEventHandler handler = (_, e) =>
        {
            if (e.Data is null) return;
            try
            {
                File.AppendAllText(logPath, e.Data + Environment.NewLine);
            }
            catch
            {
                // Best effort.
            }
        };

        if (isError)
        {
            process.ErrorDataReceived += handler;
            process.BeginErrorReadLine();
        }
        else
        {
            process.OutputDataReceived += handler;
            process.BeginOutputReadLine();
        }
    }

    private static string Quote(string value)
    {
        return $"\"{value.Replace("\"", "\\\"")}\"";
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    // Ported from start_fish_speech_native.ps1's own free-RAM check (there,
    // via Get-CimInstance Win32_OperatingSystem). GlobalMemoryStatusEx is
    // the native Win32 equivalent -- avoids adding a new NuGet dependency
    // (e.g. System.Management) for a single read.
    private static double GetFreeRamGB()
    {
        var status = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        if (!GlobalMemoryStatusEx(ref status))
        {
            return double.MaxValue; // can't determine -- don't warn spuriously
        }
        return status.ullAvailPhys / 1024.0 / 1024.0 / 1024.0;
    }

    // Graceful, progress-reporting counterpart to Dispose()'s own
    // synchronous kill-and-forget -- used by the shutdown overlay so "Exit
    // Mana" isn't silently invisible while these processes actually stop.
    // Safe to run before Dispose() (called later from ExitThreadCore
    // regardless, as a safety net): StopProcess/Kill on an already-exited
    // process is already a no-op, so nothing here duplicates work Dispose()
    // would otherwise do.
    public async Task StopAllAsync(Action<string, bool>? onServiceStopped = null)
    {
        async Task StopAndReport(string key, Process? process)
        {
            if (process is not null && !process.HasExited)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    await process.WaitForExitAsync(timeout.Token);
                }
                catch
                {
                    // Best effort, same reasoning as StopProcess below --
                    // a stubborn process still gets its row's own
                    // stopped/still-running report either way.
                }
            }
            onServiceStopped?.Invoke(key, process is null || process.HasExited);
        }

        await Task.WhenAll(
            StopAndReport("backend", backendProcess),
            StopAndReport("fish-speech", fishSpeechProcess),
            StopAndReport("embedder", embedderProcess),
            StopAndReport("websearch", searxngProcess),
            StopAndReport("retriever", retrieverProcess),
            StopAndReport("gpt-sovits", gptSovitsProcess),
            StopAndReport("qwen3-tts", qwen3TtsProcess));
    }

    private bool disposed;

    public void Dispose()
    {
        disposed = true;
        http.Dispose();
        StopProcess(backendProcess);
        StopProcess(fishSpeechProcess);
        StopProcess(embedderProcess);
        StopProcess(searxngProcess);
        StopProcess(retrieverProcess);
        StopProcess(gptSovitsProcess);
        StopProcess(qwen3TtsProcess);
    }

    private static void StopProcess(Process? process)
    {
        if (process is null || process.HasExited)
        {
            return;
        }

        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best effort cleanup on app exit.
        }
    }
}
