using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mana.NativeLauncher;

// The glass looks like Windows 11's Mica: the wallpaper, blurred and tinted, under the window. Windows' own backdrop
// (DWMWA_SYSTEMBACKDROP_TYPE) only shows through pixels drawn with alpha, which GDI text and the native lists don't
// draw, so the wallpaper is read here and blurred once: each monitor's wallpaper, laid out the way Windows lays it out,
// kept as a small, heavily blurred bitmap (1/16 scale, tens of KB). GlassSurface draws the slice under the window.
// Rebuilt when the wallpaper or the displays change. Null when there's no wallpaper picture (a plain colour), and the
// glass keeps her painted glows.
internal static class WallpaperBackdrop
{
    internal const int Scale = 16;
    private const int BlurPasses = 3;
    private const int BlurRadius = 5; // at 1/16 scale: about 80 px on screen per pass

    internal sealed record MonitorBackdrop(Rectangle Bounds, Bitmap Blurred);

    private static IReadOnlyList<MonitorBackdrop>? cache;
    private static bool loaded;

    // Bumped when the wallpaper or the displays change, so cached backgrounds know to redraw.
    public static int Version { get; private set; }

    public static event Action? Changed;

    static WallpaperBackdrop()
    {
        SystemEvents.UserPreferenceChanged += (_, e) =>
        {
            if (e.Category is UserPreferenceCategory.Desktop or UserPreferenceCategory.General)
            {
                Invalidate();
            }
        };
        SystemEvents.DisplaySettingsChanged += (_, _) => Invalidate();
    }

    public static IReadOnlyList<MonitorBackdrop>? Current
    {
        get
        {
            if (!loaded)
            {
                loaded = true;
                try
                {
                    cache = Load();
                }
                catch (Exception ex) when (ex is COMException or IOException or ArgumentException or OutOfMemoryException or InvalidCastException or UnauthorizedAccessException)
                {
                    Console.WriteLine($"WallpaperBackdrop: no wallpaper backdrop. {ex.Message}");
                    cache = null;
                }
            }
            return cache;
        }
    }

    private static void Invalidate()
    {
        if (cache is not null)
        {
            foreach (var monitor in cache)
            {
                monitor.Blurred.Dispose();
            }
        }
        cache = null;
        loaded = false;
        Version++;
        Changed?.Invoke();
    }

