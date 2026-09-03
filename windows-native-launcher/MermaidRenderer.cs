using System;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace Mana.NativeLauncher;

// #528: draws a MermaidLayoutResult onto a Graphics surface -- the GDI+-
// coupled half of the renderer, kept separate from MermaidParser/
// MermaidLayout (pure, tested) since a Graphics surface needs a real
// device context and isn't itself unit-testable in this codebase (same
// split as ChatMarkdown/DoctorPanelForm's own untested rendering code).
internal static class MermaidRenderer
{
    private const float Margin = 20f;
    private const float ArrowSize = 8f;

    public static Size Measure(MermaidLayoutResult layout) =>
        new((int)(layout.TotalWidth + Margin * 2), (int)(layout.TotalHeight + Margin * 2));

    public static void Draw(Graphics g, MermaidLayoutResult layout)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        g.TranslateTransform(Margin, Margin);

        using var edgePen = new Pen(Color.DimGray, 1.5f);
        using var edgeLabelFont = new Font("Segoe UI", 8F);
        using var edgeLabelBrush = new SolidBrush(Color.DimGray);
        using var arrowheadBrush = new SolidBrush(edgePen.Color);
        foreach (var edge in layout.Edges)
        {
            DrawEdge(g, edge, edgePen, arrowheadBrush, edgeLabelFont, edgeLabelBrush);
        }

        using var nodeFont = new Font("Segoe UI", 9F);
        using var nodeBorderPen = new Pen(Color.SteelBlue, 1.5f);
        using var nodeFillBrush = new SolidBrush(Color.FromArgb(235, 244, 255));
        using var nodeTextBrush = new SolidBrush(Color.Black);
        using var nodeTextFormat = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        foreach (var node in layout.Nodes)
        {
            DrawNode(g, node, nodeFont, nodeBorderPen, nodeFillBrush, nodeTextBrush, nodeTextFormat);
        }
    }

    private static void DrawEdge(Graphics g, PositionedEdge edge, Pen pen, Brush arrowheadBrush, Font labelFont, Brush labelBrush)
    {
        var from = new PointF(edge.FromX, edge.FromY);
        var to = new PointF(edge.ToX, edge.ToY);
        g.DrawLine(pen, from, to);
        DrawArrowhead(g, arrowheadBrush, from, to);

        if (!string.IsNullOrEmpty(edge.Label))
        {
            var midpoint = new PointF((from.X + to.X) / 2f, (from.Y + to.Y) / 2f);
            var size = g.MeasureString(edge.Label, labelFont);
            g.FillRectangle(Brushes.White, midpoint.X - size.Width / 2f, midpoint.Y - size.Height / 2f, size.Width, size.Height);
            g.DrawString(edge.Label, labelFont, labelBrush, midpoint.X - size.Width / 2f, midpoint.Y - size.Height / 2f);
        }
    }

    private static void DrawArrowhead(Graphics g, Brush brush, PointF from, PointF to)
    {
        var angle = Math.Atan2(to.Y - from.Y, to.X - from.X);
        var p1 = new PointF(
            to.X - ArrowSize * (float)Math.Cos(angle - Math.PI / 6),
            to.Y - ArrowSize * (float)Math.Sin(angle - Math.PI / 6));
        var p2 = new PointF(
            to.X - ArrowSize * (float)Math.Cos(angle + Math.PI / 6),
            to.Y - ArrowSize * (float)Math.Sin(angle + Math.PI / 6));
        g.FillPolygon(brush, new[] { to, p1, p2 });
    }

    private static void DrawNode(Graphics g, PositionedNode node, Font font, Pen borderPen, Brush fillBrush, Brush textBrush, StringFormat textFormat)
    {
        var bounds = new RectangleF(node.X - node.Width / 2f, node.Y - node.Height / 2f, node.Width, node.Height);

        switch (node.Shape)
        {
            case MermaidNodeShape.Diamond:
                using (var path = new GraphicsPath())
                {
                    path.AddPolygon(new[]
                    {
                        new PointF(bounds.Left + bounds.Width / 2f, bounds.Top),
                        new PointF(bounds.Right, bounds.Top + bounds.Height / 2f),
                        new PointF(bounds.Left + bounds.Width / 2f, bounds.Bottom),
                        new PointF(bounds.Left, bounds.Top + bounds.Height / 2f),
                    });
                    g.FillPath(fillBrush, path);
                    g.DrawPath(borderPen, path);
                }
                break;

            case MermaidNodeShape.Circle:
                g.FillEllipse(fillBrush, bounds);
                g.DrawEllipse(borderPen, bounds);
                break;

            case MermaidNodeShape.Rounded:
                using (var path = RoundedRect(bounds, Math.Min(bounds.Height / 2f, 14f)))
                {
                    g.FillPath(fillBrush, path);
                    g.DrawPath(borderPen, path);
                }
                break;

            default: // Rectangle
                g.FillRectangle(fillBrush, bounds);
                g.DrawRectangle(borderPen, bounds.X, bounds.Y, bounds.Width, bounds.Height);
                break;
        }

        g.DrawString(node.Label, font, textBrush, bounds, textFormat);
    }

    private static GraphicsPath RoundedRect(RectangleF bounds, float radius)
    {
        var diameter = radius * 2f;
        var path = new GraphicsPath();
        path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
