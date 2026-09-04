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
        // Kokoro and the backend report healthy already; Fish Speech
        // doesn't, so StartFishSpeech() runs for real against a
        // rootDirectory with no fish-speech venv -- exercising the
        // graceful-degradation path this PR adds (log a warning, return
        // null) rather than the fatal throw Kokoro's missing-venv case
        // uses. Must not throw.
        var handler = new FakeHttpMessageHandler(request =>
        {
            var isFishSpeech = request.RequestUri!.Port == 8080;
            return new HttpResponseMessage(isFishSpeech ? HttpStatusCode.NotFound : HttpStatusCode.OK);
        });
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);

        await manager.StartAsync();

        // #479 review: this is the actual degraded case -- must read as
        // unavailable so a caller (the tray status) can tell the user
        // Kokoro is silently covering for it.
        Assert.False(manager.IsFishSpeechAvailable);
    }

    [Fact]
    public async Task StartAsync_ReportsProgressForEachServiceByKey()
    {
        // #479 follow-up (startup overlay): onServiceReady must fire once
        // per service with the same keys the overlay's row definitions
        // use ("backend"/"kokoro"/"fish-speech"), not e.g. a display label
        // -- a mismatch here would silently leave that row stuck on
        // "Waiting..." forever.
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK));
        using var manager = new ManaProcessManager(@"C:\does-not-exist", handler);
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StartAsync((key, available) => reported[key] = available);

        Assert.Equal(
            new Dictionary<string, bool> { ["backend"] = true, ["kokoro"] = true, ["fish-speech"] = true },
            new Dictionary<string, bool>(reported));
    }

    [Fact]
    public async Task StopAllAsync_ReportsStoppedForEveryServiceWithNoProcessHandleToKill()
    {
        // No StartAsync call means backendProcess/kokoroProcess/
        // fishSpeechProcess are all still null (nothing this manager
        // itself launched) -- StopAllAsync must report each as stopped
        // rather than hang or throw trying to kill a process it never
        // actually holds a handle for.
        using var manager = new ManaProcessManager(@"C:\does-not-exist");
        var reported = new ConcurrentDictionary<string, bool>();

        await manager.StopAllAsync((key, stopped) => reported[key] = stopped);

        Assert.Equal(
            new Dictionary<string, bool> { ["backend"] = true, ["kokoro"] = true, ["fish-speech"] = true },
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
