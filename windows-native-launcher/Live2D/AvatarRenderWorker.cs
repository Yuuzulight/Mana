using System.Runtime.InteropServices;
using SkiaSharp;

namespace Mana.NativeLauncher.Live2D;

// Draws the avatar's frames on a thread of its own (#1518), so a heavy model never stalls the launcher: the UI thread
// animates the model and hands over a snapshot of its meshes. A snapshot that comes while the last one is still
// drawing is turned away, so a slow model just gets fewer frames a second. Draws on the GPU through OpenGL when the
// machine has it (DeepSeek-chan: ~14 ms a frame there, ~50 ms on the CPU), else on the CPU. Owns the renderer.
internal sealed class AvatarRenderWorker : IDisposable
{
    internal readonly record struct Target(int Width, int Height, float HeightFraction, float TopMargin = CubismRenderer.TopMargin);

    private sealed record Job(IReadOnlyList<CubismModel.Drawable> Drawables, CubismRenderer.CanvasInfo Canvas, Target[] Targets, Action<SKBitmap[]> Done);

    private readonly CubismRenderer renderer;
    private readonly Thread thread;
    private readonly object gate = new();
    private Job? job;
    private bool busy;
    private bool stopping;
    private readonly TaskCompletionSource<bool> started = new();

    public AvatarRenderWorker(CubismRenderer renderer, bool tryGpu = true)
    {
        this.renderer = renderer;
        thread = new Thread(() => Run(tryGpu)) { IsBackground = true, Name = "Avatar render" };
        thread.Start();
    }

    // Whether frames are drawn on the GPU, once the thread has set up.
    public Task<bool> UsesGpu => started.Task;

    public bool IsBusy
    {
        get { lock (gate) { return busy; } }
    }

    // False while the last frame is still drawing. done gets one frame per target, on the render thread, and owns them.
    public bool TrySubmit(IReadOnlyList<CubismModel.Drawable> drawables, CubismRenderer.CanvasInfo canvas, Target[] targets, Action<SKBitmap[]> done)
    {
        lock (gate)
        {
            if (busy || stopping)
            {
                return false;
            }
            busy = true;
            job = new Job(drawables, canvas, targets, done);
            Monitor.Pulse(gate);
            return true;
        }
    }

    private void Run(bool tryGpu)
    {
        var gl = tryGpu ? GlContext.TryCreate() : null;
        // Skia uploads each texture on first use and keeps it in this cache: room for DeepSeek-chan's five atlases
        // (~220 MB with their mip levels) and the mask layers. Uploading them up front instead made frames slower.
        gl?.Gpu.SetResourceCacheLimit(512L << 20);
        started.SetResult(gl is not null);
        var surfaces = new Dictionary<(int, int), SKSurface>();
        try
        {
            while (true)
            {
                Job next;
                lock (gate)
                {
                    while (job is null && !stopping)
                    {
                        Monitor.Wait(gate);
                    }
                    if (stopping)
                    {
                        return;
                    }
                    next = job!;
                    job = null;
                }
                try
                {
                    var frames = next.Targets.Select(t => gl is null
                        ? renderer.Render(next.Drawables, next.Canvas, t.Width, t.Height, SKColors.Transparent, t.HeightFraction, t.TopMargin)
                        : DrawOnGpu(gl.Gpu, surfaces, next, t)).ToArray();
                    foreach (var size in surfaces.Keys.Except(next.Targets.Select(t => (t.Width, t.Height))).ToList())
                    {
                        surfaces.Remove(size, out var unused);
                        unused!.Dispose();
                    }
                    next.Done(frames);
                }
                catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
                {
                    // A frame that can't be drawn (the window going away mid-frame) is just skipped.
                }
                finally
                {
                    lock (gate)
                    {
                        busy = false;
                    }
                }
            }
        }
        finally
        {
            foreach (var surface in surfaces.Values)
            {
                surface.Dispose();
            }
            renderer.Dispose();
            gl?.Dispose();
        }
    }

