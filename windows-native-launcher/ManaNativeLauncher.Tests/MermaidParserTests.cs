using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class MermaidParserTests
{
    [Fact]
    public void Parse_DefaultsToTopDownWhenNoHeaderIsPresent()
    {
        var graph = MermaidParser.Parse("A --> B");

        Assert.Equal(MermaidDirection.TopDown, graph.Direction);
    }

    [Theory]
    [InlineData("graph TD")]
    [InlineData("graph TB")]
    [InlineData("graph BT")]
    public void Parse_TopDownHeaderVariants(string header)
    {
        var graph = MermaidParser.Parse($"{header}\nA --> B");

        Assert.Equal(MermaidDirection.TopDown, graph.Direction);
    }

    [Theory]
    [InlineData("flowchart LR")]
    [InlineData("graph RL")]
    public void Parse_LeftRightHeaderVariants(string header)
    {
        var graph = MermaidParser.Parse($"{header}\nA --> B");

        Assert.Equal(MermaidDirection.LeftRight, graph.Direction);
    }

    [Fact]
    public void Parse_SimpleEdgeCreatesTwoBareNodesAndOneEdge()
    {
        var graph = MermaidParser.Parse("graph TD\nA --> B");

        Assert.Equal(2, graph.Nodes.Count);
        Assert.Contains(graph.Nodes, n => n.Id == "A" && n.Label == "A");
        Assert.Contains(graph.Nodes, n => n.Id == "B" && n.Label == "B");
        var edge = Assert.Single(graph.Edges);
        Assert.Equal("A", edge.FromId);
        Assert.Equal("B", edge.ToId);
        Assert.Null(edge.Label);
    }

    [Fact]
    public void Parse_RectangleNodeShapeAndLabel()
    {
        var graph = MermaidParser.Parse("graph TD\nA[Start] --> B");

        var node = graph.Nodes.Single(n => n.Id == "A");
        Assert.Equal("Start", node.Label);
        Assert.Equal(MermaidNodeShape.Rectangle, node.Shape);
    }

    [Fact]
    public void Parse_DiamondNodeShapeAndLabel()
    {
        var graph = MermaidParser.Parse("graph TD\nA --> B{Decision}");

        var node = graph.Nodes.Single(n => n.Id == "B");
        Assert.Equal("Decision", node.Label);
        Assert.Equal(MermaidNodeShape.Diamond, node.Shape);
    }

    [Fact]
    public void Parse_RoundedNodeShapeAndLabel()
    {
        var graph = MermaidParser.Parse("graph TD\nA(Rounded) --> B");

        var node = graph.Nodes.Single(n => n.Id == "A");
        Assert.Equal("Rounded", node.Label);
        Assert.Equal(MermaidNodeShape.Rounded, node.Shape);
    }

    [Fact]
    public void Parse_CircleNodeShapeAndLabel()
    {
        var graph = MermaidParser.Parse("graph TD\nA((Circle)) --> B");

        var node = graph.Nodes.Single(n => n.Id == "A");
        Assert.Equal("Circle", node.Label);
        Assert.Equal(MermaidNodeShape.Circle, node.Shape);
    }

    [Fact]
    public void Parse_EdgeLabelBetweenPipes()
    {
        var graph = MermaidParser.Parse("graph TD\nA -->|Yes| B");

        var edge = Assert.Single(graph.Edges);
        Assert.Equal("Yes", edge.Label);
    }

    [Fact]
    public void Parse_PlainLineEdgeHasNoArrowhead()
    {
        // --- (no arrowhead in real Mermaid) still parses as a
        // connection -- this renderer draws both --> and --- the same
        // way, a deliberate simplification.
        var graph = MermaidParser.Parse("graph TD\nA --- B");

        var edge = Assert.Single(graph.Edges);
        Assert.Equal("A", edge.FromId);
        Assert.Equal("B", edge.ToId);
    }

    [Fact]
    public void Parse_MultipleEdgesShareNodesDefinedOnAnyLine()
    {
        var graph = MermaidParser.Parse("graph TD\nA[Start] --> B{Decision}\nB -->|Yes| C[Do thing]\nB -->|No| D[Do other]\nC --> E[End]\nD --> E");

        Assert.Equal(5, graph.Nodes.Count);
        Assert.Equal(5, graph.Edges.Count);
        var end = graph.Nodes.Single(n => n.Id == "E");
        Assert.Equal("End", end.Label);
    }

    [Fact]
    public void Parse_LaterExplicitLabelOverridesAnEarlierBareReference()
    {
        var graph = MermaidParser.Parse("graph TD\nA --> B\nA[Start] --> C");

        var node = graph.Nodes.Single(n => n.Id == "A");
        Assert.Equal("Start", node.Label);
        Assert.Equal(MermaidNodeShape.Rectangle, node.Shape);
    }

    [Fact]
    public void Parse_EarlierExplicitLabelIsNotOverwrittenByALaterBareReference()
    {
        var graph = MermaidParser.Parse("graph TD\nA[Start] --> B\nA --> C");

        var node = graph.Nodes.Single(n => n.Id == "A");
        Assert.Equal("Start", node.Label);
    }

    [Fact]
    public void Parse_SkipsCommentLines()
    {
        var graph = MermaidParser.Parse("graph TD\n%% this is a comment\nA --> B");

        Assert.Equal(2, graph.Nodes.Count);
    }

    [Fact]
    public void Parse_SkipsUnrecognizedLinesInsteadOfThrowing()
    {
        var graph = MermaidParser.Parse("graph TD\nstyle A fill:#f9f\nclassDef default fill:#eee\nA --> B");

        Assert.Equal(2, graph.Nodes.Count);
        Assert.Single(graph.Edges);
    }

    [Fact]
    public void Parse_StandaloneNodeDeclarationWithNoEdge()
    {
        var graph = MermaidParser.Parse("graph TD\nA[Only Node]");

        var node = Assert.Single(graph.Nodes);
        Assert.Equal("Only Node", node.Label);
        Assert.Empty(graph.Edges);
    }

    [Fact]
    public void Parse_HyphenatedNodeIdsAreNotDropped()
    {
        var graph = MermaidParser.Parse("graph TD\nstep-1[First] --> step-2[Second]");

        Assert.Equal(2, graph.Nodes.Count);
        Assert.Contains(graph.Nodes, n => n.Id == "step-1" && n.Label == "First");
        Assert.Contains(graph.Nodes, n => n.Id == "step-2" && n.Label == "Second");
        Assert.Single(graph.Edges);
    }

    [Fact]
    public void Parse_ChainedEdgesOnOneLineProduceTwoEdges()
    {
        var graph = MermaidParser.Parse("graph TD\nA --> B --> C");

        Assert.Equal(3, graph.Nodes.Count);
        Assert.Equal(2, graph.Edges.Count);
        Assert.Contains(graph.Edges, e => e.FromId == "A" && e.ToId == "B");
        Assert.Contains(graph.Edges, e => e.FromId == "B" && e.ToId == "C");
    }

    [Fact]
    public void Parse_ChainedEdgesWithLabelsAssignEachLabelToTheRightEdge()
    {
        var graph = MermaidParser.Parse("graph TD\nA -->|Yes| B --> C");

        var ab = graph.Edges.Single(e => e.FromId == "A" && e.ToId == "B");
        var bc = graph.Edges.Single(e => e.FromId == "B" && e.ToId == "C");
        Assert.Equal("Yes", ab.Label);
        Assert.Null(bc.Label);
    }

    [Fact]
    public void Parse_ChainedEdgesWithInlineNodeDefinitions()
    {
        var graph = MermaidParser.Parse("graph TD\nA[Start] --> B{Check} --> C[End]");

        Assert.Equal(3, graph.Nodes.Count);
        Assert.Equal("Check", graph.Nodes.Single(n => n.Id == "B").Label);
        Assert.Equal(MermaidNodeShape.Diamond, graph.Nodes.Single(n => n.Id == "B").Shape);
    }

    [Fact]
    public void Parse_EmptySourceProducesAnEmptyGraph()
    {
        var graph = MermaidParser.Parse("");

        Assert.Empty(graph.Nodes);
        Assert.Empty(graph.Edges);
    }
}
