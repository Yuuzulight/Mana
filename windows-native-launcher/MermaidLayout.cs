using System.Collections.Generic;
using System.Linq;

namespace Mana.NativeLauncher;

internal sealed record PositionedNode(string Id, string Label, MermaidNodeShape Shape, float X, float Y, float Width, float Height);

// FromX/FromY/ToX/ToY are the endpoints on each node's own boundary
// (bottom-center -> top-center for TopDown, right-center -> left-center
// for LeftRight) -- straight lines, no orthogonal routing or curves.
internal sealed record PositionedEdge(string FromId, string ToId, string? Label, float FromX, float FromY, float ToX, float ToY);

internal sealed record MermaidLayoutResult(IReadOnlyList<PositionedNode> Nodes, IReadOnlyList<PositionedEdge> Edges, float TotalWidth, float TotalHeight);

// #528: a Sugiyama-style layered-graph layout, scoped to what a small
// AI-generated flowchart actually needs -- not a general-purpose graph
// layout library. Three passes: rank nodes by longest path from a
// source (bounded iteration so a cycle degrades gracefully instead of
// looping forever), order nodes within each rank by a single-pass
// barycenter heuristic (not the classic iterative median-minimization --
// one pass is enough for the small node counts this renders), then
// assign pixel coordinates. Straight-line edges only.
internal static class MermaidLayout
{
    private const float NodeHeight = 50f;
    private const float RankSpacing = 90f;
    private const float NodeSpacing = 40f;
    private const float CharWidth = 8f;
    private const float MinNodeWidth = 70f;
    private const float HorizontalPadding = 24f;

    public static MermaidLayoutResult Compute(MermaidGraph graph)
    {
        if (graph.Nodes.Count == 0)
        {
            return new MermaidLayoutResult(System.Array.Empty<PositionedNode>(), System.Array.Empty<PositionedEdge>(), 0, 0);
        }

        var ranks = AssignRanks(graph);
        var ranked = OrderWithinRanks(graph, ranks);
        return AssignCoordinates(graph, ranked);
    }

    // Longest-path-from-source ranking via bounded relaxation -- correct
    // for a DAG (converges to the true longest path within
    // graph.Nodes.Count iterations, since no acyclic path is longer than
    // that), and simply stops growing on a cycle instead of looping
    // forever, rather than requiring true cycle detection.
    private static Dictionary<string, int> AssignRanks(MermaidGraph graph)
    {
        var ranks = graph.Nodes.ToDictionary(n => n.Id, _ => 0);
        for (var iteration = 0; iteration < graph.Nodes.Count; iteration++)
        {
            var changed = false;
            foreach (var edge in graph.Edges)
            {
                if (!ranks.ContainsKey(edge.FromId) || !ranks.ContainsKey(edge.ToId))
                {
                    continue;
                }
                if (ranks[edge.ToId] < ranks[edge.FromId] + 1)
                {
                    ranks[edge.ToId] = ranks[edge.FromId] + 1;
                    changed = true;
                }
            }
            if (!changed)
            {
                break;
            }
        }
        return ranks;
    }

    // Returns each rank (in increasing order) as an ordered list of node
    // ids. Rank 0 keeps first-encountered order (stable, deterministic --
    // there's no predecessor rank to derive an order from). Every later
    // rank is sorted by the average within-rank index of its
    // predecessors in the immediately preceding rank; a node with no
    // ranked predecessor (shouldn't happen given how ranks are derived,
    // but guarded) sorts after every node that has one.
    private static List<List<string>> OrderWithinRanks(MermaidGraph graph, Dictionary<string, int> ranks)
    {
        var maxRank = ranks.Values.Count == 0 ? 0 : ranks.Values.Max();
        var byRank = new List<List<string>>();
        for (var r = 0; r <= maxRank; r++)
        {
            byRank.Add(new List<string>());
        }
        foreach (var node in graph.Nodes)
        {
            byRank[ranks[node.Id]].Add(node.Id);
        }

        var predecessorsByNode = graph.Edges
            .GroupBy(e => e.ToId)
            .ToDictionary(g => g.Key, g => g.Select(e => e.FromId).ToList());

        for (var r = 1; r <= maxRank; r++)
        {
            var previousIndex = byRank[r - 1]
                .Select((id, index) => (id, index))
                .ToDictionary(t => t.id, t => t.index);

            float Barycenter(string nodeId)
            {
                if (!predecessorsByNode.TryGetValue(nodeId, out var preds))
                {
                    return float.MaxValue;
                }
                var positions = preds.Where(previousIndex.ContainsKey).Select(p => (float)previousIndex[p]).ToList();
                return positions.Count == 0 ? float.MaxValue : positions.Average();
            }

            byRank[r] = byRank[r].OrderBy(Barycenter).ToList();
        }

        return byRank;
    }

