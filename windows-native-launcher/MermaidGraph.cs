using System.Collections.Generic;

namespace Mana.NativeLauncher;

internal enum MermaidNodeShape
{
    Rectangle,
    Rounded,
    Diamond,
    Circle,
}

internal enum MermaidDirection
{
    TopDown,
    LeftRight,
}

internal sealed record MermaidNode(string Id, string Label, MermaidNodeShape Shape);

internal sealed record MermaidEdge(string FromId, string ToId, string? Label);

internal sealed record MermaidGraph(MermaidDirection Direction, IReadOnlyList<MermaidNode> Nodes, IReadOnlyList<MermaidEdge> Edges);
