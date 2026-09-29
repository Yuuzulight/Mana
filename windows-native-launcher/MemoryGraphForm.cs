using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #641: read-only view of what Mana's memory has learned -- the Hebbian
// association graph (memory-graph.js) drawn as nodes/edges, colored by
// ontology type (entity-ontology.js), beside every remembered fact's
// validity window (acp-memory-store.js), superseded ones included. Three
// distinct signals: edge thickness = association weight, node color =
// entity type, greyed row with an end date = superseded fact. GDI+ only,
// same as MermaidRenderer. Standalone and fresh-per-open like SnapshotsForm.
// Wheel zooms around the cursor, drag pans, clicking a node narrows the
// right pane to that entity's associations and the facts that mention it.
internal sealed class MemoryGraphForm : Form
{
    private static readonly Dictionary<string, Color> TypeColors = new()
    {
        ["person"] = ColorTranslator.FromHtml("#e07a8c"),
        ["place"] = ColorTranslator.FromHtml("#5fb3d9"),
        ["object"] = ColorTranslator.FromHtml("#e0b975"),
        ["organization"] = ColorTranslator.FromHtml("#9d8ce0"),
        ["event"] = ColorTranslator.FromHtml("#3fb96a"),
        ["preference"] = ColorTranslator.FromHtml("#d99a2b"),
        ["media"] = ColorTranslator.FromHtml("#c97fd6"),
    };

    private readonly ManaBackendClient backendClient;
    private readonly PictureBox canvas = new();
    private readonly ListView factsList = new();
    private readonly ListView linksList = new();
    private readonly Label selectionLabel = new();
    private readonly NumericUpDown minWeightInput = new();
    private readonly ComboBox recencyInput = new();
    private readonly Label statusLabel = new();
    private ManaMemoryGraph graph = new();
    private List<ManaMemoryGraphNode> shownNodes = new();
    private List<ManaMemoryGraphEdge> shownEdges = new();
    private PointF[] positions = Array.Empty<PointF>();
    private float zoom = 1f;
    private PointF pan;
    private Point? dragFrom;
    private bool dragged;
    private string? selectedKey;

