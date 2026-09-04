using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class MermaidLayoutTests
{
    [Fact]
    public void Compute_EmptyGraphProducesEmptyResult()
    {
        var result = MermaidLayout.Compute(new MermaidGraph(MermaidDirection.TopDown, System.Array.Empty<MermaidNode>(), System.Array.Empty<MermaidEdge>()));

        Assert.Empty(result.Nodes);
        Assert.Empty(result.Edges);
    }

    [Fact]
    public void Compute_SingleNodeIsPlacedAtANonNegativeOrigin()
    {
        var graph = new MermaidGraph(MermaidDirection.TopDown, new[] { new MermaidNode("A", "A", MermaidNodeShape.Rectangle) }, System.Array.Empty<MermaidEdge>());

        var result = MermaidLayout.Compute(graph);

        var node = Assert.Single(result.Nodes);
        Assert.True(node.X - node.Width / 2 >= -0.01f);
        Assert.True(node.Y - node.Height / 2 >= -0.01f);
    }

    [Fact]
    public void Compute_LinearChainIncreasesYPerRankInTopDown()
    {
        var graph = MermaidParser.Parse("graph TD\nA --> B\nB --> C");

        var result = MermaidLayout.Compute(graph);

        var byId = result.Nodes.ToDictionary(n => n.Id);
        Assert.True(byId["A"].Y < byId["B"].Y);
        Assert.True(byId["B"].Y < byId["C"].Y);
    }

    [Fact]
    public void Compute_LinearChainIncreasesXPerRankInLeftRight()
    {
        var graph = MermaidParser.Parse("graph LR\nA --> B\nB --> C");

        var result = MermaidLayout.Compute(graph);

        var byId = result.Nodes.ToDictionary(n => n.Id);
        Assert.True(byId["A"].X < byId["B"].X);
        Assert.True(byId["B"].X < byId["C"].X);
    }

    [Fact]
    public void Compute_SameRankNodesDoNotOverlapHorizontallyInTopDown()
    {
        // B and C both depend on A, so both land in rank 1 -- their boxes
        // must not overlap along X.
        var graph = MermaidParser.Parse("graph TD\nA --> B\nA --> C");

        var result = MermaidLayout.Compute(graph);
        var byId = result.Nodes.ToDictionary(n => n.Id);
        var b = byId["B"];
        var c = byId["C"];

        var bLeft = b.X - b.Width / 2;
        var bRight = b.X + b.Width / 2;
        var cLeft = c.X - c.Width / 2;
        var cRight = c.X + c.Width / 2;
        Assert.True(bRight <= cLeft || cRight <= bLeft);
    }

    [Fact]
    public void Compute_SameRankNodesAreAtTheSameYInTopDown()
    {
        var graph = MermaidParser.Parse("graph TD\nA --> B\nA --> C");

        var result = MermaidLayout.Compute(graph);
        var byId = result.Nodes.ToDictionary(n => n.Id);

        Assert.Equal(byId["B"].Y, byId["C"].Y, 3);
    }

    [Fact]
    public void Compute_EveryEdgeConnectsItsRealNodeEndpoints()
    {
        var graph = MermaidParser.Parse("graph TD\nA --> B\nB --> C");

        var result = MermaidLayout.Compute(graph);
        var byId = result.Nodes.ToDictionary(n => n.Id);

        foreach (var edge in result.Edges)
        {
            var from = byId[edge.FromId];
            var to = byId[edge.ToId];
            // The endpoint should sit on the node's own boundary, not
            // its center -- for TopDown that means Y offset from the
            // node's own center by roughly half its height.
            Assert.True(System.Math.Abs(edge.FromY - from.Y) <= from.Height / 2f + 0.01f);
            Assert.True(System.Math.Abs(edge.ToY - to.Y) <= to.Height / 2f + 0.01f);
        }
    }

    [Fact]
    public void Compute_ACycleTerminatesInsteadOfHangingAndProducesEveryNode()
    {
        // A -> B -> C -> A: no source (in-degree 0) node exists at all.
        var graph = MermaidParser.Parse("graph TD\nA --> B\nB --> C\nC --> A");

        var result = MermaidLayout.Compute(graph);

        Assert.Equal(3, result.Nodes.Count);
        Assert.Equal(3, result.Edges.Count);
    }

    [Fact]
    public void Compute_DiamondDagRanksTheJoinNodeByTheLongestIncomingPath()
    {
        // A -> B -> D and A -> C -> D: D must land one rank past the
        // LONGER of its two incoming paths (both are length 2 here, so
        // D should be rank 2, not rank 1 from a naive single-predecessor
        // read).
        var graph = MermaidParser.Parse("graph TD\nA --> B\nA --> C\nB --> D\nC --> D");

        var result = MermaidLayout.Compute(graph);
        var byId = result.Nodes.ToDictionary(n => n.Id);

        Assert.True(byId["A"].Y < byId["B"].Y);
        Assert.True(byId["A"].Y < byId["C"].Y);
        Assert.Equal(byId["B"].Y, byId["C"].Y, 3);
        Assert.True(byId["D"].Y > byId["B"].Y);
        Assert.True(byId["D"].Y > byId["C"].Y);
    }

    [Fact]
    public void Compute_IsolatedNodesWithNoEdgesAreNonOverlapping()
    {
        var graph = new MermaidGraph(
            MermaidDirection.TopDown,
            new[]
            {
                new MermaidNode("A", "A", MermaidNodeShape.Rectangle),
                new MermaidNode("B", "B", MermaidNodeShape.Rectangle),
            },
            System.Array.Empty<MermaidEdge>());

        var result = MermaidLayout.Compute(graph);
        var byId = result.Nodes.ToDictionary(n => n.Id);

        var aLeft = byId["A"].X - byId["A"].Width / 2;
        var aRight = byId["A"].X + byId["A"].Width / 2;
        var bLeft = byId["B"].X - byId["B"].Width / 2;
        var bRight = byId["B"].X + byId["B"].Width / 2;
        Assert.True(aRight <= bLeft || bRight <= aLeft);
    }

    [Fact]
    public void Compute_WiderLabelsProduceAWiderNodeBox()
    {
        var graph = MermaidParser.Parse("graph TD\nA[Hi] --> B[This is a much longer label]");

        var result = MermaidLayout.Compute(graph);
        var byId = result.Nodes.ToDictionary(n => n.Id);

        Assert.True(byId["B"].Width > byId["A"].Width);
    }
}
