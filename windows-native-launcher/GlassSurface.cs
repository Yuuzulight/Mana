using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #652: the Mana preset's frosted-glass look. WinForms can't blur what's
// behind a control, so the glass is built from what it can do: the window
// background is a pre-rendered image of soft lavender/sky-blue glows (her
// hair colours), background-coloured containers turn see-through so the
// glows show behind them, and panel-coloured cards become translucent white
// with a bright top edge. Since the glows are soft, the missing blur barely
// shows. Only attached when DarkTheme.IsGlass (the Mana preset).
internal static class GlassSurface
{
    internal static readonly Color GlassFill = Color.FromArgb(135, 255, 255, 255);
    private static readonly Color GlassHover = Color.FromArgb(200, 255, 255, 255);
    private static readonly Color TopEdge = Color.FromArgb(240, 255, 255, 255);
    private static readonly Color Outline = Color.FromArgb(34, 106, 95, 184);

    public static void Attach(Form form)
    {
        EnableDoubleBuffering(form);
        form.BackgroundImageLayout = ImageLayout.None;
        // ponytail: re-renders the whole glow on every resize step; cache per
        // size or debounce if dragging a big window ever feels sluggish.
        void RefreshGlow() => Swap(form, RenderGlow(form.ClientSize, Point.Empty, form.ClientSize));
        RefreshGlow();
        form.Resize += (_, _) => RefreshGlow();

        var shimmer = new GlassShimmer(form);
        form.Load += (_, _) => StyleChildren(form, shimmer);
        form.FormClosed += (_, _) => shimmer.Dispose();
        form.Disposed += (_, _) => form.BackgroundImage?.Dispose();
    }

    // The glows for a `size` area sitting at `offset` inside a window of
    // `windowSize` -- so a control that can't be see-through (a ListView)
    // can paint exactly the slice of the window's glows behind it.
    internal static Bitmap RenderGlow(Size size, Point offset, Size windowSize, bool frosted = false)
    {
        var bitmap = new Bitmap(Math.Max(1, size.Width), Math.Max(1, size.Height));
        using var g = Graphics.FromImage(bitmap);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(DarkTheme.Background);
        g.TranslateTransform(-offset.X, -offset.Y);
        var w = Math.Max(1, windowSize.Width);
        var h = Math.Max(1, windowSize.Height);
        var span = Math.Max(w, h);
        FillGlow(g, new PointF(w * 0.05f, h * 0.02f), span * 0.55f, Color.FromArgb(150, 198, 170, 224)); // lavender, top left
        FillGlow(g, new PointF(w * 0.98f, h * 1.02f), span * 0.62f, Color.FromArgb(160, 163, 210, 250)); // sky blue, bottom right
        FillGlow(g, new PointF(w * 0.55f, h * 0.45f), span * 0.35f, Color.FromArgb(40, 118, 109, 190));  // faint periwinkle
        if (frosted)
        {
            g.ResetTransform();
            using var frost = new SolidBrush(GlassFill);
            g.FillRectangle(frost, 0, 0, bitmap.Width, bitmap.Height);
        }
        return bitmap;
    }

    private static void FillGlow(Graphics g, PointF center, float radius, Color color)
    {
        var rect = new RectangleF(center.X - radius, center.Y - radius, radius * 2, radius * 2);
        using var path = new GraphicsPath();
        path.AddEllipse(rect);
        using var brush = new PathGradientBrush(path)
        {
            CenterColor = color,
            SurroundColors = new[] { Color.FromArgb(0, color) },
        };
        g.FillEllipse(brush, rect);
    }

    private static void StyleChildren(Control parent, GlassShimmer shimmer)
    {
        foreach (Control child in parent.Controls)
        {
            Style(child, shimmer);
        }
        parent.ControlAdded += (_, e) =>
        {
            if (e.Control is not null)
            {
                Style(e.Control, shimmer);
            }
        };
    }

