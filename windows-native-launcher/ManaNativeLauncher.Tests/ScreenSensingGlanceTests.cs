using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #690: the ambient screen glance loop, ported from Electron.
public class ScreenSensingGlanceTests
{
    private sealed class Harness
    {
        public bool VoiceIdle = true;
        public bool Gaming;
        public long IdleMs;
        public int Captures;
        public string? Path;
        public string? Body;
        public HttpStatusCode Status = HttpStatusCode.OK;
        public string Response = "{\"shouldSurface\":true,\"reason\":\"new\",\"summary\":\"Looks like you're debugging a test.\"}";
        public Action? DuringRequest;
        public readonly List<string> Surfaced = [];

        public ScreenSensingGlance Build() => new(
            new ManaBackendClient(new FakeHttpMessageHandler(request =>
            {
                Path = request.RequestUri!.AbsolutePath;
                Body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                DuringRequest?.Invoke();
                return new HttpResponseMessage(Status) { Content = new StringContent(Response, Encoding.UTF8, "application/json") };
            })),
            () => VoiceIdle,
            () => Gaming,
            () => IdleMs,
            () => { Captures++; return "data:image/jpeg;base64,AAAA"; },
            Surfaced.Add,
            presenceIdleMs: 90000);
    }

    [Fact]
    public async Task PostsTheScreenshotAndShowsASurfacedSummary()
    {
        var h = new Harness();
        await h.Build().RunOnceAsync();

        Assert.Equal("/screen-sensing/glance", h.Path);
        Assert.Contains("\"image\":\"data:image/jpeg;base64,AAAA\"", h.Body);
        Assert.Contains("\"gamingModeActive\":false", h.Body);
        Assert.Equal(["Looks like you're debugging a test."], h.Surfaced);
    }

    [Fact]
    public async Task ShowsNothingWhenTheGateSaysNo()
    {
        var h = new Harness { Response = "{\"shouldSurface\":false,\"reason\":\"cooldown\"}" };
        await h.Build().RunOnceAsync();
        Assert.Equal(1, h.Captures);
        Assert.Empty(h.Surfaced);
    }

    [Theory]
    [InlineData(false, false, 0)]      // a turn in flight / she's speaking
    [InlineData(true, true, 0)]        // gaming
    [InlineData(true, false, 90000)]   // nobody at the keyboard/mouse
    public async Task SkipsWithoutCapturing(bool voiceIdle, bool gaming, long idleMs)
    {
        var h = new Harness { VoiceIdle = voiceIdle, Gaming = gaming, IdleMs = idleMs };
        await h.Build().RunOnceAsync();
        Assert.Equal(0, h.Captures);
        Assert.Null(h.Path);
    }

    [Fact]
    public async Task DropsTheSummaryIfATurnStartedMeanwhile()
    {
        var h = new Harness();
        h.DuringRequest = () => h.VoiceIdle = false;
        await h.Build().RunOnceAsync();
        Assert.Empty(h.Surfaced);
    }

    [Fact]
    public async Task ABackendErrorIsSwallowedAndTheNextGlanceStillRuns()
    {
        var h = new Harness { Status = HttpStatusCode.InternalServerError, Response = "{\"error\":\"vision down\"}" };
        var glance = h.Build();
        await glance.RunOnceAsync();
        Assert.Empty(h.Surfaced);

        h.Status = HttpStatusCode.OK;
        h.Response = "{\"shouldSurface\":true,\"summary\":\"Back again.\"}";
        await glance.RunOnceAsync();
        Assert.Equal(["Back again."], h.Surfaced);
    }
}
