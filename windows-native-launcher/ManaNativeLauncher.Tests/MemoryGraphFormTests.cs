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

    private static ManaMemoryGraphNode Node(string key) => new() { Key = key, Display = key };
}
