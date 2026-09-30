using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Runtime.CompilerServices;
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

    // #688: everything Attach/Style changed, per control, so Detach can put
    // each control back exactly as the theme left it (live theme switching).
    private sealed class Attachment
    {
        public Attachment(GlassShimmer shimmer) => Shimmer = shimmer;
        public GlassShimmer Shimmer { get; }
        public Dictionary<Control, List<Action>> Undo { get; } = new();
    }

    private static readonly ConditionalWeakTable<Form, Attachment> Attached = new();

    // Records how to put `control` back; dropped when it's disposed.
    private static void Record(Dictionary<Control, List<Action>>? undo, Control control, Action restore)
    {
        if (undo is null)
        {
            return;
        }
        if (!undo.TryGetValue(control, out var actions))
        {
            undo[control] = actions = new List<Action>();
            control.Disposed += (_, _) => undo.Remove(control);
        }
        actions.Add(restore);
    }

    // live: the form is already built (a theme switch), so its controls are
    // styled now rather than on Load.
    public static void Attach(Form form, bool live = false)
    {
        if (Attached.TryGetValue(form, out _))
        {
            return;
        }
        var attachment = new Attachment(new GlassShimmer(form));
        Attached.Add(form, attachment);
        var undo = attachment.Undo;
        RegisterShimmer(form, attachment.Shimmer);

        EnableDoubleBuffering(form);
        var layout = form.BackgroundImageLayout;
        var image = form.BackgroundImage;
        form.BackgroundImageLayout = ImageLayout.None;
        // ponytail: re-renders the whole glow on every resize step; cache per
        // size or debounce if dragging a big window ever feels sluggish.
        void RefreshGlow() => Swap(form, RenderGlow(form.ClientSize, Point.Empty, form.ClientSize));
        EventHandler onResize = (_, _) => RefreshGlow();
        EventHandler onLoad = (_, _) => StyleChildren(form, attachment.Shimmer, undo);
        FormClosedEventHandler onClosed = (_, _) => attachment.Shimmer.Dispose();
        RefreshGlow();
        form.Resize += onResize;
        form.FormClosed += onClosed;
        form.Disposed += (_, _) => form.BackgroundImage?.Dispose();
        Record(undo, form, () =>
        {
            form.Resize -= onResize;
            form.Load -= onLoad;
            form.FormClosed -= onClosed;
            Swap(form, image);
            form.BackgroundImageLayout = layout;
        });
        if (live)
        {
            StyleChildren(form, attachment.Shimmer, undo);
        }
        else
        {
            form.Load += onLoad;
        }
    }

    // #688: undoes Attach and every Style it did (switching away from the
    // Mana preset while the window is open).
    public static void Detach(Form form)
    {
        if (!Attached.TryGetValue(form, out var attachment))
        {
            return;
        }
        Attached.Remove(form);
        attachment.Shimmer.Dispose();
        foreach (var (control, actions) in attachment.Undo.ToList())
        {
            if (control.IsDisposed)
            {
                continue;
            }
            for (var i = actions.Count - 1; i >= 0; i--)
            {
                actions[i]();
            }
        }
        attachment.Undo.Clear();
    }

    internal static bool IsAttached(Form form) => Attached.TryGetValue(form, out _);

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

    private static void StyleChildren(Control parent, GlassShimmer shimmer, Dictionary<Control, List<Action>>? undo)
    {
        foreach (Control child in parent.Controls)
        {
            Style(child, shimmer, undo);
        }
        ControlEventHandler onAdded = (_, e) =>
        {
            if (e.Control is not null)
            {
                Style(e.Control, shimmer, undo);
            }
        };
        parent.ControlAdded += onAdded;
        Record(undo, parent, () => parent.ControlAdded -= onAdded);
    }

    // Decides each control's glass role from the colour the theme gave it,
    // so forms need no glass-specific code of their own.
    // undo (#688): where to record how to put each change back; null (tests)
    // records nothing.
    internal static void Style(Control control, GlassShimmer? shimmer, Dictionary<Control, List<Action>>? undo = null)
    {
        if (shimmer is not null)
        {
            RegisterShimmer(control, shimmer);
        }
        var isPanelColour = control.BackColor == DarkTheme.Panel || control.BackColor == DarkTheme.Panel2;
        var backColor = control.BackColor;
        switch (control)
        {
            case ListView list:
                AttachGlowSlice(list, undo);
                break;
            case TabPage page:
                var useVisualStyle = page.UseVisualStyleBackColor;
                var pageLayout = page.BackgroundImageLayout;
                var pageImage = page.BackgroundImage;
                page.UseVisualStyleBackColor = false;
                page.BackgroundImageLayout = ImageLayout.None;
                void RefreshPage() => Swap(page, RenderGlow(page.ClientSize, Point.Empty, page.ClientSize));
                EventHandler onPageResize = (_, _) => RefreshPage();
                RefreshPage();
                page.Resize += onPageResize;
                page.Disposed += (_, _) => page.BackgroundImage?.Dispose();
                Record(undo, page, () =>
                {
                    page.Resize -= onPageResize;
                    Swap(page, pageImage);
                    page.BackgroundImageLayout = pageLayout;
                    page.UseVisualStyleBackColor = useVisualStyle;
                    page.BackColor = backColor;
                });
                break;
            // Buttons don't blend a semi-transparent fill (they paint it
            // over a solid base), so they go fully see-through and only
            // frost on hover/press.
            case ButtonBase button when isPanelColour:
                button.BackColor = Color.Transparent;
                Record(undo, button, () => button.BackColor = backColor);
                if (button is Button { FlatStyle: FlatStyle.Flat } flat)
                {
                    var appearance = flat.FlatAppearance;
                    var (over, down, border) = (appearance.MouseOverBackColor, appearance.MouseDownBackColor, appearance.BorderColor);
                    appearance.MouseOverBackColor = GlassHover;
                    appearance.MouseDownBackColor = GlassHover;
                    appearance.BorderColor = Color.FromArgb(200, 255, 255, 255);
                    Record(undo, flat, () =>
                    {
                        appearance.MouseOverBackColor = over;
                        appearance.MouseDownBackColor = down;
                        appearance.BorderColor = border;
                    });
                }
                break;
            case Label label when label.BackColor == DarkTheme.Background || isPanelColour || label.BackColor.A < 255:
                label.BackColor = Color.Transparent;
                Record(undo, label, () => label.BackColor = backColor);
                break;
            case Panel panel when panel.BackColor == DarkTheme.Background:
                panel.BackColor = Color.Transparent;
                Record(undo, panel, () => panel.BackColor = backColor);
                break;
            case Panel panel when isPanelColour:
                MakeGlass(panel, shimmer, undo);
                break;
        }
        if (shimmer is not null)
        {
            StyleChildren(control, shimmer, undo);
        }
    }

    private static void MakeGlass(Panel panel, GlassShimmer? shimmer, Dictionary<Control, List<Action>>? undo)
    {
        var backColor = panel.BackColor;
        panel.BackColor = GlassFill;
        EnableDoubleBuffering(panel);
        PaintEventHandler onPaint = (_, e) => PaintGlassEdges(e.Graphics, panel.ClientRectangle, shimmer?.ProgressFor(panel));
        panel.Paint += onPaint;
        Record(undo, panel, () =>
        {
            panel.Paint -= onPaint;
            panel.BackColor = backColor;
        });
    }

    // A ListView can't be see-through, but it natively supports a
    // background image: give it the slice of the window's glows behind it,
    // frosted, kept in step as it or the window resizes or moves.
    private static void AttachGlowSlice(ListView list, Dictionary<Control, List<Action>>? undo)
    {
        var image = list.BackgroundImage;
        var tiled = list.BackgroundImageTiled;
        void Refresh()
        {
            var form = list.FindForm();
            if (form is null || list.Width <= 0 || list.Height <= 0)
            {
                return;
            }
            var offset = form.PointToClient(list.PointToScreen(Point.Empty));
            // A background-coloured list (the chat list) sits straight on the glows.
            Swap(list, RenderGlow(list.ClientSize, offset, form.ClientSize, frosted: list.BackColor != DarkTheme.Background));
        }
        EventHandler onChange = (_, _) => Refresh();
        EnableDoubleBuffering(list); // the shimmer repaints the open chat's row every frame
        list.BackgroundImageTiled = false;
        list.SizeChanged += onChange;
        list.LocationChanged += onChange;
        list.HandleCreated += onChange;
        list.Disposed += (_, _) => list.BackgroundImage?.Dispose();
        Refresh();
        Record(undo, list, () =>
        {
            list.SizeChanged -= onChange;
            list.LocationChanged -= onChange;
            list.HandleCreated -= onChange;
            Swap(list, image);
            list.BackgroundImageTiled = tiled;
        });
    }

    // The #652 mockup's shimmer, only where it puts it: each surface gets a
    // delay (its --d) and, if only part of it shines (the open chat's card,
    // the title strip), that part. Kept per control, so a live theme switch
    // back to Mana picks it up again when it restyles the window.
    private static readonly ConditionalWeakTable<Control, Tuple<int, Func<Rectangle>?>> ShimmerSpecs = new();

    public static void Shimmer(Control control, int delayMs, Func<Rectangle>? area = null)
    {
        ShimmerSpecs.AddOrUpdate(control, Tuple.Create(delayMs, area));
        if (control.FindForm() is { } form && Attached.TryGetValue(form, out var attachment))
        {
            RegisterShimmer(control, attachment.Shimmer);
        }
    }

    private static void RegisterShimmer(Control control, GlassShimmer shimmer)
    {
        if (ShimmerSpecs.TryGetValue(control, out var spec))
        {
            shimmer.Register(control, spec.Item1, spec.Item2);
        }
    }

    // How far the sheen is across `control` right now, or null when it isn't shining.
    public static float? SheenProgress(Control control) =>
        control.FindForm() is { } form && Attached.TryGetValue(form, out var attachment) ? attachment.Shimmer.ProgressFor(control) : null;

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

    // The mockup's .shimmer::after: a 115deg band (clear, white .6, sky .5,
    // clear at 38/48/52/62%) on an image 260% as wide as the surface, slid
    // from background-position 130% to -130% as progress goes 0 -> 1.
    internal static void PaintSheen(Graphics g, Rectangle bounds, float progress)
    {
        var imageWidth = bounds.Width * 2.6f;
        var position = 1.3f - 2.6f * progress;
        var image = new RectangleF(bounds.X - 1.6f * bounds.Width * position, bounds.Y, imageWidth, bounds.Height);
        var visible = RectangleF.Intersect(image, bounds);
        if (visible.Width <= 0 || visible.Height <= 0)
        {
            return;
        }
        using var brush = new LinearGradientBrush(image, Color.Transparent, Color.Transparent, 25f, false) // CSS 115deg
        {
            InterpolationColors = new ColorBlend
            {
                Colors = new[] { Color.FromArgb(0, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), Color.FromArgb(153, 255, 255, 255), Color.FromArgb(128, 227, 241, 253), Color.FromArgb(0, 227, 241, 253), Color.FromArgb(0, 227, 241, 253) },
                Positions = new[] { 0f, 0.38f, 0.48f, 0.52f, 0.62f, 1f },
            },
        };
        g.FillRectangle(brush, visible);
    }

    // A glass button in the Mana preset (gloss: the mockup's glossy accent
    // one, for Send), painted over whatever the theme drew; other presets
    // keep their own look. Call before any Paint handler that draws on top
    // (an icon). A checked toggle (CheckBox) gets the mockup's lavender "on".
    public static void MakeGlassButton(ButtonBase button, bool gloss = false)
    {
        button.Paint += (_, e) =>
        {
            if (DarkTheme.IsGlass)
            {
                PaintGlassButton(e.Graphics, button, gloss);
            }
        };
    }

    private static readonly Color GlassOn = Color.FromArgb(217, 238, 231, 248);

    private static void PaintGlassButton(Graphics g, ButtonBase button, bool gloss)
    {
        var bounds = button.ClientRectangle;
        if (bounds.Width <= 0 || bounds.Height <= 0)
        {
            return;
        }
        PaintGlowBehind(g, button, bounds);
        var hot = button.Enabled && bounds.Contains(button.PointToClient(Control.MousePosition));
        var down = hot && Control.MouseButtons == MouseButtons.Left;
        Color ink;
        if (gloss)
        {
            // .gloss: #7e74cb -> #6a5fb8 (55%) -> #6258ad, a bright inner top edge.
            using var fill = new LinearGradientBrush(bounds, Color.Black, Color.Black, LinearGradientMode.Vertical)
            {
                InterpolationColors = new ColorBlend
                {
                    Colors = new[] { Color.FromArgb(0x7e, 0x74, 0xcb), Color.FromArgb(0x6a, 0x5f, 0xb8), Color.FromArgb(0x62, 0x58, 0xad) },
                    Positions = new[] { 0f, 0.55f, 1f },
                },
            };
            g.FillRectangle(fill, bounds);
            if (hot)
            {
                using var tint = new SolidBrush(down ? Color.FromArgb(36, 0, 0, 0) : Color.FromArgb(28, 255, 255, 255));
                g.FillRectangle(tint, bounds);
            }
            using var edge = new Pen(Color.FromArgb(89, 255, 255, 255));
            g.DrawLine(edge, bounds.X, bounds.Y, bounds.Right - 1, bounds.Y);
            ink = Color.White;
        }
        else
        {
            var on = button is CheckBox { Checked: true };
            using (var fill = new SolidBrush(on ? GlassOn : down ? Color.FromArgb(215, 255, 255, 255) : hot ? GlassHover : Color.FromArgb(133, 255, 255, 255)))
            {
                g.FillRectangle(fill, bounds);
            }
            PaintGlassEdges(g, bounds, null);
            ink = on ? DarkTheme.Accent : DarkTheme.Text;
        }
        if (button.Text.Length > 0)
        {
            var left = button.TextAlign is ContentAlignment.MiddleLeft or ContentAlignment.TopLeft or ContentAlignment.BottomLeft;
            TextRenderer.DrawText(g, button.Text, button.Font, Rectangle.Inflate(bounds, -12, 0), button.Enabled ? ink : DarkTheme.Muted,
                TextFormatFlags.VerticalCenter | (left ? TextFormatFlags.Left : TextFormatFlags.HorizontalCenter) | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }
        if (button.Focused && ShowsFocusCues(button))
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(bounds, -3, -3));
        }
    }

    // The window's glows behind `control` -- what a see-through control
    // shows, for one that paints its own background (a ListView row, a
    // glass button over the theme's own drawing).
    public static void PaintGlowBehind(Graphics g, Control control, Rectangle bounds)
    {
        if (control.FindForm() is { BackgroundImage: { } glow } form)
        {
            var offset = form.PointToClient(control.PointToScreen(Point.Empty));
            g.DrawImage(glow, bounds, bounds with { X = bounds.X + offset.X, Y = bounds.Y + offset.Y }, GraphicsUnit.Pixel);
        }
    }

    // A text box inside a padded field: glass edges in the Mana preset, a
    // plain border elsewhere, filled with the box's own colour so they meet
    // seamlessly. The caller docks the box.
    public static Panel Field(TextBox box, Padding padding)
    {
        box.BorderStyle = BorderStyle.None;
        var field = new Panel { BackColor = Color.Transparent, Padding = padding, Cursor = Cursors.IBeam };
        field.Controls.Add(box);
        field.MouseDown += (_, _) => box.Focus();
        field.Paint += (_, e) =>
        {
            var bounds = field.ClientRectangle;
            using var fill = new SolidBrush(box.BackColor);
            e.Graphics.FillRectangle(fill, bounds);
            if (DarkTheme.IsGlass)
            {
                PaintGlassEdges(e.Graphics, bounds, null);
                return;
            }
            using var border = new Pen(DarkTheme.Border);
            e.Graphics.DrawRectangle(border, bounds.X, bounds.Y, bounds.Width - 1, bounds.Height - 1);
        };
        box.BackColorChanged += (_, _) => field.Invalidate();
        return field;
    }

    // Keyboard focus rectangles only once the keyboard's been used, like
    // Windows' own controls (Control.ShowFocusCues is protected).
    internal static bool ShowsFocusCues(Control control) =>
        control.IsHandleCreated && ((long)SendMessage(control.Handle, WmQueryUiState, IntPtr.Zero, IntPtr.Zero) & UisfHideFocus) == 0;

    private const int WmQueryUiState = 0x0129;
    private const long UisfHideFocus = 0x1;

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    private static void Swap(Control control, Image? image)
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

