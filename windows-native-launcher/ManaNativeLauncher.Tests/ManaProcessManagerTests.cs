using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ManaProcessManagerTests
{
    // #670: a fresh 256-bit key per launcher run, never a fixed value.
    [Fact]
    public void LauncherKey_IsAFreshRandomKeyPerRun()
    {
        using var first = new ManaProcessManager(@"C:\mana");
        using var second = new ManaProcessManager(@"C:\mana");

        Assert.Matches("^[0-9A-F]{64}$", first.LauncherKey);
        Assert.NotEqual(first.LauncherKey, second.LauncherKey);
    }

    // #670: the Settings toggle only ever turns local-only mode on, under
    // its own variable (so a MANA_LOCAL_ONLY line in node-bot/.env can't
    // turn it off).
    [Fact]
    public void ApplyLocalOnly_SetsTheLauncherVariableOnlyWhenOn()
    {
        var on = new Dictionary<string, string?>();
        var off = new Dictionary<string, string?>();

        ManaProcessManager.ApplyLocalOnly(on, true);
        ManaProcessManager.ApplyLocalOnly(off, false);

        Assert.Equal("1", on["MANA_LAUNCHER_LOCAL_ONLY"]);
        Assert.Empty(off);
    }

    // Part of #700: the check-ins toggle likewise only ever turns them off.
    [Fact]
    public void ApplyNoCheckIns_SetsTheLauncherVariableOnlyWhenOff()
    {
        var off = new Dictionary<string, string?>();
        var on = new Dictionary<string, string?>();

        ManaProcessManager.ApplyNoCheckIns(off, true);
        ManaProcessManager.ApplyNoCheckIns(on, false);

        Assert.Equal("0", off["MANA_LAUNCHER_CHECK_INS"]);
        Assert.Empty(on);
    }

    [Fact]
    public void ResolveVenvPython_UsesGivenVenvSubdirUnderRoot()
    {
        // Kokoro (venv) and Fish Speech (.venv-native) use different venv
        // directory names under different service roots -- this is the
        // one piece of the new startup logic that's pure and worth
        // covering directly.
        var kokoroPython = ManaProcessManager.ResolveVenvPython(@"C:\mana\tts-service", "venv");
        var fishPython = ManaProcessManager.ResolveVenvPython(@"C:\mana\tools\fish-speech", ".venv-native");

        Assert.Equal(@"C:\mana\tts-service\venv\Scripts\python.exe", kokoroPython);
        Assert.Equal(@"C:\mana\tools\fish-speech\.venv-native\Scripts\python.exe", fishPython);
    }

    // A crash is looked at after the next launch: the log that had it is
    // kept as *.prev.log instead of being truncated.
    [Fact]
    public void StartLogFile_KeepsThePreviousRunsLog()
    {
        var dir = Directory.CreateTempSubdirectory("mana-log-rotate-");
        try
        {
            var log = Path.Combine(dir.FullName, "service.err.log");
            ManaProcessManager.StartLogFile(log);
            File.AppendAllText(log, "first run crashed");

            ManaProcessManager.StartLogFile(log);
            Assert.Equal("", File.ReadAllText(log));
            Assert.Equal("first run crashed", File.ReadAllText(Path.Combine(dir.FullName, "service.err.prev.log")));

            File.AppendAllText(log, "second run");
            ManaProcessManager.StartLogFile(log);
            Assert.Equal("second run", File.ReadAllText(Path.Combine(dir.FullName, "service.err.prev.log")));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_StartsNothingWhenAllThreeServicesAlreadyHealthy()
    {
        // All three health checks report healthy -- StartIfNotRunningAsync
        // should skip every Start*() call, so this must complete without
        // touching the filesystem or spawning a process even though
        // rootDirectory below doesn't point at a real Mana checkout.
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);

        await manager.StartAsync();

        // #479 review: already-running-externally must read as available,
        // not as a degraded/fallback state -- there's no process handle
        // (nothing needed starting) but Fish Speech genuinely is up.
        Assert.True(manager.IsFishSpeechAvailable);
        // #991: a backend already running at launch isn't this launcher's to restart.
        Assert.False(manager.CanRestartBackend);
    }

    [Theory]
    [InlineData("kokoro", false)]
    [InlineData("fish", true)]
    public async Task StartAsync_WithTtsProviderUnset_FollowsTheBackendsChoice(string backendProvider, bool usesFish)
    {
        // #1076: node-bot picks Fish or Kokoro from the GPU when
        // TTS_PROVIDER is unset; the launcher starts (and even checks) Fish
        // Speech only when the backend's /health says "fish".
        var requested = new ConcurrentBag<string>();
        var handler = new FakeHttpMessageHandler(request =>
        {
            requested.Add(request.RequestUri!.GetLeftPart(UriPartial.Path));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(request.RequestUri.Port == 5005 ? $"{{\"ok\":true,\"ttsProvider\":\"{backendProvider}\"}}" : ""),
            };
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        Assert.Equal(usesFish, manager.UsesFishSpeech);
        Assert.Equal(usesFish, reported.ContainsKey("fish-speech"));
        Assert.Equal(usesFish, requested.Contains("http://127.0.0.1:8080/v1/health"));
        Assert.Equal(usesFish, manager.IsFishSpeechAvailable);
    }

    [Fact]
    public async Task StartAsync_DegradesGracefullyWhenFishSpeechNativeSetupIsMissing()
    {
        // The backend reports healthy already; Fish Speech doesn't, so
        // StartFishSpeech() runs for real against a rootDirectory with no
        // fish-speech venv -- exercising the graceful-degradation path (log
        // a warning, return null). Must not throw.
        var handler = new FakeHttpMessageHandler(request =>
        {
            var isFishSpeech = request.RequestUri!.Port == 8080;
            return new HttpResponseMessage(isFishSpeech ? HttpStatusCode.NotFound : HttpStatusCode.OK);
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);

        await manager.StartAsync();

        // #479 review: this is the actual degraded case -- must read as
        // unavailable so a caller (the tray status) can tell the user
        // Fish Speech isn't answering.
        Assert.False(manager.IsFishSpeechAvailable);
    }

    [Fact]
    public async Task StartAsync_UsesTheConfiguredBackendBaseUrlForTheHealthCheck_NotTheHardcodedDefault()
    {
        // Previously hardcoded to 127.0.0.1:5005 regardless of a
        // user-configured BackendBaseUrl (ManaSettingsStore) -- a custom
        // URL would silently health-check (and, if unhealthy, try to spawn
        // a local node-bot process for) the wrong address entirely.
        Uri? backendRequestUri = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            if (request.RequestUri!.Port == 6006) backendRequestUri = request.RequestUri;
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler, backendBaseUrl: "http://127.0.0.1:6006");

        await manager.StartAsync();

        Assert.NotNull(backendRequestUri);
        Assert.Equal("/health", backendRequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task StartAsync_FallsBackToThe127005DefaultHealthCheckUrl_WhenNoBackendBaseUrlIsGiven()
    {
        // Existing call sites (and every other test in this file) don't
        // pass backendBaseUrl -- must keep working exactly as before.
        Uri? backendRequestUri = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            if (request.RequestUri!.Port == 5005) backendRequestUri = request.RequestUri;
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);

        await manager.StartAsync();

        Assert.NotNull(backendRequestUri);
        Assert.Equal("/health", backendRequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task StartAsync_ReportsProgressForEachServiceByKey()
    {
        // #479 follow-up (startup overlay): onServiceReady must fire once
        // per service with the same keys the overlay's row definitions
        // use ("backend"/"fish-speech"/"embedder"), not e.g. a display
        // label -- a mismatch here would silently leave that row stuck on
        // "Waiting..." forever. #694: no "kokoro" key -- node-bot starts
        // Kokoro on demand now.
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        // #691: no "retriever"/"gpt-sovits" either -- both are opt-in.
        Assert.Equal(
            new Dictionary<string, bool> { ["backend"] = true, ["fish-speech"] = true, ["embedder"] = true, ["websearch"] = true },
            new Dictionary<string, bool>(reported));
    }

    // #681: an unhealthy remote backend must be reported unavailable, not
    // "fixed" by spawning a local node-bot. The loopback case below is the
    // control: same unhealthy backend, and it does try to spawn (which
    // throws here, since C:\does-not-exist has no node-bot folder).
    [Fact]
    public async Task StartAsync_DoesNotSpawnALocalBackendForARemoteBackendUrl()
    {
        var handler = new FakeHttpMessageHandler(request =>
            new HttpResponseMessage(request.RequestUri!.Host == "192.168.1.50" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler, backendBaseUrl: "http://192.168.1.50:5005");
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        Assert.False(reported["backend"]);
    }

    [Fact]
    public async Task StartAsync_SkipsLocalTtsWithoutThrowing_ForARemoteBackendUrl()
    {
        // A remote backend synthesizes on its own machine, so Fish Speech
        // isn't started locally.
        var handler = new FakeHttpMessageHandler(request =>
            new HttpResponseMessage(request.RequestUri!.Host == "192.168.1.50" ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler, backendBaseUrl: "http://192.168.1.50:5005");
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        Assert.True(reported["backend"]);
        Assert.False(reported["fish-speech"]);
        Assert.False(manager.IsBackendLocal);
    }

    [Theory]
    [InlineData("http://127.0.0.1:5005")]
    [InlineData("http://localhost:5005")]
    public async Task StartAsync_StillSpawnsALocalBackendForALoopbackUrl(string baseUrl)
    {
        var handler = new FakeHttpMessageHandler(request =>
            new HttpResponseMessage(request.RequestUri!.Port == 5005 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler, backendBaseUrl: baseUrl);

        await Assert.ThrowsAnyAsync<System.Exception>(() => manager.StartAsync());
    }

    [Fact]
    public async Task StartAsync_ReportsTheEmbedderUnavailableWithoutThrowing_WhenItsScriptIsMissing()
    {
        // #691: the embedder is optional -- unhealthy on 9001 plus no
        // local_embedder.py under rootDirectory must degrade (row reads
        // Unavailable, search stays keyword-only), never fail startup.
        var handler = new FakeHttpMessageHandler(request =>
            new HttpResponseMessage(request.RequestUri!.Port == 9001 ? HttpStatusCode.NotFound : HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        Assert.False(reported["embedder"]);
        Assert.True(reported["backend"]);
    }

    [Fact]
    public async Task StartAsync_LeavesTheEmbedderToTheBackend_WhenMANA_EMBEDDER_MODELIsSet()
    {
        // node-bot runs the GPU embedder on demand: the Python one on 9001
        // is neither checked nor started, and the row still reads Ready.
        var model = System.IO.Path.GetTempFileName();
        Environment.SetEnvironmentVariable("MANA_EMBEDDER_MODEL", model);
        try
        {
            var requestedPorts = new ConcurrentBag<int>();
            var handler = new FakeHttpMessageHandler(request =>
            {
                requestedPorts.Add(request.RequestUri!.Port);
                return new HttpResponseMessage(HttpStatusCode.OK);
            });
            using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
            var reported = new ConcurrentDictionary<string, bool>();

            await manager.StartAsync((key, available) => reported[key] = available);

            Assert.DoesNotContain(9001, requestedPorts);
            Assert.True(reported["embedder"]);
        }
        finally
        {
            Environment.SetEnvironmentVariable("MANA_EMBEDDER_MODEL", null);
            System.IO.File.Delete(model);
        }
    }

    [Fact]
    public async Task StartAsync_NeverChecksOrStartsKokoro()
    {
        // #694 / user decision: Kokoro is started on demand by node-bot
        // (kokoro-runtime.js), never by this launcher -- not even a health
        // check on its port.
        var requestedPorts = new ConcurrentBag<int>();
        var handler = new FakeHttpMessageHandler(request =>
        {
            requestedPorts.Add(request.RequestUri!.Port);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        Assert.DoesNotContain(5011, requestedPorts);
        Assert.False(reported.ContainsKey("kokoro"));
    }

    [Fact]
    public async Task OverlayRows_MatchTheKeysStartAsyncReports()
    {
        // Every overlay row gets a status and no report goes to a missing
        // row (StartupOverlayForm.SetRowStatus ignores unknown keys).
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        Assert.Equal(
            ManaApplicationContext.ServiceRowsFor(manager).Select(row => row.Key).OrderBy(key => key),
            reported.Keys.OrderBy(key => key));
    }

    [Fact]
    public async Task StartAsync_OptInServicesGetARowAndDegradeWithoutThrowing_WhenTurnedOn()
    {
        // #691: MANA_START_RETRIEVER=1 and TTS_PROVIDER=gpt_sovits add the
        // retriever and GPT-SoVITS; with nothing answering and nothing
        // installed under the root, they (and SearXNG) read Unavailable
        // instead of failing startup. Only the selected TTS starts, so Fish
        // Speech is never checked, reported or waited on.
        Environment.SetEnvironmentVariable("MANA_START_RETRIEVER", "1");
        Environment.SetEnvironmentVariable("TTS_PROVIDER", "gpt_sovits");
        try
        {
            var requested = new ConcurrentBag<string>();
            var handler = new FakeHttpMessageHandler(request =>
            {
                requested.Add(request.RequestUri!.GetLeftPart(UriPartial.Path));
                return new HttpResponseMessage(request.RequestUri.Port == 5005 ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
            });
            using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
            var reported = new ConcurrentDictionary<string, bool>();

            await manager.StartAsync((key, available) => reported[key] = available);

            Assert.False(reported["websearch"]);
            Assert.False(reported["retriever"]);
            Assert.False(reported["gpt-sovits"]);
            Assert.Contains("http://127.0.0.1:9880/docs", requested);
            Assert.False(reported.ContainsKey("fish-speech"));
            Assert.DoesNotContain(requested, url => new Uri(url).Port == 8080);
            Assert.False(manager.IsFishSpeechAvailable);
            Assert.Equal(
                ManaApplicationContext.ServiceRowsFor(manager).Select(row => row.Key).OrderBy(key => key),
                reported.Keys.OrderBy(key => key));
        }
        finally
        {
            Environment.SetEnvironmentVariable("MANA_START_RETRIEVER", null);
            Environment.SetEnvironmentVariable("TTS_PROVIDER", null);
        }
    }

    [Fact]
    public async Task StartAsync_WithQwen3Tts_StartsItInsteadOfFishSpeech()
    {
        // #891: TTS_PROVIDER=qwen3tts checks (and would start) only
        // Qwen3-TTS; with nothing installed under the root it reads
        // Unavailable, and Fish Speech is never checked or reported.
        Environment.SetEnvironmentVariable("TTS_PROVIDER", "qwen3tts");
        try
        {
            var requested = new ConcurrentBag<string>();
            var handler = new FakeHttpMessageHandler(request =>
            {
                requested.Add(request.RequestUri!.GetLeftPart(UriPartial.Path));
                return new HttpResponseMessage(request.RequestUri.Port == 5005 ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
            });
            using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
            var reported = new ConcurrentDictionary<string, bool>();

            await manager.StartAsync((key, available) => reported[key] = available);

            Assert.False(reported["qwen3-tts"]);
            Assert.False(manager.IsQwen3TtsAvailable);
            Assert.Contains("http://127.0.0.1:5012/health", requested);
            Assert.False(reported.ContainsKey("fish-speech"));
            Assert.DoesNotContain(requested, url => new Uri(url).Port == 8080);
            Assert.Equal(
                ManaApplicationContext.ServiceRowsFor(manager).Select(row => row.Key).OrderBy(key => key),
                reported.Keys.OrderBy(key => key));
        }
        finally
        {
            Environment.SetEnvironmentVariable("TTS_PROVIDER", null);
        }
    }

    [Fact]
    public async Task WaitForFishSpeechReady_ReturnsTrueOnceFishAnswers()
    {
        // Healthy at launch (so it counts as available), then warming up
        // for two polls, then ready.
        var fishCalls = 0;
        var handler = new FakeHttpMessageHandler(request =>
        {
            if (request.RequestUri!.Port != 8080) return new HttpResponseMessage(HttpStatusCode.OK);
            fishCalls++;
            return new HttpResponseMessage(fishCalls is 2 or 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK);
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        await manager.StartAsync();

        Assert.True(await manager.WaitForFishSpeechReadyAsync(TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(1)));
        Assert.Equal(4, fishCalls);
    }

    [Fact]
    public async Task WaitForFishSpeechReady_ReturnsFalseAfterTheTimeout()
    {
        var fishCalls = 0;
        var handler = new FakeHttpMessageHandler(request =>
        {
            if (request.RequestUri!.Port != 8080) return new HttpResponseMessage(HttpStatusCode.OK);
            fishCalls++;
            return new HttpResponseMessage(fishCalls == 1 ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        await manager.StartAsync();

        Assert.False(await manager.WaitForFishSpeechReadyAsync(TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(5)));
    }

    [Fact]
    public async Task WaitForFishSpeechReady_ReturnsFalseImmediatelyWhenFishIsNotInUse()
    {
        // Not healthy and no native setup under the root: never started.
        var handler = new FakeHttpMessageHandler(request =>
            new HttpResponseMessage(request.RequestUri!.Port == 8080 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        await manager.StartAsync();

        var watch = System.Diagnostics.Stopwatch.StartNew();
        Assert.False(await manager.WaitForFishSpeechReadyAsync(TimeSpan.FromMinutes(6)));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task StopAllAsync_ReportsStoppedForEveryServiceWithNoProcessHandleToKill()
    {
        // No StartAsync call means backendProcess/fishSpeechProcess/
        // embedderProcess are all still null (nothing this manager
        // itself launched) -- StopAllAsync must report each as stopped
        // rather than hang or throw trying to kill a process it never
        // actually holds a handle for.
        using var manager = new ManaProcessManager(@"C:\does-not-exist");
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StopAllAsync((key, stopped) => reported[key] = stopped);

        Assert.Equal(
            new Dictionary<string, bool>
            {
                ["backend"] = true, ["fish-speech"] = true, ["embedder"] = true,
                ["websearch"] = true, ["retriever"] = true, ["gpt-sovits"] = true,
                ["qwen3-tts"] = true,
            },
            new Dictionary<string, bool>(reported));
    }

    [Fact]
    public void RestartFishSpeech_WithMissingNativeSetup_LeavesItUnavailableWithoutThrowing()
    {
        // #479 review: the manual "Restart Fish Speech" tray action, tested
        // directly (not via StartAsync) -- same missing-setup degrade path,
        // must not throw and must update IsFishSpeechAvailable.
        using var manager = new ManaProcessManager(@"C:\does-not-exist");

        manager.RestartFishSpeech();

        Assert.False(manager.IsFishSpeechAvailable);
    }

    // #991: a fake node-bot (a real node process), so the test can see the
    // old one stopped and a new one started in its place.
    private static string FakeNodeBot(string script)
    {
        var root = Path.Combine(Path.GetTempPath(), "mana-restart-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "node-bot"));
        File.WriteAllText(Path.Combine(root, "node-bot", "server.js"), script);
        return root;
    }

    [Fact]
    public async Task RestartBackendAsync_ReplacesTheNodeBotItStartedAndWaitsForItsHealth()
    {
        // Each one creates its own <pid>.pid file: with one shared pids.txt,
        // the new node's append hit EBUSY whenever the test was reading the
        // file (File.ReadAllLines shares read only) and it died unseen.
        var root = FakeNodeBot("require('fs').writeFileSync(process.pid + '.pid', ''); setInterval(() => {}, 1000);");
        var backendUp = false;
        var handler = new FakeHttpMessageHandler(request =>
            new HttpResponseMessage(request.RequestUri!.Port == 5005 && backendUp ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable));
        // #1076: a set provider, so StartAsync doesn't wait for this
        // not-yet-healthy backend's TTS pick.
        Environment.SetEnvironmentVariable("TTS_PROVIDER", "kokoro");
        try
        {
            using var manager = new ManaProcessManager(root, handler);
            await manager.StartAsync();
            Assert.True(manager.CanRestartBackend);
            // #1151: this is the CI job's first node launch, which a cold
            // runner can take over 20 s to start (node printed nothing), so
            // the first wait is longer; the restart's node is warm.
            async Task<int[]> Pids(int count, int seconds, string which)
            {
                var deadline = DateTime.UtcNow.AddSeconds(seconds);
                while (true)
                {
                    var pids = Directory.GetFiles(Path.Combine(root, "node-bot"), "*.pid")
                        .Select(file => int.Parse(Path.GetFileNameWithoutExtension(file)))
                        .ToArray();
                    if (pids.Length >= count)
                    {
                        return pids;
                    }
                    Assert.True(DateTime.UtcNow < deadline,
                        $"Only {pids.Length} of {count} fake node-bots started within {seconds} s ({which}). Their output: [{string.Join(" | ", manager.BackendLog.Snapshot())}]");
                    await Task.Delay(50);
                }
            }
            var first = Assert.Single(await Pids(1, 60, "first launch, may be a cold start"));
            backendUp = true;

            Assert.True(await manager.RestartBackendAsync(TimeSpan.FromSeconds(20), TimeSpan.FromMilliseconds(50)));

            var second = Assert.Single(await Pids(2, 20, "after the restart"), pid => pid != first);
            Assert.False(IsRunning(first));
            Assert.True(IsRunning(second));
        }
        finally
        {
            Environment.SetEnvironmentVariable("TTS_PROVIDER", null);
            DeleteBestEffort(root);
        }
    }

    [Fact]
    public async Task BackendRestartRequested_FiresWhenNodeBotExitsWithTheRestartCode()
    {
        var root = FakeNodeBot("process.exit(77);");
        var requested = new TaskCompletionSource();
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
        try
        {
            using var manager = new ManaProcessManager(root, handler);
            manager.BackendRestartRequested += () => requested.TrySetResult();
            await manager.StartAsync();

            await requested.Task.WaitAsync(TimeSpan.FromSeconds(20));
        }
        finally
        {
            DeleteBestEffort(root);
        }
    }

    private static bool IsRunning(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    // A just-killed node may still hold its working directory for a moment.
    private static void DeleteBestEffort(string root)
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
