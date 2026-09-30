using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1008: the "What I'm working on" window's data and text, and the notice payload.
public class SelfWorkFormTests
{
    private static ManaBackendClient ClientReturning(string json, Action<HttpRequestMessage>? seen = null) =>
        new(new FakeHttpMessageHandler(request =>
        {
            seen?.Invoke(request);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));

    [Fact]
    public async Task GetSelfWorkAsync_ReadsTheRunAndItsSteps()
    {
        string? path = null;
        var client = ClientReturning(
            """
            {"state":"running","issue":12,"title":"Fix the add helper","branch":"mana/12-fix-the-add-helper",
             "worktree":"D:\\Mana-worktrees\\mana-12","step":"Running node --test test/util.test.js","prUrl":null,
             "log":[{"at":"t1","text":"I'm starting on #12: Fix the add helper"},{"at":"t2","text":"Changed node-bot/util.js"}]}
            """,
            request => path = request.RequestUri!.AbsolutePath);

        var status = await client.GetSelfWorkAsync();

        Assert.Equal("/self-work", path);
        Assert.Equal("running", status.State);
        Assert.Equal(12, status.Issue);
        Assert.Null(status.PrUrl);
        Assert.Equal(["I'm starting on #12: Fix the add helper", "Changed node-bot/util.js"], status.Log);
        Assert.Equal(
            $"#12: Fix the add helper{Environment.NewLine}Working on it -- Running node --test test/util.test.js{Environment.NewLine}mana/12-fix-the-add-helper in D:\\Mana-worktrees\\mana-12",
            SelfWorkForm.Describe(status));
    }

    [Fact]
    public async Task Idle_SaysSo()
    {
        var status = await ClientReturning("""{"state":"idle"}""").GetSelfWorkAsync();
        Assert.Null(status.Issue);
        Assert.Equal("I'm not working on my own code right now.", SelfWorkForm.Describe(status));
    }

    [Fact]
    public async Task StartSelfWorkAsync_PostsTheIssueAndReturnsWhyNot()
    {
        string? body = null;
        var started = ClientReturning("""{"ok":true}""", request => body = request.Content!.ReadAsStringAsync().Result);
        Assert.Null(await started.StartSelfWorkAsync(12));
        Assert.Equal("""{"issue":12}""", body);

        // #1009: a flagged run says so; an ordinary one doesn't send the field at all.
        Assert.Null(await started.StartSelfWorkAsync(12, allowGuardrails: true));
        Assert.Equal("""{"issue":12,"allowGuardrails":true}""", body);

        var refused = ClientReturning("""{"ok":false,"error":"2 of my PRs are waiting for your review"}""");
        Assert.Equal("2 of my PRs are waiting for your review", await refused.StartSelfWorkAsync(12));
    }

    [Theory]
    [InlineData("https://github.com/Yuuzulight/Mana/pull/1020", true)]
    [InlineData("http://github.com/Yuuzulight/Mana/pull/1020", false)]
    [InlineData("https://example.com/pull/1", false)]
    [InlineData("file:///C:/Windows/System32/calc.exe", false)]
    [InlineData(null, false)]
    public void OnlyGitHubPagesOpen(string? url, bool opens) => Assert.Equal(opens, SelfWorkForm.IsPrUrl(url));

    [Fact]
    public void NoticePayload_CarriesThePrUrl()
    {
        var payload = TrayNotificationPayload.TryParse(
            Encoding.UTF8.GetBytes("""{"type":"self-work","title":"Mana's own code","text":"My PR for #12 is ready","url":"https://github.com/Yuuzulight/Mana/pull/1020"}"""));
        Assert.Equal("self-work", payload!.Type);
        Assert.Equal("https://github.com/Yuuzulight/Mana/pull/1020", payload.Url);
    }
}