    public MemoryGraphForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        Text = "Mana Memory Graph";
        Width = 1100;
        Height = 700;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        minWeightInput.Minimum = 1;
        minWeightInput.Maximum = 10000;
        minWeightInput.Width = 60;
        minWeightInput.ValueChanged += (_, _) => ApplyFilters();
        recencyInput.DropDownStyle = ComboBoxStyle.DropDownList;
        recencyInput.Items.AddRange(new object[] { "All time", "Last 30 days", "Last 7 days" });
        recencyInput.SelectedIndex = 0;
        recencyInput.SelectedIndexChanged += (_, _) => ApplyFilters();
        var refreshButton = new Button { Text = "Refresh", AutoSize = true };
        DarkTheme.ApplyButton(refreshButton);
        refreshButton.Click += async (_, _) => await RefreshAsync();
        var resetViewButton = new Button { Text = "Reset view", AutoSize = true };
        DarkTheme.ApplyButton(resetViewButton);
        resetViewButton.Click += (_, _) => ResetView();
        statusLabel.AutoSize = true;
        statusLabel.ForeColor = DarkTheme.Muted;
        statusLabel.Margin = new Padding(8, 6, 0, 0);

        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 34, Padding = new Padding(4) };
        toolbar.Controls.Add(new Label { Text = "Min weight", AutoSize = true, Margin = new Padding(0, 6, 4, 0) });
        toolbar.Controls.Add(minWeightInput);
        toolbar.Controls.Add(new Label { Text = "Reinforced", AutoSize = true, Margin = new Padding(12, 6, 4, 0) });
        toolbar.Controls.Add(recencyInput);
        toolbar.Controls.Add(refreshButton);
        toolbar.Controls.Add(resetViewButton);
        toolbar.Controls.Add(statusLabel);

        canvas.Dock = DockStyle.Fill;
        canvas.BackColor = DarkTheme.Background;
        canvas.Paint += (_, e) => DrawGraph(e.Graphics, canvas.ClientSize);
        canvas.Resize += (_, _) => canvas.Invalidate();
        canvas.MouseWheel += (_, e) =>
        {
            var next = Math.Clamp(zoom * (e.Delta > 0 ? 1.25f : 0.8f), 0.5f, 8f);
            pan = ZoomAt(zoom, pan, e.Location, next);
            zoom = next;
            canvas.Invalidate();
        };
        canvas.MouseDown += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
            {
                dragFrom = e.Location;
                dragged = false;
            }
        };
        canvas.MouseMove += (_, e) =>
        {
            if (dragFrom is not { } from)
            {
                return;
            }
            // A few pixels of jitter still counts as a click, not a pan.
            if (!dragged && Math.Abs(e.X - from.X) + Math.Abs(e.Y - from.Y) < 4)
            {
                return;
            }
            dragged = true;
            pan = new PointF(pan.X + e.X - from.X, pan.Y + e.Y - from.Y);
            dragFrom = e.Location;
            canvas.Invalidate();
        };
        canvas.MouseUp += (_, e) =>
        {
            if (dragFrom is null || e.Button != MouseButtons.Left)
            {
                return;
            }
            dragFrom = null;
            if (!dragged)
            {
                var hit = HitTest(positions, canvas.ClientSize, zoom, pan, e.Location);
                SelectEntity(hit < 0 ? null : shownNodes[hit].Key);
            }
        };

        factsList.Dock = DockStyle.Fill;
        factsList.View = View.Details;
        factsList.FullRowSelect = true;
        factsList.Columns.Add("Valid from", 110);
        factsList.Columns.Add("Until", 110);
        factsList.Columns.Add("Key", 110);
        factsList.Columns.Add("Fact", 260);
        DarkTheme.ApplyListView(factsList);

        linksList.Dock = DockStyle.Top;
        linksList.Height = 130;
        linksList.View = View.Details;
        linksList.FullRowSelect = true;
        linksList.Columns.Add("Linked to", 200);
        linksList.Columns.Add("Weight", 60);
        linksList.Columns.Add("Last reinforced", 130);
        linksList.Visible = false;
        DarkTheme.ApplyListView(linksList);
        selectionLabel.Dock = DockStyle.Top;
        selectionLabel.Height = 26;
        selectionLabel.Padding = new Padding(4, 6, 0, 0);
        selectionLabel.ForeColor = DarkTheme.Muted;

        var split = new SplitContainer { Dock = DockStyle.Fill, BackColor = DarkTheme.Border };
        split.Panel1.Controls.Add(canvas);
        // Fill first, then the Top ones: the last-added Top control sits highest.
        split.Panel2.Controls.Add(factsList);
        split.Panel2.Controls.Add(linksList);
        split.Panel2.Controls.Add(selectionLabel);

        Controls.Add(split);
        Controls.Add(toolbar);

        Load += async (_, _) =>
        {
            // Set once the form has its real size -- SplitContainer rejects
            // a distance wider than its not-yet-docked default width.
            split.SplitterDistance = ClientSize.Width * 3 / 5;
            await RefreshAsync();
        };
    }

    private async Task RefreshAsync()
    {
        statusLabel.Text = "Loading...";
        ManaMemoryGraph loaded;
        try
        {
            loaded = await backendClient.GetMemoryGraphAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                statusLabel.Text = $"Could not reach the backend: {ex.Message}";
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        graph = loaded;
        ApplyFilters();
    }

    private void ResetView()
    {
        zoom = 1f;
        pan = PointF.Empty;
        canvas.Invalidate();
    }

    // null = no selection: every fact, no links pane.
    private void SelectEntity(string? key)
    {
        var node = shownNodes.FirstOrDefault(n => n.Key == key);
        selectedKey = node?.Key;

        linksList.Items.Clear();
        linksList.Visible = node is not null;
        if (node is not null)
        {
            foreach (var edge in shownEdges.Where(e => e.A == node.Key || e.B == node.Key).OrderByDescending(e => e.Weight))
            {
                var other = shownNodes.First(n => n.Key == (edge.A == node.Key ? edge.B : edge.A));
                var item = new ListViewItem(other.Display) { ForeColor = DarkTheme.Text };
                item.SubItems.Add(edge.Weight.ToString("0.##", CultureInfo.InvariantCulture));
                item.SubItems.Add(ShortTime(edge.LastReinforcedAt));
                linksList.Items.Add(item);
            }
        }

        var facts = node is null ? graph.Facts : FactsMentioning(graph.Facts, node);
        selectionLabel.Text = node is null
            ? "Click an entity to see its links and facts."
            : $"{node.Display} ({node.Type ?? "untyped"}): {linksList.Items.Count} links, {facts.Count} fact versions mention it";
        factsList.BeginUpdate();
        factsList.Items.Clear();
        foreach (var fact in facts)
        {
            var superseded = fact.InvalidatedAt is not null;
            var item = new ListViewItem(ShortTime(fact.ValidFrom)) { ForeColor = superseded ? DarkTheme.Muted : DarkTheme.Text };
            item.SubItems.Add(superseded ? ShortTime(fact.InvalidatedAt) : "now");
            item.SubItems.Add(fact.Key);
            item.SubItems.Add(fact.Text);
            factsList.Items.Add(item);
        }
        factsList.EndUpdate();
        canvas.Invalidate();
    }

    // Facts aren't keyed by entity, so "its facts" = versions whose text or
    // key names it (case-insensitive; key_like_this read as words).
    // ponytail: substring match, so "Al" would also hit "Alice"; graph
    // entities are multi-word (acp-memory-store.js), which keeps that rare.
    internal static List<ManaMemoryFactWindow> FactsMentioning(IEnumerable<ManaMemoryFactWindow> facts, ManaMemoryGraphNode node) =>
        facts.Where(f =>
            (f.Text ?? "").Contains(node.Key, StringComparison.OrdinalIgnoreCase)
            || (f.Key ?? "").Replace('_', ' ').Replace('-', ' ').Contains(node.Key, StringComparison.OrdinalIgnoreCase)).ToList();

    private void ApplyFilters()
    {
        DateTime? since = recencyInput.SelectedIndex switch
        {
            1 => DateTime.UtcNow.AddDays(-30),
            2 => DateTime.UtcNow.AddDays(-7),
            _ => null,
        };
        (shownNodes, shownEdges) = Filter(graph, (double)minWeightInput.Value, since);
        var index = shownNodes.Select((node, i) => (node.Key, i)).ToDictionary(p => p.Key, p => p.i);
        positions = ComputeLayout(shownNodes.Count, shownEdges.Select(e => (index[e.A], index[e.B], e.Weight)).ToList());
        // A new layout moves every node, so the old zoom/pan points nowhere.
        zoom = 1f;
        pan = PointF.Empty;
        statusLabel.Text = graph.Nodes.Count == 0
            ? "No associations recorded yet."
            : $"{shownNodes.Count} entities, {shownEdges.Count} associations, {graph.Facts.Count} fact versions";
        // Keeps the selection if its entity survived the filter.
        SelectEntity(selectedKey);
    }

    // Edges at/above minWeight and (if since is set) reinforced since then;
    // nodes are whatever those edges still touch. An unparseable timestamp
    // keeps its edge rather than silently hiding it.
    internal static (List<ManaMemoryGraphNode> Nodes, List<ManaMemoryGraphEdge> Edges) Filter(ManaMemoryGraph graph, double minWeight, DateTime? since)
    {
        var edges = graph.Edges.Where(e =>
            e.Weight >= minWeight
            && (since is null
                || !DateTime.TryParse(e.LastReinforcedAt, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var at)
                || at >= since)).ToList();
        var touched = new HashSet<string>(edges.SelectMany(e => new[] { e.A, e.B }));
        var nodes = graph.Nodes.Where(n => touched.Contains(n.Key)).ToList();
        // The backend drops edges to entities it filtered out; guard anyway
        // so ComputeLayout's index lookup can't miss.
        var shown = new HashSet<string>(nodes.Select(n => n.Key));
        return (nodes, edges.Where(e => shown.Contains(e.A) && shown.Contains(e.B)).ToList());
    }

    // Fruchterman-Reingold in the unit square, deterministic (nodes start on
    // a circle) so the same data always draws the same picture. Heavier
    // edges pull harder. ponytail: O(n^2) per iteration, fine for the
    // backend's <= 300 nodes; a Barnes-Hut grid if that bound ever grows.
    internal static PointF[] ComputeLayout(int nodeCount, IReadOnlyList<(int A, int B, double Weight)> edges, int iterations = 300)
    {
        var x = new double[nodeCount];
        var y = new double[nodeCount];
        for (var i = 0; i < nodeCount; i++)
        {
            var angle = 2 * Math.PI * i / Math.Max(1, nodeCount);
            x[i] = 0.5 + 0.4 * Math.Cos(angle);
            y[i] = 0.5 + 0.4 * Math.Sin(angle);
        }
        var k = Math.Sqrt(1.0 / Math.Max(1, nodeCount));
        var dx = new double[nodeCount];
        var dy = new double[nodeCount];
        for (var iter = 0; iter < iterations; iter++)
        {
            Array.Clear(dx);
            Array.Clear(dy);
            for (var i = 0; i < nodeCount; i++)
            {
                for (var j = i + 1; j < nodeCount; j++)
                {
                    var ddx = x[i] - x[j];
                    var ddy = y[i] - y[j];
                    var dist = Math.Max(1e-4, Math.Sqrt(ddx * ddx + ddy * ddy));
                    var force = k * k / dist;
                    dx[i] += ddx / dist * force;
                    dy[i] += ddy / dist * force;
                    dx[j] -= ddx / dist * force;
                    dy[j] -= ddy / dist * force;
                }
            }
            foreach (var (a, b, weight) in edges)
            {
                var ddx = x[a] - x[b];
                var ddy = y[a] - y[b];
                var dist = Math.Max(1e-4, Math.Sqrt(ddx * ddx + ddy * ddy));
                var force = dist * dist / k * (1 + Math.Log(Math.Max(1, weight)));
                dx[a] -= ddx / dist * force;
                dy[a] -= ddy / dist * force;
                dx[b] += ddx / dist * force;
                dy[b] += ddy / dist * force;
            }
            var temperature = 0.1 * (1 - (double)iter / iterations);
            for (var i = 0; i < nodeCount; i++)
            {
                var length = Math.Sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
                if (length > 0)
                {
                    x[i] = Math.Clamp(x[i] + dx[i] / length * Math.Min(length, temperature), 0, 1);
                    y[i] = Math.Clamp(y[i] + dy[i] / length * Math.Min(length, temperature), 0, 1);
                }
            }
        }
        return Enumerable.Range(0, nodeCount).Select(i => new PointF((float)x[i], (float)y[i])).ToArray();
    }

    private const float LayoutMargin = 60f;
    private const float NodeRadius = 6f;

    // Unit-square layout position -> canvas pixel: fit inside the margin,
    // then scale by zoom and shift by pan (pixels, relative to the origin).
    internal static PointF ToScreen(PointF unit, Size size, float zoom, PointF pan)
    {
        var width = Math.Max(1, size.Width - LayoutMargin * 2);
        var height = Math.Max(1, size.Height - LayoutMargin * 2);
        return new((LayoutMargin + unit.X * width) * zoom + pan.X, (LayoutMargin + unit.Y * height) * zoom + pan.Y);
    }

    // The pan that keeps the point under the cursor still while zooming.
    internal static PointF ZoomAt(float zoom, PointF pan, Point cursor, float newZoom) =>
        new(cursor.X - (cursor.X - pan.X) * newZoom / zoom, cursor.Y - (cursor.Y - pan.Y) * newZoom / zoom);

    // Index of the node drawn under the click (nearest wins), or -1. The hit
    // circle is a little wider than the dot so small nodes are easy to hit.
    internal static int HitTest(IReadOnlyList<PointF> positions, Size size, float zoom, PointF pan, Point click)
    {
        var best = -1;
        var bestDistance = (NodeRadius + 4) * (NodeRadius + 4);
        for (var i = 0; i < positions.Count; i++)
        {
            var p = ToScreen(positions[i], size, zoom, pan);
            var distance = (p.X - click.X) * (p.X - click.X) + (p.Y - click.Y) * (p.Y - click.Y);
            if (distance <= bestDistance)
            {
                best = i;
                bestDistance = distance;
            }
        }
        return best;
    }

    private void DrawGraph(Graphics g, Size size)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        PointF At(int i) => ToScreen(positions[i], size, zoom, pan);

        var index = shownNodes.Select((node, i) => (node.Key, i)).ToDictionary(p => p.Key, p => p.i);
        foreach (var edge in shownEdges)
        {
            // Thickness and opacity both grow with the Hebbian weight; the
            // selected entity's edges are drawn bright instead of muted.
            var strength = Math.Min(1.0, Math.Log(Math.Max(1, edge.Weight), 2) / 5);
            var color = edge.A == selectedKey || edge.B == selectedKey ? DarkTheme.Text : DarkTheme.Muted;
            using var pen = new Pen(Color.FromArgb(70 + (int)(150 * strength), color), 1f + 4f * (float)strength);
            g.DrawLine(pen, At(index[edge.A]), At(index[edge.B]));
        }

        using var font = new Font("Segoe UI", 8F);
        using var textBrush = new SolidBrush(DarkTheme.Text);
        using var ringPen = new Pen(DarkTheme.Text, 2f);
        const float radius = NodeRadius;
        for (var i = 0; i < shownNodes.Count; i++)
        {
            var p = At(i);
            using var fill = new SolidBrush(ColorFor(shownNodes[i].Type));
            g.FillEllipse(fill, p.X - radius, p.Y - radius, radius * 2, radius * 2);
            if (shownNodes[i].Key == selectedKey)
            {
                g.DrawEllipse(ringPen, p.X - radius - 3, p.Y - radius - 3, (radius + 3) * 2, (radius + 3) * 2);
            }
            g.DrawString(shownNodes[i].Display, font, textBrush, p.X + radius + 2, p.Y - 7);
        }

        // Legend: only the types actually on screen, plus the edge key.
        var y = 8f;
        foreach (var type in shownNodes.Select(n => n.Type).Distinct().OrderBy(t => t ?? "~"))
        {
            using var fill = new SolidBrush(ColorFor(type));
            g.FillEllipse(fill, 8, y + 3, 9, 9);
            g.DrawString(type ?? "untyped", font, textBrush, 22, y);
            y += 16;
        }
        using var mutedBrush = new SolidBrush(DarkTheme.Muted);
        g.DrawString("thicker line = stronger association", font, mutedBrush, 8, y + 4);
        g.DrawString("wheel = zoom, drag = pan, click = details", font, mutedBrush, 8, y + 20);
    }

    private static Color ColorFor(string? type) =>
        type is not null && TypeColors.TryGetValue(type, out var color) ? color : DarkTheme.Muted;

    private static string ShortTime(string? iso) =>
        iso is null ? "" : iso.Length >= 16 ? iso[..16].Replace('T', ' ') : iso;
}
