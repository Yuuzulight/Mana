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
    private readonly NumericUpDown minWeightInput = new();
    private readonly ComboBox recencyInput = new();
    private readonly Label statusLabel = new();
    private ManaMemoryGraph graph = new();
    private List<ManaMemoryGraphNode> shownNodes = new();
    private List<ManaMemoryGraphEdge> shownEdges = new();
    private PointF[] positions = Array.Empty<PointF>();

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
        statusLabel.AutoSize = true;
        statusLabel.ForeColor = DarkTheme.Muted;
        statusLabel.Margin = new Padding(8, 6, 0, 0);

        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 34, Padding = new Padding(4) };
        toolbar.Controls.Add(new Label { Text = "Min weight", AutoSize = true, Margin = new Padding(0, 6, 4, 0) });
        toolbar.Controls.Add(minWeightInput);
        toolbar.Controls.Add(new Label { Text = "Reinforced", AutoSize = true, Margin = new Padding(12, 6, 4, 0) });
        toolbar.Controls.Add(recencyInput);
        toolbar.Controls.Add(refreshButton);
        toolbar.Controls.Add(statusLabel);

        canvas.Dock = DockStyle.Fill;
        canvas.BackColor = DarkTheme.Background;
        canvas.Paint += (_, e) => DrawGraph(e.Graphics, canvas.ClientSize);
        canvas.Resize += (_, _) => canvas.Invalidate();

        factsList.Dock = DockStyle.Fill;
        factsList.View = View.Details;
        factsList.FullRowSelect = true;
        factsList.Columns.Add("Valid from", 110);
        factsList.Columns.Add("Until", 110);
        factsList.Columns.Add("Key", 110);
        factsList.Columns.Add("Fact", 260);
        DarkTheme.ApplyListView(factsList);

        var split = new SplitContainer { Dock = DockStyle.Fill, BackColor = DarkTheme.Border };
        split.Panel1.Controls.Add(canvas);
        split.Panel2.Controls.Add(factsList);

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
        factsList.Items.Clear();
        foreach (var fact in graph.Facts)
        {
            var superseded = fact.InvalidatedAt is not null;
            var item = new ListViewItem(ShortTime(fact.ValidFrom)) { ForeColor = superseded ? DarkTheme.Muted : DarkTheme.Text };
            item.SubItems.Add(superseded ? ShortTime(fact.InvalidatedAt) : "now");
            item.SubItems.Add(fact.Key);
            item.SubItems.Add(fact.Text);
            factsList.Items.Add(item);
        }
        ApplyFilters();
    }

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
        statusLabel.Text = graph.Nodes.Count == 0
            ? "No associations recorded yet."
            : $"{shownNodes.Count} entities, {shownEdges.Count} associations, {graph.Facts.Count} fact versions";
        canvas.Invalidate();
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

    private void DrawGraph(Graphics g, Size size)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        const float margin = 60f;
        var width = Math.Max(1, size.Width - margin * 2);
        var height = Math.Max(1, size.Height - margin * 2);
        PointF At(int i) => new(margin + positions[i].X * width, margin + positions[i].Y * height);

        var index = shownNodes.Select((node, i) => (node.Key, i)).ToDictionary(p => p.Key, p => p.i);
        foreach (var edge in shownEdges)
        {
            // Thickness and opacity both grow with the Hebbian weight.
            var strength = Math.Min(1.0, Math.Log(Math.Max(1, edge.Weight), 2) / 5);
            using var pen = new Pen(Color.FromArgb(70 + (int)(150 * strength), DarkTheme.Muted), 1f + 4f * (float)strength);
            g.DrawLine(pen, At(index[edge.A]), At(index[edge.B]));
        }

        using var font = new Font("Segoe UI", 8F);
        using var textBrush = new SolidBrush(DarkTheme.Text);
        const float radius = 6f;
        for (var i = 0; i < shownNodes.Count; i++)
        {
            var p = At(i);
            using var fill = new SolidBrush(ColorFor(shownNodes[i].Type));
            g.FillEllipse(fill, p.X - radius, p.Y - radius, radius * 2, radius * 2);
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
    }

    private static Color ColorFor(string? type) =>
        type is not null && TypeColors.TryGetValue(type, out var color) ? color : DarkTheme.Muted;

    private static string ShortTime(string? iso) =>
        iso is null ? "" : iso.Length >= 16 ? iso[..16].Replace('T', ' ') : iso;
}