// Runs the mockup's shimmer: every registered surface shines once per 9s
// cycle, its own delay apart, the band crossing in the cycle's last 30%
// (2.7s, eased). Only while its window is the active one, and never when
// Windows' "Animation effects" setting is off (the reduced-motion setting).
internal sealed class GlassShimmer : IDisposable
{
    private const int FrameMs = 33;
    internal const int PeriodMs = 9000;
    internal const int SweepMs = 2700;

    private readonly Form form;
    private readonly Dictionary<Control, (int DelayMs, Func<Rectangle>? Area)> surfaces = new();
    private readonly HashSet<Control> shining = new();
    private readonly System.Windows.Forms.Timer timer = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly bool enabled = AnimationsEnabled();

    public GlassShimmer(Form form)
    {
        this.form = form;
        timer.Tick += OnTick;
        if (enabled)
        {
            timer.Interval = FrameMs;
            timer.Start();
        }
    }

    public void Register(Control control, int delayMs, Func<Rectangle>? area)
    {
        if (!surfaces.ContainsKey(control))
        {
            control.Disposed += (_, _) =>
            {
                surfaces.Remove(control);
                shining.Remove(control);
            };
        }
        surfaces[control] = (delayMs, area);
    }

    public float? ProgressFor(Control control) =>
        enabled && Form.ActiveForm == form && surfaces.TryGetValue(control, out var surface) ? SheenAt(clock.ElapsedMilliseconds, surface.DelayMs) : null;