    private static MermaidLayoutResult AssignCoordinates(MermaidGraph graph, List<List<string>> ranked)
    {
        var nodesById = graph.Nodes.ToDictionary(n => n.Id);
        var positions = new Dictionary<string, (float X, float Y, float Width, float Height)>();
        var isLeftRight = graph.Direction == MermaidDirection.LeftRight;

        var alongCursor = 0f;
        for (var r = 0; r < ranked.Count; r++)
        {
            var rankNodes = ranked[r];
            // Widths vary by label length -- centering the whole rank
            // needs the actual total width, not an assumed uniform one.
            var widths = rankNodes.Select(id => System.Math.Max(MinNodeWidth, nodesById[id].Label.Length * CharWidth + HorizontalPadding)).ToList();
            var rankTotalAcross = widths.Sum() + NodeSpacing * System.Math.Max(0, rankNodes.Count - 1);
            var acrossCursor = -rankTotalAcross / 2f;

            // How far the rank-progression axis must advance to clear
            // every node in THIS rank before the next one starts. Fixed
            // (NodeHeight) for TopDown, since every node's Y-extent is
            // the same; the widest node's own text-fit width for
            // LeftRight, since there a rank is a column of
            // variable-width boxes -- using a fixed step there would let
            // a long label overlap the next column.
            var rankAlongExtent = isLeftRight ? (widths.Count > 0 ? widths.Max() : MinNodeWidth) : NodeHeight;

            for (var i = 0; i < rankNodes.Count; i++)
            {
                var width = widths[i];
                var acrossCenter = acrossCursor + width / 2f;
                acrossCursor += width + NodeSpacing;

                var along = alongCursor + rankAlongExtent / 2f;
                var (x, y) = isLeftRight ? (along, acrossCenter) : (acrossCenter, along);
                positions[rankNodes[i]] = (x, y, width, NodeHeight);
            }

            alongCursor += rankAlongExtent + RankSpacing;
        }

        var positionedNodes = graph.Nodes
            .Select(n =>
            {
                var (x, y, w, h) = positions[n.Id];
                return new PositionedNode(n.Id, n.Label, n.Shape, x, y, w, h);
            })
            .ToList();
        var nodeLookup = positionedNodes.ToDictionary(n => n.Id);

        var positionedEdges = new List<PositionedEdge>();
        foreach (var edge in graph.Edges)
        {
            if (!nodeLookup.TryGetValue(edge.FromId, out var from) || !nodeLookup.TryGetValue(edge.ToId, out var to))
            {
                continue;
            }
            var (fromX, fromY, toX, toY) = isLeftRight
                ? (from.X + from.Width / 2f, from.Y, to.X - to.Width / 2f, to.Y)
                : (from.X, from.Y + from.Height / 2f, to.X, to.Y - to.Height / 2f);
            positionedEdges.Add(new PositionedEdge(edge.FromId, edge.ToId, edge.Label, fromX, fromY, toX, toY));
        }

        var minX = positionedNodes.Min(n => n.X - n.Width / 2f);
        var maxX = positionedNodes.Max(n => n.X + n.Width / 2f);
        var minY = positionedNodes.Min(n => n.Y - n.Height / 2f);
        var maxY = positionedNodes.Max(n => n.Y + n.Height / 2f);

        // Re-anchor to a non-negative origin -- the centering math above
        // produces coordinates straddling 0, which is the natural frame
        // for layout math but not for drawing onto a canvas.
        var offsetX = -minX;
        var offsetY = -minY;
        var shiftedNodes = positionedNodes.Select(n => n with { X = n.X + offsetX, Y = n.Y + offsetY }).ToList();
        var shiftedEdges = positionedEdges
            .Select(e => e with { FromX = e.FromX + offsetX, FromY = e.FromY + offsetY, ToX = e.ToX + offsetX, ToY = e.ToY + offsetY })
            .ToList();

        return new MermaidLayoutResult(shiftedNodes, shiftedEdges, maxX - minX, maxY - minY);
    }
}
