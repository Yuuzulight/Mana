using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1120: the chat window's Artifacts panel. STA, never shown.
public class ArtifactsPanelTests
{
    private static DetectedArtifact Html(string title, string body) =>
        new("html", $"<html><head><title>{title}</title></head><body>\n<h1>{title}</h1>\n{body}\n</body></html>", "");

    [Fact]
    public void Order_PutsThisChatFirst_NewestFirst_OneRowPerThread()
    {
        var t = new DateTime(2026, 10, 1, 12, 0, 0);
        VersionedArtifact A(string thread, int version) => new("html", thread + version, thread, version);
        var entries = new[]
        {
            new ArtifactEntry(A("a", 1), "chat-1", t),
            new ArtifactEntry(A("b", 1), "chat-2", t.AddMinutes(1)),
            new ArtifactEntry(A("c", 1), "chat-1", t.AddMinutes(2)),
            new ArtifactEntry(A("a", 2), "chat-1", t.AddMinutes(3)),
            new ArtifactEntry(A("d", 1), "chat-2", t.AddMinutes(4)),
        };

        var ordered = ArtifactsPanel.Order(entries, "chat-1").Select(e => e.Artifact.Content);

        Assert.Equal(new[] { "a2", "c1", "d1", "b1" }, ordered);
    }

    [Fact]
    public void Title_IsThePagesTitle_ElseItsFirstLine()
    {
        Assert.Equal("Tom & Jerry", ArtifactsPanel.Title(new("html", "<title> Tom &amp; Jerry </title><p>x</p>", "t", 1)));
        Assert.Equal("def add(a, b):", ArtifactsPanel.Title(new("python", "\n  def add(a, b):\n    return a + b", "t", 1)));
    }

    [Fact]
    public void ListsTheChatsArtifacts_AndSelectsANewOne()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var session = "chat-1";
            using var store = new ArtifactViewerForm { CurrentSessionId = () => session };
            store.Add(Html("Plan", "<p>one</p>"));
            session = "chat-2";
            store.Add(new DetectedArtifact("mermaid", "flowchart TD\nA-->B", ""));

            using var panel = new ArtifactsPanel(store, () => session);
            Assert.Equal(new[] { "This chat: flowchart TD", "Other chats: Plan" }, panel.RowsForTests);
            Assert.Equal("mermaid -- version 1 of 1", panel.VersionText); // the first row is shown

            session = "chat-1";
            store.Add(Html("Plan", "<p>one</p>\n<p>two</p>")); // a second version of Plan
            panel.Select(store.Entries[^1]);
            Assert.Equal(new[] { "This chat: Plan", "Other chats: flowchart TD" }, panel.RowsForTests);
            Assert.Equal("html -- version 2 of 2", panel.VersionText);
        });
    }

    // #1142: saved chats' artifacts arrive as titles and versions; content is read on open.
    private static ArtifactEntry Saved(string session, string thread, int version, string title, DateTime at, Func<Task<string?>> load) =>
        new(new VersionedArtifact("python", "", $"{session}/{thread}", version), session, at) { Title = title, Load = load };

    [Fact]
    public void ListsSavedChatsArtifacts_AndReadsAThreadsContentWhenOpened()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var reads = new List<string>();
            Func<Task<string?>> Load(string content) => () =>
            {
                reads.Add(content);
                return Task.FromResult<string?>(content);
            };
            var yesterday = DateTime.Today.AddDays(-1).AddHours(9);
            using var store = new ArtifactViewerForm { CurrentSessionId = () => "chat-1" };
            store.Add(new DetectedArtifact("mermaid", "flowchart TD\nA-->B", "")); // this run's own
            using var panel = new ArtifactsPanel(store, () => "chat-1");

            store.AddHistory(new[]
            {
                Saved("chat-1", "python-0", 1, "def add(a, b):", yesterday, Load("def add(a, b):\n    return a + b")),
                Saved("chat-1", "python-0", 2, "def add(a, b):", yesterday.AddMinutes(1), Load("def add(a, b):\n    return b + a")),
            });
            store.AddHistory(new[] { Saved("chat-2", "python-0", 1, "import os", yesterday.AddMinutes(-5), Load("import os")) });

            Assert.Equal(new[] { "This chat: flowchart TD", "This chat: def add(a, b):", "Other chats: import os" }, panel.RowsForTests);
            Assert.Empty(reads); // nothing read until one is opened

            panel.Select(store.Entries.First(e => e.SessionId == "chat-1" && e.Artifact.VersionIndex == 2));
            Assert.Equal(new[] { "def add(a, b):\n    return a + b", "def add(a, b):\n    return b + a" }, reads); // its thread, once
            Assert.Equal("python -- version 2 of 2", panel.VersionText);
            Assert.Equal("def add(a, b):\n    return b + a", store.ThreadOf(store.Entries[1])[1].Artifact.Content);
        });
    }

    [Fact]
    public void ASavedArtifactThatCantBeRead_IsTriedAgainLater()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var fail = true;
            using var store = new ArtifactViewerForm();
            store.AddHistory(new[] { Saved("chat-1", "python-0", 1, "x = 1", DateTime.Now, () => fail ? throw new HttpRequestException("down") : Task.FromResult<string?>("x = 1")) });

            Assert.False(store.LoadThreadAsync(store.Entries[0]).Result);
            Assert.NotNull(store.Entries[0].Load);

            fail = false;
            Assert.True(store.LoadThreadAsync(store.Entries[0]).Result);
            Assert.Null(store.Entries[0].Load);
            Assert.Equal("x = 1", store.Entries[0].Artifact.Content);
        });
    }

    [Fact]
    public async Task BackendClient_ReadsAChatsSavedArtifacts_ThenOnesContent()
    {
        var urls = new List<string>();
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
        {
            urls.Add(request.RequestUri!.PathAndQuery);
            var json = request.RequestUri.AbsolutePath.EndsWith("/artifacts")
                ? """{"artifacts":[{"turn":3,"at":"2026-10-01T10:00:00.000Z","language":"html","title":"Plan","threadId":"html-0","versionIndex":1}]}"""
                : """{"language":"html","content":"<p>hi</p>"}""";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));

        var saved = Assert.Single(await client.GetSessionArtifactsAsync("chat 1", new DateTime(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc)));
        Assert.Equal(new ManaSavedArtifact(3, "2026-10-01T10:00:00.000Z", "html", "Plan", "html-0", 1), saved);
        Assert.Equal("<p>hi</p>", await client.GetSessionArtifactContentAsync("chat 1", 3));
        Assert.Equal(new[] { "/sessions/chat%201/artifacts?before=2026-10-01T12%3A00%3A00.0000000Z", "/sessions/chat%201/artifacts/3" }, urls);
    }
}
