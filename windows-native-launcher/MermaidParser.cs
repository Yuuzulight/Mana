using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

// #528: a hand-built parser for the Mermaid flowchart subset this
// project actually renders -- not the full Mermaid grammar. Supports:
// graph/flowchart TD/TB/BT/LR/RL headers; node shapes [rect], (rounded),
// {diamond}, ((circle)), and bare (defaults to rectangle, label = id);
// hyphenated node ids; edges via --> or --- with an optional |label|;
// chained edges on one line (A --> B --> C); inline node definitions on
// either side of an edge. Deliberately does NOT support subgraphs,
// styling (style/classDef/click), or arrow-style distinctions (--- and
// --> both render with an arrowhead -- the vast majority of real
// AI-generated diagrams use -->, and drawing one consistently avoids
// tracking a second edge-style dimension for negligible visual gain).
// A label whose own text happens to contain a literal "-->"/"---" will
// still mis-split (the arrow scan has no bracket-awareness) -- rare
// enough in practice not to be worth the added complexity. Unrecognized
// lines are silently skipped, never thrown on -- this is a best-effort
// renderer for a diagram type that had no native equivalent at all
// before, not a spec-compliance parser.
internal static class MermaidParser
{
    private static readonly Regex HeaderPattern = new(@"^\s*(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // #528 review: scans for every -->/--- on the line (not just the
    // first) so a chained edge like "A --> B --> C" produces two edges
    // instead of one arrow's worth of match swallowing the rest of the
    // line as an unparseable node token. An optional |label| immediately
    // after an arrow belongs to the edge ending at the token that
    // follows it. Still ambiguous if a label's own text happens to
    // contain literal "-->"/"---" (rare enough in practice not to be
    // worth bracket-aware parsing for).
    private static readonly Regex ArrowToken = new(@"-->|---", RegexOptions.Compiled);
    private static readonly Regex EdgeLabelAfterArrow = new(@"^\s*\|([^|]*)\|", RegexOptions.Compiled);

    // #528 review: [\w-] (not just \w) -- Mermaid ids commonly include
    // hyphens (e.g. "step-1"), which \w alone excludes, silently
    // dropping the whole edge/node.
    private static readonly Regex CircleNode = new(@"^([\w-]+)\(\((.*)\)\)$", RegexOptions.Compiled);
    private static readonly Regex DiamondNode = new(@"^([\w-]+)\{(.*)\}$", RegexOptions.Compiled);
    private static readonly Regex RoundedNode = new(@"^([\w-]+)\((.*)\)$", RegexOptions.Compiled);
    private static readonly Regex RectangleNode = new(@"^([\w-]+)\[(.*)\]$", RegexOptions.Compiled);
    private static readonly Regex BareNode = new(@"^([\w-]+)$", RegexOptions.Compiled);

    public static MermaidGraph Parse(string mermaidSource)
    {
        var direction = MermaidDirection.TopDown;
        var nodes = new Dictionary<string, MermaidNode>();
        var edges = new List<MermaidEdge>();

        void AddOrUpdateNode(string id, string label, MermaidNodeShape shape, bool explicitLabel)
        {
            // A node first seen bare (e.g. as an edge endpoint with no
            // shape/label of its own) gets its id as a placeholder label;
            // a later line that DOES give it a real label/shape updates
            // it in place -- matches Mermaid's own "define once, reference
            // by id afterward" convention.
            if (!nodes.TryGetValue(id, out var existing) || explicitLabel)
            {
                nodes[id] = new MermaidNode(id, label, shape);
            }
            else
            {
                _ = existing;
            }
        }

        foreach (var rawLine in (mermaidSource ?? "").Replace("\r\n", "\n").Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("%%"))
            {
                continue;
            }

            var headerMatch = HeaderPattern.Match(line);
            if (headerMatch.Success)
            {
                var dir = headerMatch.Groups[1].Value.ToUpperInvariant();
                direction = dir is "LR" or "RL" ? MermaidDirection.LeftRight : MermaidDirection.TopDown;
                continue;
            }

            if (TryParseEdgeChain(line, out var chain))
            {
                var parsedTokens = new List<(string Id, string Label, MermaidNodeShape Shape, bool ExplicitLabel)?>();
                foreach (var (token, _) in chain)
                {
                    parsedTokens.Add(ParseNodeToken(token));
                }

                if (parsedTokens.Any(t => t is null))
                {
                    // Any unparseable segment (e.g. a token that isn't a
                    // valid node reference at all) invalidates the whole
                    // chain -- matches the single-edge case's own
                    // all-or-nothing fallback, rather than guessing which
                    // partial subset of a malformed chain to keep.
                    continue;
                }

                for (var i = 0; i < parsedTokens.Count; i++)
                {
                    var token = parsedTokens[i]!.Value;
                    AddOrUpdateNode(token.Id, token.Label, token.Shape, token.ExplicitLabel);
                }

                for (var i = 1; i < parsedTokens.Count; i++)
                {
                    var fromId = parsedTokens[i - 1]!.Value.Id;
                    var toId = parsedTokens[i]!.Value.Id;
                    var edgeLabel = chain[i].Label;
                    edges.Add(new MermaidEdge(fromId, toId, string.IsNullOrEmpty(edgeLabel) ? null : edgeLabel));
                }
                continue;
            }

            // Not an edge -- maybe a standalone node declaration
            // (subgraph/style/classDef/click and anything else
            // unrecognized just falls through and is silently skipped).
            var soleNode = ParseNodeToken(line);
            if (soleNode is not null)
            {
                AddOrUpdateNode(soleNode.Value.Id, soleNode.Value.Label, soleNode.Value.Shape, soleNode.Value.ExplicitLabel);
            }
        }

        return new MermaidGraph(direction, new List<MermaidNode>(nodes.Values), edges);
    }