    private SKBitmap DrawOnGpu(GRContext gpu, Dictionary<(int, int), SKSurface> surfaces, Job next, Target target)
    {
        var info = new SKImageInfo(target.Width, target.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
        if (!surfaces.TryGetValue((target.Width, target.Height), out var surface))
        {
            surface = SKSurface.Create(gpu, false, info) ?? throw new InvalidOperationException("no GPU surface");
            surfaces[(target.Width, target.Height)] = surface;
        }
        renderer.Draw(surface.Canvas, next.Drawables, next.Canvas, target.Width, target.Height, SKColors.Transparent, target.HeightFraction, target.TopMargin);
        var frame = new SKBitmap(target.Width, target.Height);
        if (!surface.ReadPixels(frame.Info, frame.GetPixels(), frame.RowBytes, 0, 0))
        {
            frame.Dispose();
            throw new InvalidOperationException("GPU readback failed");
        }
        return frame;
    }

    public void Dispose()
    {
        lock (gate)
        {
            stopping = true;
            Monitor.Pulse(gate);
        }
        thread.Join();
    }

    // An OpenGL context on a hidden window, current on the thread that made it, with Skia's GPU context over it.
    private sealed class GlContext : IDisposable
    {
        private readonly nint window;
        private readonly nint dc;
        private readonly nint context;
        public GRContext Gpu { get; }

        private GlContext(nint window, nint dc, nint context, GRContext gpu) => (this.window, this.dc, this.context, Gpu) = (window, dc, context, gpu);

        // Null where there's no usable OpenGL (e.g. only Windows' own software GL 1.1, too old for Skia).
        public static GlContext? TryCreate()
        {
            var window = CreateWindowExW(0, "STATIC", "", 0, 0, 0, 1, 1, 0, 0, 0, 0);
            var dc = window == 0 ? 0 : GetDC(window);
            nint context = 0;
            try
            {
                var format = new PixelFormat
                {
                    Size = (ushort)Marshal.SizeOf<PixelFormat>(),
                    Version = 1,
                    Flags = 0x4 | 0x20 | 0x1, // draw to window, OpenGL, double buffer
                    ColorBits = 32,
                    AlphaBits = 8,
                    StencilBits = 8,
                };
                if (dc == 0 || !SetPixelFormat(dc, ChoosePixelFormat(dc, ref format), ref format))
                {
                    return Fail();
                }
                context = wglCreateContext(dc);
                if (context == 0 || !wglMakeCurrent(dc, context))
                {
                    return Fail();
                }
                using var glInterface = GRGlInterface.Create();
                var gpu = glInterface is null ? null : GRContext.CreateGl(glInterface);
                return gpu is null ? Fail() : new GlContext(window, dc, context, gpu);
            }
            catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
            {
                return Fail();
            }

            GlContext? Fail()
            {
                Release(window, dc, context);
                return null;
            }
        }

        public void Dispose()
        {
            Gpu.Dispose();
            Release(window, dc, context);
        }

        private static void Release(nint window, nint dc, nint context)
        {
            if (context != 0)
            {
                wglMakeCurrent(0, 0);
                wglDeleteContext(context);
            }
            if (dc != 0)
            {
                ReleaseDC(window, dc);
            }
            if (window != 0)
            {
                DestroyWindow(window);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PixelFormat
        {
            public ushort Size, Version;
            public uint Flags;
            public byte PixelType, ColorBits, RedBits, RedShift, GreenBits, GreenShift, BlueBits, BlueShift, AlphaBits, AlphaShift;
            public byte AccumBits, AccumRedBits, AccumGreenBits, AccumBlueBits, AccumAlphaBits, DepthBits, StencilBits, AuxBuffers, LayerType, Reserved;
            public uint LayerMask, VisibleMask, DamageMask;
        }

        [DllImport("user32", CharSet = CharSet.Unicode)]
        private static extern nint CreateWindowExW(int exStyle, string className, string windowName, int style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint param);
        [DllImport("user32")]
        private static extern bool DestroyWindow(nint window);
        [DllImport("user32")]
        private static extern nint GetDC(nint window);
        [DllImport("user32")]
        private static extern int ReleaseDC(nint window, nint dc);
        [DllImport("gdi32")]
        private static extern int ChoosePixelFormat(nint dc, ref PixelFormat format);
        [DllImport("gdi32")]
        private static extern bool SetPixelFormat(nint dc, int format, ref PixelFormat descriptor);
        [DllImport("opengl32")]
        private static extern nint wglCreateContext(nint dc);
        [DllImport("opengl32")]
        private static extern bool wglMakeCurrent(nint dc, nint context);
        [DllImport("opengl32")]
        private static extern bool wglDeleteContext(nint context);
    }
}
