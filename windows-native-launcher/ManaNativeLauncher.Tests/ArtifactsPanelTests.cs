using System;
using System.Linq;
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
}
