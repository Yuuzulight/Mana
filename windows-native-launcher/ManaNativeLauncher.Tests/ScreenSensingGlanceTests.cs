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
        public int TextReads;
        public string ScreenText = ""; // "" = nothing readable, so the image goes
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
            () => { TextReads++; return Task.FromResult(ScreenText); },
            () => { Captures++; return "data:image/jpeg;base64,AAAA"; },
            Surfaced.Add,
            presenceIdleMs: 90000);
    }

    [Fact]
    public async Task SendsTheWindowsTextFirstWithoutCapturingTheScreen()
    {
        var h = new Harness { ScreenText = "  Visual Studio Code - VoiceLoop.cs - fixing a failing test  " };
        await h.Build().RunOnceAsync();

        Assert.Equal(0, h.Captures);
        Assert.Contains("\"text\":\"Visual Studio Code - VoiceLoop.cs - fixing a failing test\"", h.Body);
        Assert.DoesNotContain("\"image\"", h.Body);
        Assert.Equal(["Looks like you're debugging a test."], h.Surfaced);
    }

    [Fact]
    public async Task FallsBackToTheScreenshotWhenTheTextIsTooThin()
    {
        var h = new Harness { ScreenText = "OK" };
        await h.Build().RunOnceAsync();

        Assert.Equal(1, h.TextReads);
        Assert.Equal(1, h.Captures);
        Assert.Contains("\"image\":", h.Body);
        Assert.DoesNotContain("\"text\"", h.Body);
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
        Assert.Equal(0, h.TextReads);
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

    // #1286
    [Fact]
    public async Task ABlockedWindowIsNeverReadOrCaptured()
    {
        var h = new Harness();
        var glance = new ScreenSensingGlance(
            new ManaBackendClient(new FakeHttpMessageHandler(_ => throw new InvalidOperationException("no backend call"))),
            () => true, () => false, () => 0,
            () => { h.TextReads++; return Task.FromResult("Bitwarden vault - lots of secrets here"); },
            () => { h.Captures++; return "data:image/jpeg;base64,AAAA"; },
            h.Surfaced.Add,
            presenceIdleMs: 90000,
            blockReason: () => "bitwarden is a private app");
        await glance.RunOnceAsync();
        Assert.Equal(0, h.TextReads);
        Assert.Equal(0, h.Captures);
        Assert.Empty(h.Surfaced);
    }

    [Fact]
    public async Task AnUnchangedScreenIsNotSentAgain()
    {
        var h = new Harness { ScreenText = "Visual Studio Code - VoiceLoop.cs - fixing a failing test" };
        var glance = h.Build();
        await glance.RunOnceAsync();
        h.Path = null;
        await glance.RunOnceAsync();
        Assert.Null(h.Path);

        h.ScreenText = "Visual Studio Code - ChatView.cs - something else entirely";
        await glance.RunOnceAsync();
        Assert.Equal("/screen-sensing/glance", h.Path);
    }
}

// #1286
public class ScreenPrivacyGuardTests
{
    private static readonly string[] NoList = [];

    [Theory]
    [InlineData("KeePassXC", "Passwords.kdbx - KeePassXC")]
    [InlineData("Bitwarden", "Bitwarden")]
    [InlineData("LockApp", "")]
    [InlineData("consent", "User Account Control")]
    [InlineData("msedge", "New tab - [InPrivate] - Microsoft Edge")]
    [InlineData("chrome", "New Tab - Google Chrome (Incognito)")]
    [InlineData("firefox", "Mozilla Firefox Private Browsing")]
    [InlineData("chrome", "DBS iBanking - Google Chrome")]
    [InlineData("chrome", "Change password - Google Account")]
    public void BlocksPrivateWindows(string process, string title) =>
        Assert.NotNull(ScreenPrivacyGuard.BlockReason(1, process, title, NoList));

    [Fact]
    public void BlocksWhenNothingIsInFront() =>
        Assert.NotNull(ScreenPrivacyGuard.BlockReason(IntPtr.Zero, "", "", NoList));

