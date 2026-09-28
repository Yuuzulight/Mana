using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Mana.NativeLauncher.Live2D;
using SkiaSharp;

namespace Mana.NativeLauncher;

internal enum AvatarState
{
    Idle,
    Talking,
    Excited,
    Sad,
    Angry,
    Disgusted,
}

// #479 sub-project 4: renders a real, parameter-driven Cubism model when
// the (proprietary, gitignored, manually-installed -- see
// native/cubism-core/README.md) Cubism Core native SDK and a Live2D model
// are both present, driven live by LipSyncDriver's audio-derived mouth
// signal. Falls back to the original static idle/talking PNG swap
// unchanged when either isn't available, exactly matching this class's
// pre-sub-project-4 behavior -- this is a real fallback path, not just a
// stub, since the SDK is intentionally not something every checkout has.
//
// The window is a per-pixel-alpha layered window: every frame (Live2D or
// PNG) is pushed as premultiplied BGRA through UpdateLayeredWindow, so her
// anti-aliased edges blend with whatever is behind her. (A TransparencyKey
// color can only make pixels fully clear or fully opaque, which left a
// magenta fringe wherever an edge was half-transparent.)
internal sealed class AvatarOverlayForm : Form
{
    private readonly string idlePath;
    private readonly string talkingPath;

    // #479 sub-project 4: fed live samples by AudioPlayer (wired up by
    // ManaApplicationContext, which constructs AudioPlayer after this
    // form) via its public OnSamplesPlayed method -- exposed here so that
    // wiring can happen without AudioPlayer/VoiceLoop needing to know
    // anything about avatar rendering.
    public LipSyncDriver LipSyncDriver { get; } = new();

    // #538's own sidebar had a static "Avatar: idle" card; SessionListForm
    // ports that as a real, live-updating one instead, reading this rather
    // than guessing at state from the outside. Only ever written inside
    // SetState after its own marshal-to-UI-thread guard, so (like
    // activeExpression above) no lock is needed.
    public AvatarState CurrentState { get; private set; } = AvatarState.Idle;
    public event Action<AvatarState>? StateChanged;

    private readonly CubismModel? cubismModel;
    private readonly CubismRenderer? cubismRenderer;
    private readonly System.Windows.Forms.Timer? renderTimer;
    private readonly Stopwatch renderClock = Stopwatch.StartNew();
    private long lastRenderTickMs;
    private float smoothedMouthOpen;
    private float smoothedMouthForm;

    // #514: the model's own declared expressions (Name -> parsed file),
    // empty when it doesn't ship any. activeExpression is whichever one
    // AvatarExpressionSelector picked for the current mood state, applied
    // fresh every render tick -- null means "no expression selected",
    // which is also true whenever the model has none. Both fields are
    // only ever touched on the UI thread (SetState already marshals
    // there before writing; RenderFrame runs on the WinForms Timer's own
    // UI-thread tick), so no lock is needed for either.
    private readonly IReadOnlyDictionary<string, CubismExpressionFile> expressions;
    private CubismExpressionFile? activeExpression;

    // #515: the model's own first Idle motion (null if it declares none),
    // applied continuously every render tick as the base animation layer
    // -- see RenderFrame's own layering comment for why it runs before
    // expression/lip-sync. Read-only after construction, so (unlike
    // activeExpression) it needs no thread-ownership comment.
    private readonly CubismMotionFile? idleMotion;

    // #342 follow-up: fallback base layer for when idleMotion above is
    // null (no authored .motion3.json idle clip configured, or it failed
    // to load) -- without this, the avatar previously had zero idle
    // movement in that case. Only ever constructed when idleMotion is
    // null (see the constructor), so RenderFrame only ever runs one of
    // the two, never both.
    private readonly ProceduralIdleMotion? proceduralIdleMotion;

    // The model's .physics3.json simulation (hair/skirt sway), or null if it
    // ships none or it failed to load. Stateful, stepped once per frame.
    private readonly CubismPhysics? physics;

    private static string AvatarPngPath(string rootDirectory, string fileName) =>
        CubismModelLocator.PreferNativeAsset(
            Path.Combine(rootDirectory, "windows-native-launcher", "assets", "avatar", fileName),
            Path.Combine(rootDirectory, "windows-launcher", "assets", "avatar", fileName));