    // Decides each control's glass role from the colour the theme gave it,
    // so forms need no glass-specific code of their own.
    internal static void Style(Control control, GlassShimmer? shimmer)
    {
        var isPanelColour = control.BackColor == DarkTheme.Panel || control.BackColor == DarkTheme.Panel2;
        switch (control)
        {
            case ListView list:
                AttachGlowSlice(list);
                break;
            case TabPage page:
                page.UseVisualStyleBackColor = false;
                page.BackgroundImageLayout = ImageLayout.None;
                void RefreshPage() => Swap(page, RenderGlow(page.ClientSize, Point.Empty, page.ClientSize));
                RefreshPage();
                page.Resize += (_, _) => RefreshPage();
                page.Disposed += (_, _) => page.BackgroundImage?.Dispose();
                break;
            // Buttons don't blend a semi-transparent fill (they paint it
            // over a solid base), so they go fully see-through and only
            // frost on hover/press.
            case ButtonBase button when isPanelColour:
                button.BackColor = Color.Transparent;
                if (button is Button { FlatStyle: FlatStyle.Flat } flat)
                {
                    flat.FlatAppearance.MouseOverBackColor = GlassHover;
                    flat.FlatAppearance.MouseDownBackColor = GlassHover;
                    flat.FlatAppearance.BorderColor = Color.FromArgb(200, 255, 255, 255);
                }
                break;
            case Label label when label.BackColor == DarkTheme.Background || isPanelColour || label.BackColor.A < 255:
                label.BackColor = Color.Transparent;
                break;
            case Panel panel when panel.BackColor == DarkTheme.Background:
                panel.BackColor = Color.Transparent;
                break;
            case Panel panel when isPanelColour:
                MakeGlass(panel, shimmer);
                break;
        }
        if (shimmer is not null)
        {
            StyleChildren(control, shimmer);
        }
    }

    private static void MakeGlass(Panel panel, GlassShimmer? shimmer)
    {
        panel.BackColor = GlassFill;
        EnableDoubleBuffering(panel);
        panel.Paint += (_, e) => PaintGlassEdges(e.Graphics, panel.ClientRectangle, shimmer?.ProgressFor(panel));
        shimmer?.Register(panel);
    }

    // A ListView can't be see-through, but it natively supports a
    // background image: give it the slice of the window's glows behind it,
    // frosted, kept in step as it or the window resizes or moves.
    private static void AttachGlowSlice(ListView list)
    {
        void Refresh()
        {
            var form = list.FindForm();
            if (form is null || list.Width <= 0 || list.Height <= 0)
            {
                return;
            }
            var offset = form.PointToClient(list.PointToScreen(Point.Empty));
            Swap(list, RenderGlow(list.ClientSize, offset, form.ClientSize, frosted: true));
        }
        list.BackgroundImageTiled = false;
        list.SizeChanged += (_, _) => Refresh();
        list.LocationChanged += (_, _) => Refresh();
        list.HandleCreated += (_, _) => Refresh();
        list.Disposed += (_, _) => list.BackgroundImage?.Dispose();
        Refresh();
    }

    internal static void PaintGlassEdges(Graphics g, Rectangle bounds, float? sheenProgress)
    {
        if (bounds.Width <= 0 || bounds.Height <= 0)
        {
            return;
        }
        if (sheenProgress is float progress)
        {
            PaintSheen(g, bounds, progress);
        }
        using var outline = new Pen(Outline);
        g.DrawRectangle(outline, bounds.X, bounds.Y, bounds.Width - 1, bounds.Height - 1);
        using var top = new Pen(TopEdge);
        g.DrawLine(top, bounds.X + 1, bounds.Y + 1, bounds.Right - 2, bounds.Y + 1);
    }

