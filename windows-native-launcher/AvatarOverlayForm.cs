using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
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
internal sealed class AvatarOverlayForm : Form
{
    private readonly PictureBox avatarImage = new();
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

    // Same idle/talking picture this form's own PNG-swap fallback path
    // already loads (see SetState below) -- exposed so SessionListForm's
    // sidebar thumbnail can show the same real art instead of duplicating
    // this idlePath/talkingPath selection logic.
    public string GetStaticImagePath(AvatarState state) => state == AvatarState.Idle ? idlePath : talkingPath;

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

    public AvatarOverlayForm(string rootDirectory)
    {
        idlePath = Path.Combine(rootDirectory, "windows-launcher", "assets", "avatar", "idle.png");
        talkingPath = Path.Combine(rootDirectory, "windows-launcher", "assets", "avatar", "talking.png");

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        Width = ReadIntEnv("MANA_AVATAR_WIDTH", 234);
        Height = ReadIntEnv("MANA_AVATAR_HEIGHT", 288);
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        StartPosition = FormStartPosition.Manual;

        avatarImage.Dock = DockStyle.Fill;
        avatarImage.SizeMode = PictureBoxSizeMode.Zoom;
        avatarImage.BackColor = Color.Transparent;
        Controls.Add(avatarImage);

        var loaded = TryLoadCubismModel(rootDirectory);
        cubismModel = loaded.Model;
        cubismRenderer = loaded.Renderer;
        expressions = loaded.Expressions;
        idleMotion = loaded.IdleMotion;
        if (cubismModel is not null && cubismRenderer is not null)
        {
            renderTimer = new System.Windows.Forms.Timer { Interval = 33 }; // ~30fps
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
        CubismMotionFile? IdleMotion);

    private static readonly CubismLoadResult NotAvailable = new(null, null, new Dictionary<string, CubismExpressionFile>(), null);

    // Returns NotAvailable -- not a throw -- when the SDK/model aren't
    // available, or if a real model file exists but fails to parse: any
    // of those mean "fall back to the PNG swap", not "crash the
    // launcher". Expression files (#514) and the Idle motion (#515) are
    // both loaded best-effort too -- one malformed accessory file is
    // skipped (logged), not fatal to the model load it belongs to.
    private static CubismLoadResult TryLoadCubismModel(string rootDirectory)
    {
        if (!CubismCoreLibrary.IsAvailable(rootDirectory))
        {
            return NotAvailable;
        }

        var model3JsonPath = Path.Combine(
            rootDirectory, "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
        if (!File.Exists(model3JsonPath))
        {
            return NotAvailable;
        }

        CubismModel? model = null;
        try
        {
            var settings = CubismModelSettings.Load(model3JsonPath);
            model = CubismModel.Load(settings);
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
                }
            }

            return new CubismLoadResult(model, renderer, expressions, idleMotion);
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
            Console.WriteLine($"AvatarOverlayForm: failed to load Cubism model, falling back to static PNGs. {ex.Message}");
            // model may have loaded successfully before the renderer (a
            // separate step, e.g. a corrupt texture) threw -- without
            // this, its aligned native buffers would leak permanently.
            model?.Dispose();
            return NotAvailable;
        }
    }

    private void RenderFrame(CubismModel model, CubismRenderer renderer)
    {
        var nowMs = renderClock.ElapsedMilliseconds;
        var dtMs = lastRenderTickMs == 0 ? 33f : Math.Max(1, nowMs - lastRenderTickMs);
        lastRenderTickMs = nowMs;

        // Layering, base to override: #515's idle motion sets the
        // resting-pose sway first (so she isn't frozen between
        // sentences); #514's expression applies on top of that, since a
        // deliberate mood read should win over generic idle animation
        // where they'd otherwise conflict on the same parameter; lip-sync's
        // explicit mouth writes below always win last, for
        // ParamMouthOpenY/ParamMouthForm specifically -- most
        // motions/expressions target eyebrows/eyes/head-angle rather than
        // mouth-open, but if either touched it, Mana's mouth should still
        // track what she's actually saying while she's speaking.
        idleMotion?.ApplyTo(model, (float)renderClock.Elapsed.TotalSeconds);
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

        model.Update();

        var width = Math.Max(1, avatarImage.Width);
        var height = Math.Max(1, avatarImage.Height);
        using var skBitmap = renderer.Render(model, width, height, new SKColor(255, 0, 255));
        var bitmap = ToGdiBitmap(skBitmap);

        avatarImage.Image?.Dispose();
        avatarImage.Image = bitmap;
    }

    // SkiaSharp and WinForms don't share a bitmap type -- round-trips
    // through PNG encoding, which at this size (a small avatar, ~30fps)
    // is not a measurable cost, and avoids hand-rolling a pixel-format-
    // matching raw copy between SKBitmap's and System.Drawing.Bitmap's
    // independently-defined memory layouts.
    private static Bitmap ToGdiBitmap(SKBitmap skBitmap)
    {
        using var image = SKImage.FromBitmap(skBitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        using var stream = new MemoryStream(data.ToArray());
        using var lazyBitmap = new Bitmap(stream);
        // new Bitmap(Stream)/Image.FromStream can defer decoding and
        // requires its backing stream to stay open for the image's whole
        // lifetime (a documented GDI+ gotcha) -- cloning into a real,
        // independent Bitmap via the copy constructor here lets `stream`
        // be safely disposed on return instead of needing to outlive
        // every rendered frame indefinitely.
        return new Bitmap(lazyBitmap);
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
            // other signals (lip-sync, and later motion/physics --
            // #515) already produce.
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

        avatarImage.Image?.Dispose();
        avatarImage.Image = Image.FromFile(nextPath);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExTransparent = 0x20;
            const int wsExToolWindow = 0x80;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExTransparent | wsExToolWindow | wsExNoActivate;
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