    public AvatarOverlayForm(string rootDirectory)
    {
        // #681: native's own copy first, Electron's as the fallback (see
        // CubismModelLocator.ModelDirectory).
        idlePath = AvatarPngPath(rootDirectory, "idle.png");
        talkingPath = AvatarPngPath(rootDirectory, "talking.png");

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        Width = ReadIntEnv("MANA_AVATAR_WIDTH", 234);
        Height = ReadIntEnv("MANA_AVATAR_HEIGHT", 288);
        StartPosition = FormStartPosition.Manual;

        var loaded = TryLoadCubismModel(rootDirectory);
        cubismModel = loaded.Model;
        cubismRenderer = loaded.Renderer;
        expressions = loaded.Expressions;
        idleMotion = loaded.IdleMotion;
        physics = loaded.Physics;
        ModelPath = loaded.ModelPath;
        ModelLoadProblem = loaded.Problem;
        ModelLoadWarnings = loaded.Warnings ?? Array.Empty<string>();
        if (idleMotion is null && cubismModel is not null)
        {
            proceduralIdleMotion = new ProceduralIdleMotion();
        }
        if (cubismModel is not null && cubismRenderer is not null)
        {
            // ~60fps: WM_TIMER fires on the ~15.6ms system tick, so 15
            // lands on every tick (16 would round up to every other one).
            renderTimer = new System.Windows.Forms.Timer { Interval = 15 };
            renderTimer.Tick += (_, _) => RenderFrame(cubismModel, cubismRenderer);
            renderTimer.Start();
        }

        SetState(AvatarState.Idle);
        PositionOverlay();
    }

    private sealed record CubismLoadResult(
        CubismModel? Model,
        CubismRenderer? Renderer,
        IReadOnlyDictionary<string, CubismExpressionFile> Expressions,
        CubismMotionFile? IdleMotion,
        CubismPhysics? Physics = null,
        string? ModelPath = null,
        string? Problem = null,
        IReadOnlyList<string>? Warnings = null);

    private static CubismLoadResult NotAvailable(string? modelPath = null, string? problem = null)
    {
        if (problem is not null)
        {
            Console.WriteLine($"AvatarOverlayForm: Live2D model not loaded, using static PNGs. {problem}");
        }
        return new(null, null, new Dictionary<string, CubismExpressionFile>(), null, null, modelPath, problem);
    }

    // Set when a Live2D model was found but couldn't be used (a plain-English
    // explanation for the user -- see CubismModelDiagnostics), and for parts
    // of a loaded model that were skipped. Both null/empty on success or when
    // there's simply no model installed (the static avatar is the default).
    public string? ModelLoadProblem { get; }
    public IReadOnlyList<string> ModelLoadWarnings { get; }
    public string? ModelPath { get; }

