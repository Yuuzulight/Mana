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
    }
}