    private static IReadOnlyList<MonitorBackdrop>? Load()
    {
        var desktop = (IDesktopWallpaper)new DesktopWallpaperClass();
        try
        {
            var position = desktop.GetPosition();
            var background = ColorTranslator.FromWin32((int)desktop.GetBackgroundColor());
            var count = desktop.GetMonitorDevicePathCount();
            var monitors = new List<(Rectangle Bounds, string Path)>();
            for (uint i = 0; i < count; i++)
            {
                // Windows keeps entries for displays that were connected once (a "legacy_monitor", an old id); asking
                // for their rectangle fails, and they aren't on screen, so they're skipped.
                try
                {
                    var id = desktop.GetMonitorDevicePathAt(i);
                    var rect = desktop.GetMonitorRECT(id);
                    monitors.Add((Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom), desktop.GetWallpaper(id) ?? ""));
                }
                catch (COMException)
                {
                }
            }
            if (monitors.Count == 0 || monitors.TrueForAll(m => m.Path.Length == 0 || !File.Exists(m.Path)))
            {
                return null;
            }
            var virtualScreen = monitors.ConvertAll(m => m.Bounds).Aggregate(Rectangle.Union);
            var result = new List<MonitorBackdrop>();
            var images = new Dictionary<string, Image>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var (bounds, path) in monitors)
                {
                    if (path.Length == 0 || !File.Exists(path) || bounds.Width <= 0 || bounds.Height <= 0)
                    {
                        continue;
                    }
                    if (!images.TryGetValue(path, out var image))
                    {
                        images[path] = image = Image.FromFile(path);
                    }
                    result.Add(new MonitorBackdrop(bounds, Render(image, bounds, virtualScreen, position, background)));
                }
            }
            finally
            {
                foreach (var image in images.Values)
                {
                    image.Dispose();
                }
            }
            return result.Count > 0 ? result : null;
        }
        finally
        {
            Marshal.ReleaseComObject(desktop);
        }
    }

    // One monitor's wallpaper as Windows shows it, at 1/16 scale, blurred.
    private static Bitmap Render(Image image, Rectangle monitor, Rectangle virtualScreen, WallpaperPosition position, Color background)
    {
        var small = new Bitmap(Math.Max(1, monitor.Width / Scale), Math.Max(1, monitor.Height / Scale), PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(small))
        {
            g.Clear(background);
            g.InterpolationMode = InterpolationMode.HighQualityBilinear;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.ScaleTransform(1f / Scale, 1f / Scale);
            if (position == WallpaperPosition.Tile)
            {
                for (var y = 0; y < monitor.Height; y += image.Height)
                {
                    for (var x = 0; x < monitor.Width; x += image.Width)
                    {
                        g.DrawImage(image, x, y, image.Width, image.Height);
                    }
                }
            }
            else
            {
                var area = position == WallpaperPosition.Span ? virtualScreen with { X = virtualScreen.X - monitor.X, Y = virtualScreen.Y - monitor.Y } : new Rectangle(Point.Empty, monitor.Size);
                g.DrawImage(image, Placement(image.Size, area, position == WallpaperPosition.Span ? WallpaperPosition.Fill : position));
            }
        }
        BoxBlur(small, BlurRadius, BlurPasses);
        return small;
    }

    // Where Windows puts a wallpaper of `image` size in `area` for each layout (Span is Fill over all monitors).
    internal static RectangleF Placement(Size image, Rectangle area, WallpaperPosition position)
    {
        if (image.Width <= 0 || image.Height <= 0)
        {
            return area;
        }
        float w = image.Width, h = image.Height;
        switch (position)
        {
            case WallpaperPosition.Stretch:
                return area;
            case WallpaperPosition.Center:
                return new RectangleF(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h);
            case WallpaperPosition.Fit:
            {
                var scale = Math.Min(area.Width / w, area.Height / h);
                return new RectangleF(area.X + (area.Width - w * scale) / 2, area.Y + (area.Height - h * scale) / 2, w * scale, h * scale);
            }
            default: // Fill (and Span over the whole desktop)
            {
                var scale = Math.Max(area.Width / w, area.Height / h);
                return new RectangleF(area.X + (area.Width - w * scale) / 2, area.Y + (area.Height - h * scale) / 2, w * scale, h * scale);
            }
        }
    }

    // A separable box blur, run `passes` times: three passes come close to a Gaussian. Edges repeat their last pixel.
    internal static void BoxBlur(Bitmap bitmap, int radius, int passes)
    {
        var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var data = bitmap.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            var w = bitmap.Width;
            var h = bitmap.Height;
            var pixels = new int[w * h];
            Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
            var scratch = new int[pixels.Length];
            for (var pass = 0; pass < passes; pass++)
            {
                BlurLines(pixels, scratch, w, h, 1, w, radius);  // rows
                BlurLines(scratch, pixels, h, w, w, 1, radius);  // columns
            }
            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    // Blurs `lines` lines of `length` pixels; step moves along a line, stride from one line to the next.
    private static void BlurLines(int[] source, int[] target, int length, int lines, int step, int stride, int radius)
    {
        var span = radius * 2 + 1;
        for (var line = 0; line < lines; line++)
        {
            var start = line * stride;
            int a = 0, r = 0, g = 0, b = 0;
            for (var i = -radius; i <= radius; i++)
            {
                var p = source[start + Math.Clamp(i, 0, length - 1) * step];
                a += (p >> 24) & 255; r += (p >> 16) & 255; g += (p >> 8) & 255; b += p & 255;
            }
            for (var i = 0; i < length; i++)
            {
                target[start + i * step] = ((a / span) << 24) | ((r / span) << 16) | ((g / span) << 8) | (b / span);
                var leave = source[start + Math.Clamp(i - radius, 0, length - 1) * step];
                var enter = source[start + Math.Clamp(i + radius + 1, 0, length - 1) * step];
                a += ((enter >> 24) & 255) - ((leave >> 24) & 255);
                r += ((enter >> 16) & 255) - ((leave >> 16) & 255);
                g += ((enter >> 8) & 255) - ((leave >> 8) & 255);
                b += (enter & 255) - (leave & 255);
            }
        }
    }

    // Draws the wallpaper that lies under `screenArea` (screen pixels) at (0, 0) of `g`.
    public static void Draw(Graphics g, IReadOnlyList<MonitorBackdrop> monitors, Rectangle screenArea)
    {
        var state = g.Save();
        g.InterpolationMode = InterpolationMode.HighQualityBilinear;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        using var attributes = new ImageAttributes();
        attributes.SetWrapMode(WrapMode.TileFlipXY); // no dark seams where the small image is stretched to its edges
        foreach (var monitor in monitors)
        {
            var target = Rectangle.Intersect(monitor.Bounds, screenArea);
            if (target.IsEmpty)
            {
                continue;
            }
            var destination = new Rectangle(monitor.Bounds.X - screenArea.X, monitor.Bounds.Y - screenArea.Y, monitor.Bounds.Width, monitor.Bounds.Height);
            g.DrawImage(monitor.Blurred, destination, 0, 0, monitor.Blurred.Width, monitor.Blurred.Height, GraphicsUnit.Pixel, attributes);
        }
        g.Restore(state);
    }

    // ---- IDesktopWallpaper (Windows 8+) ----

    [ComImport, Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")]
    private class DesktopWallpaperClass
    {
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDesktopWallpaper
    {
        void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string? monitorId, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
        [return: MarshalAs(UnmanagedType.LPWStr)]
        string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string? monitorId);
        [return: MarshalAs(UnmanagedType.LPWStr)]
        string GetMonitorDevicePathAt(uint monitorIndex);
        uint GetMonitorDevicePathCount();
        Rect GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorId);
        void SetBackgroundColor(uint color);
        uint GetBackgroundColor();
        void SetPosition(WallpaperPosition position);
        WallpaperPosition GetPosition();
    }
}

// DESKTOP_WALLPAPER_POSITION
internal enum WallpaperPosition
{
    Center = 0,
    Tile = 1,
    Stretch = 2,
    Fit = 3,
    Fill = 4,
    Span = 5,
}