    // Splits a line on every arrow occurrence into (nodeToken, incomingEdgeLabel)
    // pairs -- incomingEdgeLabel is the |label| immediately following the
    // arrow that leads INTO this token (null for the first token, which
    // has no incoming arrow on this line). Returns false (chain left
    // empty) if the line has no arrow at all, so the caller can fall
    // back to treating it as a standalone node declaration.
    private static bool TryParseEdgeChain(string line, out List<(string Token, string? Label)> chain)
    {
        chain = new List<(string, string?)>();
        var matches = ArrowToken.Matches(line);
        if (matches.Count == 0)
        {
            return false;
        }

        var lastEnd = 0;
        string? pendingLabel = null;
        foreach (Match arrow in matches)
        {
            chain.Add((line[lastEnd..arrow.Index].Trim(), pendingLabel));
            pendingLabel = null;

            var afterArrow = arrow.Index + arrow.Length;
            var labelMatch = EdgeLabelAfterArrow.Match(line[afterArrow..]);
            if (labelMatch.Success)
            {
                pendingLabel = labelMatch.Groups[1].Value.Trim();
                afterArrow += labelMatch.Length;
            }
            lastEnd = afterArrow;
        }
        chain.Add((line[lastEnd..].Trim(), pendingLabel));

        return true;
    }

    private static (string Id, string Label, MermaidNodeShape Shape, bool ExplicitLabel)? ParseNodeToken(string token)
    {
        token = token.Trim();

        var m = CircleNode.Match(token);
        if (m.Success)
        {
            return (m.Groups[1].Value, m.Groups[2].Value, MermaidNodeShape.Circle, true);
        }
        m = DiamondNode.Match(token);
        if (m.Success)
        {
            return (m.Groups[1].Value, m.Groups[2].Value, MermaidNodeShape.Diamond, true);
        }
        m = RoundedNode.Match(token);
        if (m.Success)
        {
            return (m.Groups[1].Value, m.Groups[2].Value, MermaidNodeShape.Rounded, true);
        }
        m = RectangleNode.Match(token);
        if (m.Success)
        {
            return (m.Groups[1].Value, m.Groups[2].Value, MermaidNodeShape.Rectangle, true);
        }
        m = BareNode.Match(token);
        if (m.Success)
        {
            return (m.Groups[1].Value, m.Groups[1].Value, MermaidNodeShape.Rectangle, false);
        }
        return null;
    }
}
