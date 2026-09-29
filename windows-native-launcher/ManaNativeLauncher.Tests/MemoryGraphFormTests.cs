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

// #641: the memory-graph view's pure parts -- parsing, filtering, layout.
public class MemoryGraphFormTests
{
    [Fact]
    public async Task GetMemoryGraphAsync_ParsesNodesEdgesAndFactWindows()
    {
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"ok":true,"nodes":[{"key":"alice smith","display":"Alice Smith","type":"person"},{"key":"bob jones","display":"Bob Jones","type":null}],"edges":[{"a":"alice smith","b":"bob jones","weight":3,"lastReinforcedAt":"2026-09-01T00:00:00.000Z"}],"facts":[{"key":"gpu","text":"RTX 5080","validFrom":"2026-09-02T00:00:00.000Z","invalidatedAt":null},{"key":"gpu","text":"RTX 3070 Ti","validFrom":"2026-01-01T00:00:00.000Z","invalidatedAt":"2026-09-02T00:00:00.000Z"}]}""",
                    Encoding.UTF8,
                    "application/json"),
            };
        });

        var graph = await new ManaBackendClient(handler).GetMemoryGraphAsync();

        Assert.Equal("/admin/memory/graph", path);
        Assert.Equal(new[] { "Alice Smith", "Bob Jones" }, graph.Nodes.Select(n => n.Display));
        Assert.Equal("person", graph.Nodes[0].Type);
        Assert.Null(graph.Nodes[1].Type);
        var edge = Assert.Single(graph.Edges);
        Assert.Equal(("alice smith", "bob jones", 3.0), (edge.A, edge.B, edge.Weight));
        Assert.Null(graph.Facts[0].InvalidatedAt);
        Assert.Equal("2026-09-02T00:00:00.000Z", graph.Facts[1].InvalidatedAt);
    }

    [Fact]
    public void Filter_DropsWeakAndStaleEdgesAndTheNodesOnlyTheyTouched()
    {
        var graph = new ManaMemoryGraph
        {
            Nodes = new() { Node("a"), Node("b"), Node("c"), Node("d") },
            Edges = new()
            {
                new ManaMemoryGraphEdge { A = "a", B = "b", Weight = 5, LastReinforcedAt = "2026-09-20T00:00:00.000Z" },
                new ManaMemoryGraphEdge { A = "a", B = "c", Weight = 1, LastReinforcedAt = "2026-09-20T00:00:00.000Z" },
                new ManaMemoryGraphEdge { A = "b", B = "d", Weight = 5, LastReinforcedAt = "2026-01-01T00:00:00.000Z" },
            },
        };

        var (nodes, edges) = MemoryGraphForm.Filter(graph, 2, new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc));

        Assert.Equal(new[] { "a", "b" }, nodes.Select(n => n.Key));
        Assert.Equal(("a", "b"), (Assert.Single(edges).A, edges[0].B));
    }

    [Fact]
    public void ComputeLayout_PullsLinkedNodesTogetherAndStaysInTheUnitSquare()
    {
        var positions = MemoryGraphForm.ComputeLayout(3, new List<(int, int, double)> { (0, 1, 10) });

        Assert.All(positions, p => Assert.True(p.X >= 0 && p.X <= 1 && p.Y >= 0 && p.Y <= 1));
        static double Distance(System.Drawing.PointF p, System.Drawing.PointF q) => Math.Sqrt(Math.Pow(p.X - q.X, 2) + Math.Pow(p.Y - q.Y, 2));
        Assert.True(Distance(positions[0], positions[1]) < Distance(positions[0], positions[2]));
        Assert.Empty(MemoryGraphForm.ComputeLayout(0, new List<(int, int, double)>()));
    }

    [Fact]
    public void HitTest_FindsTheNodeUnderTheClickAfterZoomAndPan()
    {
        var positions = new[] { new System.Drawing.PointF(0, 0), new System.Drawing.PointF(1, 1) };
        var size = new System.Drawing.Size(220, 220);
        var pan = new System.Drawing.PointF(-100, -50);

        // Node 1 sits at (160,160) unzoomed; zoom 2 + pan puts it at (220,270).
        Assert.Equal(1, MemoryGraphForm.HitTest(positions, size, 2f, pan, new System.Drawing.Point(222, 268)));
        Assert.Equal(-1, MemoryGraphForm.HitTest(positions, size, 2f, pan, new System.Drawing.Point(160, 160)));
        Assert.Equal(1, MemoryGraphForm.HitTest(positions, size, 1f, System.Drawing.PointF.Empty, new System.Drawing.Point(160, 160)));
    }

    [Fact]
    public void ZoomAt_KeepsThePointUnderTheCursorStill()
    {
        var size = new System.Drawing.Size(220, 220);
        var unit = new System.Drawing.PointF(0.5f, 0.5f);
        var cursor = new System.Drawing.Point(110, 110);
        Assert.Equal(new System.Drawing.PointF(110, 110), MemoryGraphForm.ToScreen(unit, size, 1f, System.Drawing.PointF.Empty));

        var pan = MemoryGraphForm.ZoomAt(1f, System.Drawing.PointF.Empty, cursor, 2.5f);

        Assert.Equal(new System.Drawing.PointF(110, 110), MemoryGraphForm.ToScreen(unit, size, 2.5f, pan));
    }

    [Fact]
    public void FactsMentioning_MatchesTheEntityInTextOrKeyIgnoringCase()
    {
        var facts = new List<ManaMemoryFactWindow>
        {
            new() { Key = "friend", Text = "Alice Smith likes tea" },
            new() { Key = "alice_smith_birthday", Text = "May 3" },
            new() { Key = "gpu", Text = "RTX 5080" },
            new() { Key = "note", Text = null! },
        };

        var matched = MemoryGraphForm.FactsMentioning(facts, new ManaMemoryGraphNode { Key = "alice smith", Display = "Alice Smith" });

        Assert.Equal(new[] { "friend", "alice_smith_birthday" }, matched.Select(f => f.Key));
    }

    private static ManaMemoryGraphNode Node(string key) => new() { Key = key, Display = key };
}