    // Never throws: no SDK, no model, or a model that fails to parse all
    // mean "fall back to the PNG swap", not "crash the launcher" -- but
    // each failure now carries a user-facing Problem instead of only a
    // Console line. Expression files (#514) and the Idle motion (#515) are
    // loaded best-effort -- one malformed accessory file is skipped (and
    // reported as a warning), not fatal to the model load it belongs to.
    private static CubismLoadResult TryLoadCubismModel(string rootDirectory)
    {
        var explicitPath = Environment.GetEnvironmentVariable(CubismModelLocator.EnvVar);
        var model3JsonPath = CubismModelLocator.Find(rootDirectory, explicitPath);
        if (model3JsonPath is null)
        {
            return NotAvailable(problem: CubismModelDiagnostics.DescribeNoModel(rootDirectory, explicitPath));
        }

        if (!CubismCoreLibrary.IsAvailable(rootDirectory))
        {
            return NotAvailable(model3JsonPath, CubismModelDiagnostics.EngineMissing(model3JsonPath));
        }

        CubismModel? model = null;
        var warnings = new List<string>();
        try
        {
            var settings = CubismModelSettings.Load(model3JsonPath);
            var missingFiles = CubismModelDiagnostics.DescribeMissingFiles(settings, model3JsonPath);
            if (missingFiles is not null)
            {
                return NotAvailable(model3JsonPath, missingFiles);
            }
            model = CubismModel.Load(settings);
            if (settings.PosePath is not null)
            {
                // Part opacities persist in the model like parameter values,
                // so the initial pose is set once here, not every frame.
                try
                {
                    CubismPoseFile.Load(settings.PosePath).ApplyInitialPose(model);
                }
                catch (Exception ex) when (ex is not (OutOfMemoryException or StackOverflowException))
                {
                    Console.WriteLine($"AvatarOverlayForm: failed to load pose ({settings.PosePath}), skipping it. {ex.Message}");
                    warnings.Add(CubismModelDiagnostics.SkippedPart("pose", Path.GetFileName(settings.PosePath), ex) +
                                 " (alternative parts like extra arm sets may all show at once)");
                }
            }
            var renderer = new CubismRenderer(settings.TexturePaths);

            var expressions = new Dictionary<string, CubismExpressionFile>();
            foreach (var (name, path) in settings.ExpressionPaths)
            {
                try
                {
                    expressions[name] = CubismExpressionFile.Load(path);
                }
                catch (Exception ex) when (ex is not (OutOfMemoryException or StackOverflowException))
                {
                    Console.WriteLine($"AvatarOverlayForm: failed to load expression '{name}' ({path}), skipping it. {ex.Message}");
                    warnings.Add(CubismModelDiagnostics.SkippedPart("expression", name, ex));
                }
            }

            CubismMotionFile? idleMotion = null;
            if (settings.IdleMotionPath is not null)
            {
                try
                {
                    idleMotion = CubismMotionFile.Load(settings.IdleMotionPath);
                }
                catch (Exception ex) when (ex is not (OutOfMemoryException or StackOverflowException))
                {
                    Console.WriteLine($"AvatarOverlayForm: failed to load idle motion ({settings.IdleMotionPath}), skipping it. {ex.Message}");
                    warnings.Add(CubismModelDiagnostics.SkippedPart("idle motion", Path.GetFileName(settings.IdleMotionPath), ex));
                }
            }

            CubismPhysics? physics = null;
            if (settings.PhysicsPath is not null)
            {
                try
                {
                    physics = CubismPhysics.Load(settings.PhysicsPath);
                }
                catch (Exception ex) when (ex is not (OutOfMemoryException or StackOverflowException))
                {
                    Console.WriteLine($"AvatarOverlayForm: failed to load physics ({settings.PhysicsPath}), skipping it. {ex.Message}");
                    warnings.Add(CubismModelDiagnostics.SkippedPart("physics", Path.GetFileName(settings.PhysicsPath), ex) +
                                 " (hair and clothing won't sway)");
                }
            }

            return new CubismLoadResult(model, renderer, expressions, idleMotion, physics, model3JsonPath, null, warnings);
        }
        // Broad by design, not just the handful of exception types this
        // path happens to throw today: "the model file exists but fails
        // to parse/load" must never crash the launcher, and enumerating
        // every possible failure (JsonException from a malformed
        // model3.json, KeyNotFoundException from a schema that doesn't
        // have the fields expected, DllNotFoundException/
        // BadImageFormatException from a corrupt or wrong-bitness Cubism
        // Core DLL, on top of the IOException/InvalidDataException/
        // UnauthorizedAccessException a narrower filter already caught)
        // is exactly the kind of list that's incomplete the moment a new
        // failure mode shows up. Genuinely unrecoverable conditions
        // (OutOfMemoryException, StackOverflowException) intentionally
        // still propagate.
        catch (Exception ex) when (ex is not (OutOfMemoryException or StackOverflowException))
        {
            // model may have loaded successfully before the renderer (a
            // separate step, e.g. a corrupt texture) threw -- without
            // this, its aligned native buffers would leak permanently.
            model?.Dispose();
            return NotAvailable(model3JsonPath, CubismModelDiagnostics.DescribeLoadFailure(ex, model3JsonPath));
        }
    }