    // A slanted band of light that sweeps left to right as progress goes 0 -> 1.
    private static void PaintSheen(Graphics g, Rectangle bounds, float progress)
    {
        const float slant = 0.45f;
        var bandWidth = Math.Max(60f, bounds.Width * 0.35f);
        var travel = bounds.Width + bandWidth * 2 + bounds.Height * slant;
        var x = bounds.X - bandWidth - bounds.Height * slant + progress * travel;
        var band = new RectangleF(x, bounds.Y, bandWidth, bounds.Height);
        using var brush = new LinearGradientBrush(band, Color.Transparent, Color.Transparent, LinearGradientMode.Horizontal)
        {
            InterpolationColors = new ColorBlend
            {
                Colors = new[] { Color.FromArgb(0, 255, 255, 255), Color.FromArgb(120, 255, 255, 255), Color.FromArgb(90, 227, 241, 253), Color.FromArgb(0, 227, 241, 253) },
                Positions = new[] { 0f, 0.45f, 0.55f, 1f },
            },
        };
        var saved = g.Transform;
        var clip = g.Clip;
        g.SetClip(bounds, CombineMode.Intersect);
        // Shear about the rect's top edge so the band stays inside it.
        using var shear = new Matrix(1, 0, slant, 1, -slant * bounds.Y, 0);
        g.MultiplyTransform(shear);
        g.FillRectangle(brush, band);
        g.Transform = saved;
        g.Clip = clip;
    }

    private static void Swap(Control control, Image image)
    {
        var old = control.BackgroundImage;
        control.BackgroundImage = image;
        old?.Dispose();
    }

    private static readonly PropertyInfo DoubleBufferedProperty =
        typeof(Control).GetProperty("DoubleBuffered", BindingFlags.Instance | BindingFlags.NonPublic)!;

    // See-through children repaint their parent's background, which
    // flickers without double buffering; Control.DoubleBuffered is
    // protected, hence reflection.
    private static void EnableDoubleBuffering(Control control) => DoubleBufferedProperty.SetValue(control, true);
}

// Sweeps a sheen across one glass panel at a time: 1.4s per sweep, 9s
// apart, only while its window is the active one, and never when Windows'
// "Animation effects" setting is off.
internal sealed class GlassShimmer : IDisposable
{
    private const int FrameMs = 33;
    private const int SweepMs = 1400;
    private const int GapMs = 9000;

    private readonly Form form;
    private readonly List<Control> panels = new();
    private readonly System.Windows.Forms.Timer timer = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private Control? active;
    private int nextIndex;
    private long sweepStartMs;
    private long nextSweepMs = 2500;

    public GlassShimmer(Form form)
    {
        this.form = form;
        timer.Tick += OnTick;
        if (AnimationsEnabled())
        {
            timer.Interval = FrameMs;
            timer.Start();
        }
    }

    public void Register(Control panel)
    {
        panels.Add(panel);
        panel.Disposed += (_, _) => panels.Remove(panel);
    }

    public float? ProgressFor(Control panel) =>
        panel == active ? Math.Clamp((clock.ElapsedMilliseconds - sweepStartMs) / (float)SweepMs, 0f, 1f) : null;

    private void OnTick(object? sender, EventArgs e)
    {
        var now = clock.ElapsedMilliseconds;
        if (active is null)
        {
            if (now < nextSweepMs || panels.Count == 0 || Form.ActiveForm != form || !form.Visible)
            {
                timer.Interval = (int)Math.Clamp(nextSweepMs - now, FrameMs, GapMs);
                return;
            }
            nextIndex %= panels.Count;
            active = panels[nextIndex++];
            sweepStartMs = now;
            timer.Interval = FrameMs;
        }

        var sweeping = active;
        if (now - sweepStartMs >= SweepMs || Form.ActiveForm != form)
        {
            active = null;
            nextSweepMs = now + GapMs;
        }
        sweeping.Invalidate(true);
    }

    public void Dispose()
    {
        timer.Stop();
        timer.Dispose();
    }

    private static bool AnimationsEnabled()
    {
        const uint SpiGetClientAreaAnimation = 0x1042;
        var enabled = true;
        return !SystemParametersInfo(SpiGetClientAreaAnimation, 0, ref enabled, 0) || enabled;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SystemParametersInfo(uint action, uint param, ref bool value, uint winIni);
}