    // The eased sweep progress `elapsedMs` into the animation, or null
    // outside the sweep (CSS ease-in-out, approximated by smoothstep).
    internal static float? SheenAt(long elapsedMs, int delayMs)
    {
        var t = elapsedMs - delayMs;
        var into = t % PeriodMs - (PeriodMs - SweepMs);
        if (t < 0 || into < 0)
        {
            return null;
        }
        var x = into / (float)SweepMs;
        return x * x * (3 - 2 * x);
    }

    private void OnTick(object? sender, EventArgs e)
    {
        var active = Form.ActiveForm == form && form.Visible;
        var now = clock.ElapsedMilliseconds;
        var untilNext = (long)PeriodMs;
        foreach (var (control, surface) in surfaces)
        {
            var on = active && SheenAt(now, surface.DelayMs) is not null;
            if (on || shining.Contains(control))
            {
                // The frame after a sweep clears the band.
                if (surface.Area is { } area)
                {
                    control.Invalidate(area(), false);
                }
                else
                {
                    control.Invalidate(true);
                }
            }
            if (on)
            {
                shining.Add(control);
            }
            else
            {
                shining.Remove(control);
                var t = now - surface.DelayMs;
                var wait = t < 0 ? -t + PeriodMs - SweepMs : (PeriodMs - SweepMs - t % PeriodMs + PeriodMs) % PeriodMs;
                untilNext = Math.Min(untilNext, wait);
            }
        }
        // Inactive, it checks back twice a second to pick up when it's activated again.
        timer.Interval = shining.Count > 0 ? FrameMs : active ? (int)Math.Clamp(untilNext, FrameMs, PeriodMs) : 500;
    }

    public void Dispose()
    {
        timer.Stop();
        timer.Dispose();
    }

    internal static bool AnimationsEnabled()
    {
        const uint SpiGetClientAreaAnimation = 0x1042;
        var enabled = true;
        return !SystemParametersInfo(SpiGetClientAreaAnimation, 0, ref enabled, 0) || enabled;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SystemParametersInfo(uint action, uint param, ref bool value, uint winIni);
}