    private void RenderFrame(CubismModel model, CubismRenderer renderer)
    {
        var nowMs = renderClock.ElapsedMilliseconds;
        var dtMs = lastRenderTickMs == 0 ? 33f : Math.Max(1, nowMs - lastRenderTickMs);
        lastRenderTickMs = nowMs;

        // Layering, base to override: #515's idle motion (or, when no
        // authored idle clip is configured, proceduralIdleMotion's
        // randomized-parameter fallback -- see that class's own header
        // comment) sets the resting-pose sway first, so she isn't frozen
        // between sentences either way; #514's expression applies on top
        // of that, since a deliberate mood read should win over generic
        // idle animation where they'd otherwise conflict on the same
        // parameter; lip-sync's explicit mouth writes below always win
        // last, for ParamMouthOpenY/ParamMouthForm specifically -- most
        // motions/expressions target eyebrows/eyes/head-angle rather than
        // mouth-open, but if either touched it, Mana's mouth should still
        // track what she's actually saying while she's speaking.
        if (idleMotion is not null)
        {
            idleMotion.ApplyTo(model, (float)renderClock.Elapsed.TotalSeconds);
        }
        else
        {
            proceduralIdleMotion?.ApplyTo(model, (float)renderClock.Elapsed.TotalSeconds);
        }
        activeExpression?.ApplyTo(model);

        var (targetMouthOpen, targetMouthForm) = LipSyncDriver.Current;
        smoothedMouthOpen = LipSyncAnalyzer.SmoothMouthValue(smoothedMouthOpen, targetMouthOpen, dtMs);
        // Same attack/decay smoothing as mouth openness -- mouth *shape*
        // snapping around per-frame would look like flickering between
        // vowel shapes rather than natural articulation.
        smoothedMouthForm = LipSyncAnalyzer.SmoothMouthValue(smoothedMouthForm, targetMouthForm, dtMs);

        if (model.HasParameter("ParamMouthOpenY"))
        {
            model.SetParameterValue("ParamMouthOpenY", smoothedMouthOpen);
        }
        if (model.HasParameter("ParamMouthForm"))
        {
            model.SetParameterValue("ParamMouthForm", smoothedMouthForm);
        }

        // Physics reads the head/body angles everything above just set, so
        // it runs last -- its outputs (hair, skirt) aren't driven by anything
        // else.
        physics?.Evaluate(model, dtMs / 1000f);

        model.Update();

        using var frame = renderer.Render(model, Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height), SKColors.Transparent);
        Present(frame);
    }

    public void SetState(AvatarState state)
    {
        // Callers include background threads (VoiceLoop's thread-pool
        // continuations and NAudio's playback thread) -- marshal onto the
        // UI thread before touching any WinForms control. Skip the check
        // before the handle exists (the constructor calls this on the UI
        // thread, and InvokeRequired is unreliable pre-handle-creation).
        if (IsHandleCreated && InvokeRequired)
        {
            BeginInvoke(() => SetState(state));
            return;
        }

        if (state == AvatarState.Idle)
        {
            // Mana's not speaking anymore -- close the mouth immediately
            // rather than waiting for the render loop's own decay to
            // catch up, and drop any samples left over from the clip that
            // just ended so they can't bleed into the next one.
            LipSyncDriver.Reset();
        }

        if (state != CurrentState)
        {
            CurrentState = state;
            StateChanged?.Invoke(state);
        }

        // #479 sub-project 4: when a real Cubism model is loaded, the
        // render timer (RenderFrame) is what actually draws every frame
        // going forward -- this method's PNG-swap below is the fallback
        // for when it isn't.
        if (cubismModel is not null)
        {
            // #514: picks which of the model's own expressions (if any)
            // matches this mood state and stores it for RenderFrame to
            // apply every tick from here on -- null (no match, or the
            // model ships none) means "no expression change", which
            // reads as simply not overriding whatever the render loop's
            // other signals (idle motion, lip-sync, physics) already
            // produce.
            var expressionName = AvatarExpressionSelector.SelectExpressionName(state, expressions.Keys);
            activeExpression = expressionName is not null && expressions.TryGetValue(expressionName, out var expression)
                ? expression
                : null;
            return;
        }

        var nextPath = state == AvatarState.Idle ? idlePath : talkingPath;
        if (!File.Exists(nextPath))
        {
            return;
        }

        using var image = SKImage.FromEncodedData(nextPath);
        if (image is null)
        {
            return;
        }
        // Fit (like the old PictureBox's Zoom), centered.
        var width = Math.Max(1, ClientSize.Width);
        var height = Math.Max(1, ClientSize.Height);
        var scale = Math.Min((float)width / image.Width, (float)height / image.Height);
        var drawWidth = image.Width * scale;
        var drawHeight = image.Height * scale;
        using var frame = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(frame))
        {
            canvas.Clear(SKColors.Transparent);
            canvas.DrawImage(image, SKRect.Create((width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight),
                new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear));
        }
        Present(frame);
    }

    // The layered window's backing store: a top-down 32bpp DIB selected into
    // a memory DC, reused across frames and rebuilt only when the size
    // changes.
    private nint memoryDc;
    private nint dibBitmap;
    private nint previousBitmap;
    private nint dibBits;
    private Size dibSize;

    private void Present(SKBitmap frame)
    {
        var size = new Size(frame.Width, frame.Height);
        if (size != dibSize)
        {
            ReleaseDib();
            var header = new BitmapInfoHeader
            {
                Size = Marshal.SizeOf<BitmapInfoHeader>(),
                Width = size.Width,
                Height = -size.Height, // negative = top-down rows, matching Skia's
                Planes = 1,
                BitCount = 32,
            };
            memoryDc = CreateCompatibleDC(0);
            dibBitmap = CreateDIBSection(memoryDc, ref header, 0, out dibBits, 0, 0);
            if (dibBitmap == 0)
            {
                ReleaseDib();
                return;
            }
            previousBitmap = SelectObject(memoryDc, dibBitmap);
            dibSize = size;
        }

        using (var pixmap = frame.PeekPixels())
        {
            pixmap.ReadPixels(new SKImageInfo(size.Width, size.Height, SKColorType.Bgra8888, SKAlphaType.Premul), dibBits, size.Width * 4);
        }

        const byte acSrcOver = 0;
        const byte acSrcAlpha = 1;
        const int ulwAlpha = 2;
        var source = Point.Empty;
        var blend = new BlendFunction { BlendOp = acSrcOver, SourceConstantAlpha = 255, AlphaFormat = acSrcAlpha };
        // Null destination point: keep the window where PositionOverlay put it.
        UpdateLayeredWindow(Handle, 0, 0, ref size, memoryDc, ref source, 0, ref blend, ulwAlpha);
    }

    private void ReleaseDib()
    {
        if (memoryDc != 0)
        {
            if (previousBitmap != 0)
            {
                SelectObject(memoryDc, previousBitmap);
            }
            DeleteDC(memoryDc);
        }
        if (dibBitmap != 0)
        {
            DeleteObject(dibBitmap);
        }
        memoryDc = dibBitmap = previousBitmap = dibBits = 0;
        dibSize = Size.Empty;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public int Size;
        public int Width;
        public int Height;
        public short Planes;
        public short BitCount;
        public int Compression;
        public int SizeImage;
        public int XPelsPerMeter;
        public int YPelsPerMeter;
        public int ClrUsed;
        public int ClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BlendFunction
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(nint hwnd, nint hdcDst, nint pptDst, ref Size psize, nint hdcSrc, ref Point pptSrc, int crKey, ref BlendFunction pblend, int dwFlags);

    [DllImport("gdi32.dll")]
    private static extern nint CreateCompatibleDC(nint hdc);

    [DllImport("gdi32.dll")]
    private static extern nint CreateDIBSection(nint hdc, ref BitmapInfoHeader pbmi, uint usage, out nint ppvBits, nint hSection, uint offset);

    [DllImport("gdi32.dll")]
    private static extern nint SelectObject(nint hdc, nint h);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(nint ho);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(nint hdc);

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExTransparent = 0x20;
            const int wsExToolWindow = 0x80;
            const int wsExLayered = 0x80000;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExTransparent | wsExToolWindow | wsExLayered | wsExNoActivate;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        renderTimer?.Stop();
        renderTimer?.Dispose();
        cubismRenderer?.Dispose();
        cubismModel?.Dispose();
        ReleaseDib();
        base.OnFormClosed(e);
    }

    private void PositionOverlay()
    {
        var workArea = Screen.PrimaryScreen?.WorkingArea ?? Screen.FromControl(this).WorkingArea;
        var left = ReadIntEnv("MANA_AVATAR_LEFT", 782);
        var bottom = ReadIntEnv("MANA_AVATAR_BOTTOM", 0);
        Left = workArea.Left + left;
        Top = workArea.Bottom - Height - bottom;
    }

    private static int ReadIntEnv(string name, int fallback)
    {
        return int.TryParse(Environment.GetEnvironmentVariable(name), out var value)
            ? value
            : fallback;
    }
}