    [Fact]
    public void AllowsOrdinaryWindows() =>
        Assert.Null(ScreenPrivacyGuard.BlockReason(1, "Code", "VoiceLoop.cs - Mana - Visual Studio Code", NoList));

    [Fact]
    public void HonoursTheUserBlocklist()
    {
        var list = ScreenPrivacyGuard.ParseList(" signal ; Tax return,");
        Assert.Equal(["signal", "Tax return"], list);
        Assert.NotNull(ScreenPrivacyGuard.BlockReason(1, "Signal", "Signal", list));
        Assert.NotNull(ScreenPrivacyGuard.BlockReason(1, "WINWORD", "tax return 2026.docx - Word", list));
        Assert.Null(ScreenPrivacyGuard.BlockReason(1, "notepad", "notes.txt - Notepad", list));
    }

    [Theory]
    [InlineData("23:00-07:00", 23, 30, true)]
    [InlineData("23:00-07:00", 3, 0, true)]
    [InlineData("23:00-07:00", 7, 0, false)]
    [InlineData("23:00-07:00", 12, 0, false)]
    [InlineData("13:00-14:00", 13, 15, true)]
    [InlineData("13:00-14:00", 14, 15, false)]
    [InlineData("", 3, 0, false)]
    [InlineData("nonsense", 3, 0, false)]
    public void QuietHours(string spec, int hour, int minute, bool quiet) =>
        Assert.Equal(quiet, ScreenPrivacyGuard.InQuietHours(spec, new TimeSpan(hour, minute, 0)));
}

// #1286
public class GlanceTriggerTests
{
    private static readonly IntPtr Editor = 1, Browser = 2;

    [Fact]
    public void GlancesOnceAWindowSwitchHasSettled()
    {
        var t = new GlanceTrigger(settleMs: 2000, minIntervalMs: 30000, fallbackMs: 600000, nowMs: 0);
        Assert.False(t.Poll(Editor, "a.cs - Code", 40000));  // just switched
        Assert.False(t.Poll(Editor, "a.cs - Code", 41000));  // still settling
        Assert.True(t.Poll(Editor, "a.cs - Code", 42000));
        Assert.False(t.Poll(Editor, "a.cs - Code", 43000));  // nothing new since
    }

    [Fact]
    public void RespectsTheMinimumIntervalAndCoalesces()
    {
        var t = new GlanceTrigger(2000, 30000, 600000, 0);
        t.Poll(Editor, "a.cs - Code", 40000);
        Assert.True(t.Poll(Editor, "a.cs - Code", 42000));
        t.Poll(Browser, "Docs - Chrome", 43000);
        t.Poll(Editor, "b.cs - Code", 50000);
        Assert.False(t.Poll(Editor, "b.cs - Code", 60000)); // within 30s of the last glance
        Assert.True(t.Poll(Editor, "b.cs - Code", 72000));  // one glance for both switches
    }

    [Fact]
    public void IgnoresCountersAndUnsavedMarkers()
    {
        var t = new GlanceTrigger(2000, 30000, 600000, 0);
        t.Poll(Browser, "(3) Inbox - Gmail", 40000);
        Assert.True(t.Poll(Browser, "(3) Inbox - Gmail", 42000));
        Assert.False(t.Poll(Browser, "(4) Inbox - Gmail", 80000));
        Assert.Equal(GlanceTrigger.MeaningfulTitle("● a.cs - Code"), GlanceTrigger.MeaningfulTitle("a.cs - Code"));
    }

    [Fact]
    public void FallsBackToTheSlowTimer()
    {
        var t = new GlanceTrigger(2000, 30000, 600000, 0);
        t.Poll(Editor, "a.cs - Code", 1000);
        Assert.True(t.Poll(Editor, "a.cs - Code", 30000));
        Assert.False(t.Poll(Editor, "a.cs - Code", 500000));
        Assert.True(t.Poll(Editor, "a.cs - Code", 630000));
    }
}
