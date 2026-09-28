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

        Assert.Equal(
            new Dictionary<string, bool> { ["backend"] = true, ["fish-speech"] = true, ["embedder"] = true },
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
            ManaApplicationContext.ServiceRows.Select(row => row.Key).OrderBy(key => key),
            reported.Keys.OrderBy(key => key));
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
            new Dictionary<string, bool> { ["backend"] = true, ["fish-speech"] = true, ["embedder"] = true },
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
}
