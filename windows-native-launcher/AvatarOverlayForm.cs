using System;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
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
    // #661: what she's doing rather than how she feels -- see
    // AvatarStateArbiter for which one shows when several apply.
    Thinking,
    Working,
    Waiting,
    Done,
    Dreaming,
    // The mic is on (waiting for her name, or awake after it): a patient,
    // looping listening pose over her idle.
    Listening,
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
    private readonly string rootDirectory;
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
    // than guessing at state from the outside. #661: the state actually
    // shown (arbiter's pick of speech vs activities). Only ever written on
    // the UI thread (SetState/SetActivity/PulseDone marshal there first, and
    // stateTimer ticks there), so no lock is needed.
    public AvatarState CurrentState { get; private set; } = AvatarState.Idle;
    public event Action<AvatarState>? StateChanged;

    // #661: speech (SetState) + activities (SetActivity/PulseDone) -> the
    // shown state; stateTimer re-resolves it so held states and the Done
    // beat expire even when no new event arrives.
    private readonly AvatarStateArbiter arbiter = new();
    private readonly System.Windows.Forms.Timer stateTimer = new() { Interval = 100 };
    private string? speechExpression;
    private string? speechEmotion; // #623: the sentence's emotion tag
    private double doneStartedAt = double.NegativeInfinity;
    private double attentiveStartedAt = double.NegativeInfinity; // Q34: when she was last clicked
    private float sleepiness;
    private float listening; // eased 0..1 blend of the Listening pose
    // Q6: the "^^" closed-eye smile -- until when, and how far in (eased).
    private double closedSmileUntil = double.NegativeInfinity;
    private float closedSmile;
    private readonly Random smileRandom = new();

    // #914: this and every other field ApplyModel sets change when LoadModel
    // swaps in another character's model.
    private CubismModel? cubismModel;
    private CubismRenderer? cubismRenderer;
    private System.Windows.Forms.Timer? renderTimer;
    private readonly int fpsCap = ReadIntEnv("MANA_AVATAR_FPS", 0); // #683, Electron's knob
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
    private IReadOnlyDictionary<string, CubismExpressionFile> expressions;
    private CubismExpressionFile? activeExpression;

    // #515/#683: plays the model's own motion groups as the base animation
    // layer -- its Idle group at rest, each mood's own group when it has
    // one, plus mana-avatar.json's random ambient motions (see
    // AvatarMotionPlayer). Null without a Live2D model. Only touched on the
    // UI thread (SetState marshals there first; RenderFrame is a UI-thread
    // timer tick).
    private AvatarMotionPlayer? motionPlayer;

    // #342 follow-up: base layer underneath motionPlayer when the model has
    // no Idle group (none declared, all failed to load, or no stateMotions
    // idle mapping) -- without this, the avatar previously had zero idle
    // movement in that case. Mood clips, when the model has any, still
    // play (and crossfade) over it.
    private ProceduralIdleMotion? proceduralIdleMotion;

    // #683: mana-avatar.json / MANA_LIVE2D_* tuning (AvatarConfig).
    private string mouthParam = "ParamMouthOpenY";
    private IReadOnlyDictionary<string, IReadOnlyList<string>> expressionOverrides = new Dictionary<string, IReadOnlyList<string>>();

    // The model's .physics3.json simulation (hair/skirt sway), or null if it
    // ships none or it failed to load. Stateful, stepped once per frame.
    private CubismPhysics? physics;

    // #683: auto-blink and gaze/idle head tilt, layered on top of the idle
    // motion and expression every frame (see RenderFrame). lifeParameters
    // holds every parameter they touch that this model actually has, with
    // its default and range: they're reset to default at the start of each
    // frame so an offset/multiplier never compounds on last frame's value
    // when no motion rewrites that parameter.
    private static readonly string[] GazeIds = ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamEyeBallX", "ParamEyeBallY",
        "ParamBodyAngleX", "ParamBodyAngleZ", "ParamEyeLSmile", "ParamEyeRSmile"];
    private readonly EyeBlink eyeBlink = new();
    private AvatarGaze gaze;
    private string[] eyeBlinkIds = [];
    private readonly Dictionary<string, (float Default, float Min, float Max)> lifeParameters = [];

    private static string AvatarPngPath(string rootDirectory, string fileName) =>
        CubismModelLocator.PreferNativeAsset(
            Path.Combine(rootDirectory, "windows-native-launcher", "assets", "avatar", fileName),
            Path.Combine(rootDirectory, "windows-launcher", "assets", "avatar", fileName));

    // #914 group mode: partner is the second character's overlay, placed
    // beside Mana's by its owner (BesideLocation); it never reads or saves
    // the overlay's position.
    private readonly bool partner;

    public AvatarOverlayForm(string rootDirectory, bool partner = false)
    {
        this.partner = partner;
        // #681: native's own copy first, Electron's as the fallback (see
        // CubismModelLocator.ModelDirectory).
        idlePath = AvatarPngPath(rootDirectory, "idle.png");
        talkingPath = AvatarPngPath(rootDirectory, "talking.png");

        var settings = ManaSettingsStore.Load();
        clickThrough = settings.AvatarClickThrough;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        baseSize = new Size(ReadIntEnv("MANA_AVATAR_WIDTH", 234), ReadIntEnv("MANA_AVATAR_HEIGHT", 288));
        StartPosition = FormStartPosition.Manual;

        this.rootDirectory = rootDirectory;
        ApplyModel(TryLoadCubismModel(rootDirectory, Environment.GetEnvironmentVariable(CubismModelLocator.EnvVar)));
        // Only animate while she's actually on screen (here or, #685, in
        // the chat window) -- the launcher shows the overlay after the
        // startup screen closes, so there's no rendering in the
        // background during startup (or while hidden).
        VisibleChanged += (_, _) => UpdateRenderTimer();
        Size = Frame(settings.OverlayFraming, settings.OverlayScale);

        SetState(AvatarState.Idle);
        stateTimer.Tick += (_, _) =>
        {
            arbiter.Set(AvatarState.Listening, IsListening?.Invoke() == true);
            ShowResolvedState(reapply: false);
        };
        stateTimer.Start();
        if (partner)
        {
            return; // placed by its owner
        }
        // #899: a spot saved before framing existed was for the 1x full-body
        // window; move it once to where that window's bottom centre stood,
        // so she stays flush on the bottom edge if she was.
        if (settings.OverlayFraming is null && settings.AvatarLeft is int oldLeft && settings.AvatarTop is int oldTop)
        {
            var moved = Resized(new Rectangle(oldLeft, oldTop, baseSize.Width, baseSize.Height), Size);
            settings.AvatarLeft = moved.Left;
            settings.AvatarTop = moved.Top;
            settings.OverlayFraming = OverlayFraming;
            settings.OverlayScale = OverlayScale;
            try
            {
                settings.Save();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.WriteLine($"AvatarOverlayForm: couldn't save the moved overlay position. {ex.Message}");
            }
        }
        PositionOverlay(settings);
    }

    // #914: everything that comes from the model, at start-up and again when
    // LoadModel swaps in another character's.
    [MemberNotNull(nameof(expressions), nameof(gaze), nameof(ModelLoadWarnings))]
    private void ApplyModel(CubismLoadResult loaded)
    {
        cubismModel = loaded.Model;
        cubismRenderer = loaded.Renderer;
        expressions = loaded.Expressions;
        physics = loaded.Physics;
        ModelPath = loaded.ModelPath;
        ModelLoadProblem = loaded.Problem;
        ModelLoadWarnings = loaded.Warnings ?? Array.Empty<string>();
        var config = loaded.Config ?? AvatarConfig.Parse(null, _ => null);
        motionPlayer = null;
        proceduralIdleMotion = null;
        activeExpression = null;
        eyeBlinkIds = [];
        lifeParameters.Clear();
        renderTimer = null;
        gaze = new AvatarGaze(config.IdleGazeDeg, config.IdleGazePeriodMs, config.IdleTiltDeg, config.IdleMaxPitchDeg, config.AnimatedTiltDeg);
        if (cubismModel is not null)
        {
            motionPlayer = new AvatarMotionPlayer(loaded.MotionGroups, config.StateMotions, config.RandomMotions);
            if (motionPlayer.IdleGroup is null)
            {
                proceduralIdleMotion = new ProceduralIdleMotion();
            }
            mouthParam = config.MouthParam;
            expressionOverrides = config.StateExpressions;
            LipSyncDriver.MouthGain = config.MouthGain;
            LipSyncDriver.MouthMaxOpen = config.MouthMaxOpen;

            // #683: the model's own EyeBlink group, else the configured
            // backfill (the standard ids by default, like Electron's
            // augmentModelSettings); ids the model doesn't have are
            // dropped, so a model with no eye parameters just doesn't blink.
            var blinkIds = loaded.EyeBlinkIds is { Count: > 0 } declared ? declared : config.EyeBlinkParams;
            eyeBlinkIds = blinkIds.Where(cubismModel.HasParameter).Distinct().ToArray();
            foreach (var id in eyeBlinkIds.Concat(GazeIds).Where(cubismModel.HasParameter))
            {
                lifeParameters[id] = (cubismModel.GetParameterDefaultValue(id), cubismModel.GetParameterMinValue(id), cubismModel.GetParameterMaxValue(id));
            }
        }
        if (cubismModel is not null && cubismRenderer is not null)
        {
            // RenderFrame re-paces it every tick (RenderIntervalMs).
            var (model, renderer) = (cubismModel, cubismRenderer);
            renderTimer = new System.Windows.Forms.Timer { Interval = RenderIntervalMs(gameRunning, speaking: false, fpsCap) };
            renderTimer.Tick += (_, _) => RenderFrame(model, renderer);
        }

        // #899: the framed window is sized from the model's canvas; the
        // static PNGs are drawn to fill the base window.
        canvasSize = baseSize;
        if (cubismModel is not null)
        {
            cubismModel.ReadCanvasInfo(out var canvas, out _, out _);
            canvasSize = new SizeF(canvas.X, canvas.Y);
        }
    }

    // #914: the active character's model (null or empty: the default one),
    // swapped in place. A path that doesn't load leaves the static avatar,
    // like a failed start-up load. UI thread only.
    public void LoadModel(string? model3JsonPath)
    {
        var explicitPath = string.IsNullOrWhiteSpace(model3JsonPath)
            ? Environment.GetEnvironmentVariable(CubismModelLocator.EnvVar)
            : model3JsonPath;
        if (CubismModelLocator.Find(rootDirectory, explicitPath) == ModelPath)
        {
            return; // e.g. Evil Mana still wearing Mana's model
        }
        var loaded = TryLoadCubismModel(rootDirectory, explicitPath);
        renderTimer?.Dispose();
        cubismRenderer?.Dispose();
        cubismModel?.Dispose();
        mirror?.ClearFrame();
        ApplyModel(loaded);
        UpdateRenderTimer();
        SetFraming(OverlayFraming, OverlayScale); // her canvas may differ
        ShowResolvedState(reapply: true); // the new model's expression and motion
    }

    // #684: back on screen when a monitor is unplugged or its resolution or
    // scaling changes. Raised off the UI thread; hooked while the window
    // handle exists (see OnHandleCreated), since the event is static.

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        if (!IsHandleCreated || IsDisposed)
        {
            return;
        }
        try
        {
            BeginInvoke(KeepOnScreen);
        }
        catch (InvalidOperationException)
        {
            // the window closed meanwhile
        }
    }

    private void KeepOnScreen()
    {
        if (partner)
        {
            Location = KeepInside(Bounds, Screen.FromRectangle(Bounds).WorkingArea);
            return;
        }
        PositionOverlay(ManaSettingsStore.Load());
    }

    // #684: `bounds` moved the least needed to lie fully inside `area`
    // (its top-left corner kept on screen if it's bigger than the area).
    internal static Point KeepInside(Rectangle bounds, Rectangle area) => new(
        Math.Max(area.Left, Math.Min(bounds.Left, area.Right - bounds.Width)),
        Math.Max(area.Top, Math.Min(bounds.Top, area.Bottom - bounds.Height)));

    // #684: TopMost alone loses to a borderless-fullscreen game or video
    // that comes to the front (it can be topmost too), so each time the
    // foreground window changes she's put back on top -- without taking
    // focus. Electron's "screen-saver" level does the same job. Exclusive
    // fullscreen still wins; that's out of scope.
    private nint foregroundHook;
    private WinEventProc? foregroundHookProc; // kept alive while hooked

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (foregroundHook != 0)
        {
            UnhookWinEvent(foregroundHook); // the handle was recreated
        }
        foregroundHookProc = (_, _, _, _, _, _, _) =>
        {
            if (Visible)
            {
                SetWindowPos(Handle, HwndTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
            }
        };
        foregroundHook = SetWinEventHook(EventSystemForeground, EventSystemForeground, 0, foregroundHookProc, 0, 0, WinEventOutOfContext);
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        if (foregroundHook != 0)
        {
            UnhookWinEvent(foregroundHook);
            foregroundHook = 0;
        }
        base.OnHandleDestroyed(e);
    }

    private delegate void WinEventProc(nint hook, uint eventType, nint hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll")]
    private static extern nint SetWinEventHook(uint eventMin, uint eventMax, nint module, WinEventProc proc, uint processId, uint threadId, uint flags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(nint hook);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(nint hwnd, nint insertAfter, int x, int y, int cx, int cy, uint flags);

    private const uint EventSystemForeground = 0x0003;
    private const uint WinEventOutOfContext = 0;
    private static readonly nint HwndTopmost = -1;
    private const uint SwpNoSize = 0x1;
    private const uint SwpNoMove = 0x2;
    private const uint SwpNoActivate = 0x10;

    private sealed record CubismLoadResult(
        CubismModel? Model,
        CubismRenderer? Renderer,
        IReadOnlyDictionary<string, CubismExpressionFile> Expressions,
        IReadOnlyDictionary<string, IReadOnlyList<CubismMotionFile>> MotionGroups,
        AvatarConfig? Config = null,
        CubismPhysics? Physics = null,
        IReadOnlyList<string>? EyeBlinkIds = null,
        string? ModelPath = null,
        string? Problem = null,
        IReadOnlyList<string>? Warnings = null);

    private static CubismLoadResult NotAvailable(string? modelPath = null, string? problem = null)
    {
        if (problem is not null)
        {
            Console.WriteLine($"AvatarOverlayForm: Live2D model not loaded, using static PNGs. {problem}");
        }
        return new(null, null, new Dictionary<string, CubismExpressionFile>(), new Dictionary<string, IReadOnlyList<CubismMotionFile>>(), null, null, null, modelPath, problem);
    }

    // Set when a Live2D model was found but couldn't be used (a plain-English
    // explanation for the user -- see CubismModelDiagnostics), and for parts
    // of a loaded model that were skipped. Both null/empty on success or when
    // there's simply no model installed (the static avatar is the default).
    public string? ModelLoadProblem { get; private set; }
    public IReadOnlyList<string> ModelLoadWarnings { get; private set; }
    public string? ModelPath { get; private set; }

    // Never throws: no SDK, no model, or a model that fails to parse all
    // mean "fall back to the PNG swap", not "crash the launcher" -- but
    // each failure now carries a user-facing Problem instead of only a
    // Console line. Expression files (#514) and the Idle motion (#515) are
    // loaded best-effort -- one malformed accessory file is skipped (and
    // reported as a warning), not fatal to the model load it belongs to.
    private static CubismLoadResult TryLoadCubismModel(string rootDirectory, string? explicitPath)
    {
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

            // #515/#683: every motion in every group, best-effort -- a
            // broken clip is skipped (and reported), an emptied group dropped.
            var motionGroups = new Dictionary<string, IReadOnlyList<CubismMotionFile>>();
            foreach (var (group, paths) in settings.MotionGroups)
            {
                var clips = new List<CubismMotionFile>();
                foreach (var path in paths)
                {
                    try
                    {
                        clips.Add(CubismMotionFile.Load(path));
                    }
                    catch (Exception ex) when (ex is not (OutOfMemoryException or StackOverflowException))
                    {
                        Console.WriteLine($"AvatarOverlayForm: failed to load motion '{group}' ({path}), skipping it. {ex.Message}");
                        warnings.Add(CubismModelDiagnostics.SkippedPart("motion", $"{group}/{Path.GetFileName(path)}", ex));
                    }
                }
                if (clips.Count > 0)
                {
                    motionGroups[group] = clips;
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

            var config = AvatarConfig.Load(model3JsonPath, CubismModelLocator.ModelDirectory(rootDirectory), Environment.GetEnvironmentVariable);
            return new CubismLoadResult(model, renderer, expressions, motionGroups, config, physics, settings.EyeBlinkParameterIds, model3JsonPath, null, warnings);
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

        // Layering, base to override: #515/#683's motion player (the idle
        // group, or the current mood's group, crossfading between clips --
        // over proceduralIdleMotion's randomized-parameter fallback when
        // the model has no idle group) sets the pose first, so she isn't
        // frozen between sentences either way; #514's expression applies on top
        // of that, since a deliberate mood read should win over generic
        // idle animation where they'd otherwise conflict on the same
        // parameter; lip-sync's explicit mouth writes below always win
        // last, for ParamMouthOpenY/ParamMouthForm specifically -- most
        // motions/expressions target eyebrows/eyes/head-angle rather than
        // mouth-open, but if either touched it, Mana's mouth should still
        // track what she's actually saying while she's speaking.
        // #683's gaze/idle tilt and blink sit between expression and
        // lip-sync: the gaze adds on top of (and the tilt eases) the head
        // angles the motion/expression set, and the blink multiplies the
        // eye-open value they set, so a motion's baked blink or an
        // expression's narrowed eyes survive instead of being overwritten.
        foreach (var (id, (defaultValue, _, _)) in lifeParameters)
        {
            model.SetParameterValue(id, defaultValue);
        }
        var nowSeconds = renderClock.Elapsed.TotalSeconds;
        proceduralIdleMotion?.ApplyTo(model, (float)nowSeconds);
        if (motionPlayer is not null)
        {
            motionPlayer.Update(nowSeconds);
            motionPlayer.Apply(model, nowSeconds);
        }
        activeExpression?.ApplyTo(model);

        // #661: where she looks and how often she blinks follow what she's
        // doing; Dreaming slowly closes her eyes, Done nods once.
        var shown = CurrentState;
        var speaking = AvatarStateArbiter.IsSpeech(shown);
        var interval = RenderIntervalMs(gameRunning, speaking, fpsCap);
        if (renderTimer is { } timer && timer.Interval != interval)
        {
            timer.Interval = interval;
        }
        // Q34: a click gets a quick attentive look -- eyes straight to you
        // (switching to Attentive re-picks the gaze at once) and a head tilt.
        var sinceClick = nowSeconds - attentiveStartedAt;
        var gazeMode = shown switch
        {
            AvatarState.Thinking => GazeMode.Thinking,
            AvatarState.Working => GazeMode.Working,
            AvatarState.Waiting => GazeMode.Attentive,
            _ when sinceClick < AvatarGaze.AttentiveSeconds => GazeMode.Attentive,
            _ => speaking ? GazeMode.Talking : GazeMode.Idle,
        };
        if (gaze.Update(dtMs, gazeMode, animated: speaking && shown == AvatarState.Excited))
        {
            eyeBlink.Trigger(nowSeconds); // big glance -> blink with it
        }
        if (gaze.TiltActive && gaze.TiltBlend > 0.001f)
        {
            SetLifeParameter(model, "ParamAngleY", gaze.ApplyPitch(model.GetParameterCurrentValue("ParamAngleY")));
        }
        // Q6: the head roll's sway, with the body leaning after it.
        SetLifeParameter(model, "ParamAngleZ", model.GetParameterCurrentValue("ParamAngleZ") + gaze.Sway);
        SetLifeParameter(model, "ParamBodyAngleZ", model.GetParameterCurrentValue("ParamBodyAngleZ") + (AvatarGaze.BodyFollow * gaze.Sway));
        var (lookPitch, lookRoll) = AvatarGaze.AttentiveLookOffset(sinceClick);
        if (lookRoll != 0f)
        {
            SetLifeParameter(model, "ParamAngleY", model.GetParameterCurrentValue("ParamAngleY") + lookPitch);
            SetLifeParameter(model, "ParamAngleZ", model.GetParameterCurrentValue("ParamAngleZ") + lookRoll);
        }
        if (shown == AvatarState.Done)
        {
            SetLifeParameter(model, "ParamAngleY", model.GetParameterCurrentValue("ParamAngleY") + AvatarGaze.NodOffset(nowSeconds - doneStartedAt));
        }
        // Listening: a soft head tilt, a slow small nod and gently smiling
        // eyes, eased in and out over ~0.6s so it never snaps.
        listening += ((shown == AvatarState.Listening ? 1f : 0f) - listening) * Math.Min(1f, dtMs / 600f);
        if (listening > 0.001f)
        {
            var (pitch, roll, eyeSmile) = AvatarGaze.ListeningPose(nowSeconds);
            SetLifeParameter(model, "ParamAngleY", model.GetParameterCurrentValue("ParamAngleY") + (listening * pitch));
            SetLifeParameter(model, "ParamAngleZ", model.GetParameterCurrentValue("ParamAngleZ") + (listening * roll));
            SetLifeParameter(model, "ParamEyeLSmile", model.GetParameterCurrentValue("ParamEyeLSmile") + (listening * eyeSmile));
            SetLifeParameter(model, "ParamEyeRSmile", model.GetParameterCurrentValue("ParamEyeRSmile") + (listening * eyeSmile));
        }
        if (gaze.GazeActive)
        {
            SetLifeParameter(model, "ParamAngleX", model.GetParameterCurrentValue("ParamAngleX") + gaze.HeadAngleX);
            SetLifeParameter(model, "ParamBodyAngleX", model.GetParameterCurrentValue("ParamBodyAngleX") + (AvatarGaze.BodyFollow * gaze.HeadAngleX));
            SetLifeParameter(model, "ParamEyeBallX", model.GetParameterCurrentValue("ParamEyeBallX") + gaze.EyeBallX);
            SetLifeParameter(model, "ParamEyeBallY", model.GetParameterCurrentValue("ParamEyeBallY") + gaze.EyeBallY);
        }
        var blinkRate = shown is AvatarState.Thinking or AvatarState.Working ? EyeBlink.ThinkingRate
            : speaking ? EyeBlink.TalkingRate
            : 1f;
        sleepiness += ((shown == AvatarState.Dreaming ? 1f : 0f) - sleepiness) * Math.Min(1f, dtMs / 1500f);
        // Q6: sleepy blinks are slower; the "^^" smile closes the eyes and
        // raises the eye-smile parameters, easing in and out over ~80ms.
        closedSmile += ((nowSeconds < closedSmileUntil ? 1f : 0f) - closedSmile) * Math.Min(1f, dtMs / 80f);
        var openness = eyeBlink.Openness(nowSeconds, blinkRate, sleepy: sleepiness > 0.5f) * (1f - (0.85f * sleepiness)) * (1f - closedSmile);
        foreach (var id in eyeBlinkIds)
        {
            SetLifeParameter(model, id, model.GetParameterCurrentValue(id) * openness);
        }
        if (closedSmile > 0.001f)
        {
            SetLifeParameter(model, "ParamEyeLSmile", model.GetParameterCurrentValue("ParamEyeLSmile") + closedSmile);
            SetLifeParameter(model, "ParamEyeRSmile", model.GetParameterCurrentValue("ParamEyeRSmile") + closedSmile);
        }

        var (targetMouthOpen, targetMouthForm) = LipSyncDriver.Current;
        smoothedMouthOpen = LipSyncAnalyzer.SmoothMouthOpen(smoothedMouthOpen, targetMouthOpen, dtMs);
        // Same attack/decay smoothing as mouth openness -- mouth *shape*
        // snapping around per-frame would look like flickering between
        // vowel shapes rather than natural articulation.
        smoothedMouthForm = LipSyncAnalyzer.SmoothMouthValue(smoothedMouthForm, targetMouthForm, dtMs);

        if (model.HasParameter(mouthParam))
        {
            model.SetParameterValue(mouthParam, smoothedMouthOpen);
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

        if (Visible)
        {
            using var frame = renderer.Render(model, Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height), SKColors.Transparent,
                LiveAvatarPanel.FramingFraction(OverlayFraming));
            Present(frame);
        }
        if (mirror is { } panel)
        {
            using var frame = renderer.Render(model, Math.Max(1, panel.ClientSize.Width), Math.Max(1, panel.ClientSize.Height),
                SKColors.Transparent, LiveAvatarPanel.FramingFraction(panel.Framing));
            panel.ShowFrame(frame);
        }
    }

    // #685: true when a Live2D model is loaded, i.e. there's something to
    // show in a LiveAvatarPanel.
    public bool HasLiveModel => renderTimer is not null;

    // #685: the chat window's live avatar, drawn from this same model every
    // frame (so lip-sync, expressions and physics match the overlay); null
    // while it isn't on screen. UI thread only.
    private LiveAvatarPanel? mirror;
    public LiveAvatarPanel? Mirror
    {
        set
        {
            if (mirror == value)
            {
                return;
            }
            mirror?.ClearFrame();
            mirror = value;
            UpdateRenderTimer();
        }
    }

    // WM_TIMER fires on the ~15.6ms system tick, so intervals land on whole
    // ticks: 15 is every tick (~64fps; 16 would round up to every other
    // one), 31 every 2nd (~32fps), 46 every 3rd (~21fps). Full rate only
    // while she speaks, ~30 at rest, ~20 while a game runs;
    // MANA_AVATAR_FPS can only lower it.
    internal static int RenderIntervalMs(bool gameRunning, bool speaking, int fpsCap)
    {
        var interval = gameRunning ? 46 : speaking ? 15 : 31;
        return fpsCap > 0 ? Math.Max(interval, 1000 / fpsCap) : interval;
    }

    private void UpdateRenderTimer()
    {
        if (renderTimer is not null)
        {
            renderTimer.Enabled = Visible || mirror is not null;
        }
    }

    // #683: writes value clamped to the parameter's own range; a no-op for a
    // parameter this model doesn't have.
    private void SetLifeParameter(CubismModel model, string id, float value)
    {
        if (lifeParameters.TryGetValue(id, out var range))
        {
            model.SetParameterValue(id, Math.Clamp(value, range.Min, Math.Max(range.Min, range.Max)));
        }
    }

    // #681: preferredExpression is the reply's model-chosen expression name
    // (see AvatarExpressionSelector), tried before the state's own match.
    // #623: emotion is the sentence's emotion tag, if the model gave one.
    public void SetState(AvatarState state, string? preferredExpression = null, string? emotion = null)
    {
        // Callers include background threads (VoiceLoop's thread-pool
        // continuations and NAudio's playback thread) -- marshal onto the
        // UI thread before touching any WinForms control. Skip the check
        // before the handle exists (the constructor calls this on the UI
        // thread, and InvokeRequired is unreliable pre-handle-creation).
        if (IsHandleCreated && InvokeRequired)
        {
            BeginInvoke(() => SetState(state, preferredExpression, emotion));
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

        // #661: this is the speech input; the arbiter decides what shows.
        // The expression is re-applied even when the shown state doesn't
        // change (two excited replies in a row can each pick their own).
        arbiter.SetSpeech(state);
        speechExpression = AvatarStateArbiter.IsSpeech(state) ? preferredExpression : null;
        speechEmotion = AvatarStateArbiter.IsSpeech(state) ? emotion : null;
        // Q6: a happy/excited sentence may get a 0.5-3s "^^" smile (one at
        // a time); any other face ends it.
        var now = renderClock.Elapsed.TotalSeconds;
        if (!EyeBlink.IsSmileTag(speechEmotion))
        {
            closedSmileUntil = double.NegativeInfinity;
        }
        else if (now >= closedSmileUntil)
        {
            closedSmileUntil = now + EyeBlink.ClosedSmileSeconds(smileRandom);
        }
        ShowResolvedState(reapply: true);
    }

    // Whether the mic is on (VoiceLoop.IsListening), polled by stateTimer so
    // every way of turning it on or off (tray, hotkey, chat window, voice
    // enrolment's pause) shows without each one telling the avatar.
    public Func<bool>? IsListening { get; set; }

    // #661: Thinking/Working/Waiting/Dreaming on or off. Callable from any
    // thread, like SetState.
    public void SetActivity(AvatarState activity, bool on)
    {
        if (IsHandleCreated && InvokeRequired)
        {
            BeginInvoke(() => SetActivity(activity, on));
            return;
        }
        arbiter.Set(activity, on);
        ShowResolvedState(reapply: false);
    }

    // #661: the short "done" beat at the end of a turn.
    public void PulseDone()
    {
        if (IsHandleCreated && InvokeRequired)
        {
            BeginInvoke(PulseDone);
            return;
        }
        arbiter.PulseDone(renderClock.Elapsed.TotalSeconds);
        ShowResolvedState(reapply: false);
    }

    private void ShowResolvedState(bool reapply)
    {
        var now = renderClock.Elapsed.TotalSeconds;
        var changed = arbiter.Resolve(now);
        if (!changed && !reapply)
        {
            return;
        }
        var state = arbiter.Shown;
        if (changed)
        {
            if (!AvatarStateArbiter.IsSpeech(CurrentState) && AvatarStateArbiter.IsSpeech(state))
            {
                eyeBlink.Trigger(now); // #683: people blink as they start to speak
            }
            if (state == AvatarState.Done)
            {
                doneStartedAt = now;
            }
            CurrentState = state;
            StateChanged?.Invoke(state);
        }
        var preferredExpression = AvatarStateArbiter.IsSpeech(state) ? speechExpression : null;
        var emotion = AvatarStateArbiter.IsSpeech(state) ? speechEmotion : null;

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
            motionPlayer?.SetState(state, now);
            var expressionName = AvatarExpressionSelector.SelectExpressionName(state, expressions.Keys, preferredExpression, expressionOverrides, emotion);
            activeExpression = expressionName is not null && expressions.TryGetValue(expressionName, out var expression)
                ? expression
                : null;
            return;
        }

        var nextPath = AvatarStateArbiter.IsSpeech(state) ? talkingPath : idlePath;
        if (!File.Exists(nextPath))
        {
            return;
        }

        using var image = SKImage.FromEncodedData(nextPath);
        if (image is null)
        {
            return;
        }
        rescanVisibleTop = true; // idle and talking PNGs may differ
        // Framed like the Live2D model (#899); whole-body is a centred fit,
        // like the old PictureBox's Zoom.
        var width = Math.Max(1, ClientSize.Width);
        var height = Math.Max(1, ClientSize.Height);
        var (scale, x, y) = CubismRenderer.Fit(image.Width, image.Height, width, height, LiveAvatarPanel.FramingFraction(OverlayFraming));
        using var frame = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(frame))
        {
            canvas.Clear(SKColors.Transparent);
            canvas.DrawImage(image, SKRect.Create(x, y, image.Width * scale, image.Height * scale),
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
            rescanVisibleTop = true;
        }

        using (var pixmap = frame.PeekPixels())
        {
            pixmap.ReadPixels(new SKImageInfo(size.Width, size.Height, SKColorType.Bgra8888, SKAlphaType.Premul), dibBits, size.Width * 4);
        }
        if (rescanVisibleTop)
        {
            rescanVisibleTop = false;
            unsafe
            {
                visibleTop = FirstOpaqueRow(new ReadOnlySpan<byte>((void*)dibBits, size.Width * size.Height * 4), size.Width, size.Height);
            }
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

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(nint hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    private static extern int SetWindowLong(nint hwnd, int index, int value);

    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x20;

    // #662: click-through, the whole window passes clicks through, as it
    // always did before. Otherwise only her own pixels take clicks: a
    // layered window's fully transparent pixels already let mouse input
    // through to whatever is behind, so the empty space around her needs no
    // hit-testing of ours. WS_EX_NOACTIVATE keeps a click on her from taking
    // focus from the game/app in front.
    // Q3: automatically click-through while a watched game runs (GameRunning,
    // from the tray's 5s status poll); ClickThrough is the tray menu's
    // manual setting, which keeps her click-through all the time.
    private bool clickThrough;
    private bool gameRunning;
    public bool ClickThrough
    {
        get => clickThrough;
        set
        {
            clickThrough = value;
            ApplyClickThrough();
        }
    }

    public bool GameRunning
    {
        set
        {
            if (gameRunning != value)
            {
                gameRunning = value;
                ApplyClickThrough();
            }
        }
    }

    internal static bool IsClickThrough(bool manual, bool gameRunning) => manual || gameRunning;

    private void ApplyClickThrough()
    {
        if (IsHandleCreated)
        {
            var style = GetWindowLong(Handle, GwlExStyle);
            SetWindowLong(Handle, GwlExStyle, IsClickThrough(clickThrough, gameRunning) ? style | WsExTransparent : style & ~WsExTransparent);
        }
    }

    // #662: a left click on her that wasn't a drag.
    public event Action? Clicked;

    // #662: where the cursor and the window were when the left button went
    // down on her; null when no press is in progress.
    private Point? pressedAt;
    private Point pressedLocation;
    private bool dragging;

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button == MouseButtons.Left)
        {
            pressedAt = Cursor.Position;
            pressedLocation = Location;
            dragging = false;
        }
    }

    // WinForms captures the mouse on button-down, so a drag keeps following
    // the cursor even once it's off her pixels.
    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (pressedAt is not Point start)
        {
            return;
        }
        var cursor = Cursor.Position;
        var dx = cursor.X - start.X;
        var dy = cursor.Y - start.Y;
        var slop = SystemInformation.DragSize;
        if (!dragging && Math.Abs(dx) <= slop.Width / 2 && Math.Abs(dy) <= slop.Height / 2)
        {
            return;
        }
        dragging = true;
        Location = new Point(pressedLocation.X + dx, pressedLocation.Y + dy);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button == MouseButtons.Left)
        {
            EndPress(click: true);
        }
    }

    // Capture lost mid-press (e.g. Alt+Tab): keep wherever she was dragged
    // to, but it isn't a click. After a normal button-up this is a no-op.
    protected override void OnMouseCaptureChanged(EventArgs e)
    {
        base.OnMouseCaptureChanged(e);
        EndPress(click: false);
    }

    private void EndPress(bool click)
    {
        if (pressedAt is null)
        {
            return;
        }
        pressedAt = null;
        if (dragging && !partner)
        {
            // Nothing on this UI thread catches exceptions, and a position
            // that didn't save isn't worth crashing the launcher over.
            try
            {
                var settings = ManaSettingsStore.Load();
                settings.AvatarLeft = Left;
                settings.AvatarTop = Top;
                settings.Save();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.WriteLine($"AvatarOverlayForm: couldn't save the overlay position. {ex.Message}");
            }
        }
        else if (click)
        {
            attentiveStartedAt = renderClock.Elapsed.TotalSeconds;
            Clicked?.Invoke();
        }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExToolWindow = 0x80;
            const int wsExLayered = 0x80000;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExToolWindow | wsExLayered | wsExNoActivate | (IsClickThrough(clickThrough, gameRunning) ? WsExTransparent : 0);
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        renderTimer?.Stop();
        renderTimer?.Dispose();
        stateTimer.Dispose();
        cubismRenderer?.Dispose();
        cubismModel?.Dispose();
        ReleaseDib();
        base.OnFormClosed(e);
    }

    private void PositionOverlay(ManaSettingsStore settings)
    {
        Location = SavedLocation(settings.AvatarLeft, settings.AvatarTop, Size, Screen.AllScreens.Select(screen => screen.WorkingArea))
            ?? DefaultLocation(Size, Screen.PrimaryScreen?.WorkingArea ?? Screen.FromControl(this).WorkingArea,
                int.TryParse(Environment.GetEnvironmentVariable("MANA_AVATAR_LEFT"), out var left) ? left : null,
                ReadIntEnv("MANA_AVATAR_BOTTOM", 0));
    }

    // #662: where she was last dragged to, unless her centre is no longer on
    // any screen (e.g. that monitor was unplugged) -- then null, and she goes
    // back to the default spot instead of somewhere she can't be grabbed.
    // #899: pulled fully onto that screen, so a saved spot doesn't leave a
    // window that has since grown (framing, size) hanging off it.
    internal static Point? SavedLocation(int? left, int? top, Size size, IEnumerable<Rectangle> workAreas)
    {
        if (left is not int x || top is not int y)
        {
            return null;
        }
        var bounds = new Rectangle(x, y, size.Width, size.Height);
        var centre = new Point(x + (size.Width / 2), y + (size.Height / 2));
        return workAreas.Where(area => area.Contains(centre)).Select(area => (Point?)KeepInside(bounds, area)).FirstOrDefault();
    }

    // #899: flush in the bottom-right corner, like a streamer overlay: the
    // frame's bottom (the cut, when framed) on the working area's bottom
    // edge. MANA_AVATAR_LEFT/MANA_AVATAR_BOTTOM still move it.
    // #914: the partner's spot: bottom-aligned just left of Mana's, or to
    // her right when there's no room, kept inside the working area.
    internal static Point BesideLocation(Rectangle mana, Size size, Rectangle workArea)
    {
        var left = mana.Left - size.Width >= workArea.Left ? mana.Left - size.Width : mana.Right;
        return KeepInside(new Rectangle(left, mana.Bottom - size.Height, size.Width, size.Height), workArea);
    }

    internal static Point DefaultLocation(Size size, Rectangle workArea, int? left, int bottom) =>
        new(left is int x ? workArea.Left + x : workArea.Right - size.Width, workArea.Bottom - size.Height - bottom);

    // #899: the overlay's framing and size, from the tray menu. Anything else
    // (a missing or hand-edited value) is the default: upper half at 1.5x.
    public static readonly string[] OverlayFramings = ["full", "upperHalf", "bust"];
    public static readonly float[] OverlayScales = [1f, 1.25f, 1.5f, 1.75f, 2f];
    public string OverlayFraming { get; private set; } = "upperHalf";
    public float OverlayScale { get; private set; } = 1.5f;
    private readonly Size baseSize; // the full-body window at 1x
    private SizeF canvasSize;

    // The window size for a framing and scale (and remembers both).
    private Size Frame(string? framing, float? scale)
    {
        OverlayFraming = OverlayFramings.Contains(framing) ? framing! : "upperHalf";
        OverlayScale = scale is float value && OverlayScales.Contains(value) ? value : 1.5f;
        return OverlaySize(baseSize, canvasSize, LiveAvatarPanel.FramingFraction(OverlayFraming), OverlayScale);
    }

    // Live, from the tray: a dragged-to spot resizes in place, growing up
    // and out from where she stands, kept on her screen; otherwise she
    // stays in the default corner. UI thread only.
    public void SetFraming(string? framing, float? scale)
    {
        var size = Frame(framing, scale);
        rescanVisibleTop = true;
        var settings = ManaSettingsStore.Load();
        if (settings.AvatarLeft is null || settings.AvatarTop is null)
        {
            Size = size;
            PositionOverlay(settings);
        }
        else
        {
            Bounds = new Rectangle(KeepInside(Resized(Bounds, size), Screen.FromRectangle(Bounds).WorkingArea), size);
        }
        if (cubismModel is null)
        {
            ShowResolvedState(reapply: true); // redraw the PNG; Live2D redraws every tick
        }
    }

    // #899: base width x scale; the height shows `fraction` of the model at
    // the same pixel scale under CubismRenderer.Fit's top margin, so the
    // window ends where she's cut (full: the whole base window, scaled).
    internal static Size OverlaySize(Size baseSize, SizeF canvas, float fraction, float scale)
    {
        var width = baseSize.Width * scale;
        if (fraction >= 1f || canvas.Width <= 0 || canvas.Height <= 0)
        {
            return Size.Round(new SizeF(width, baseSize.Height * scale));
        }
        var modelScale = scale * Math.Min(baseSize.Width / canvas.Width, baseSize.Height / canvas.Height);
        return Size.Round(new SizeF(width, canvas.Height * fraction * modelScale / (1f - CubismRenderer.TopMargin)));
    }

    // #899: `bounds` resized about its bottom centre.
    internal static Rectangle Resized(Rectangle bounds, Size size) =>
        new(bounds.Left + ((bounds.Width - size.Width) / 2), bounds.Bottom - size.Height, size.Width, size.Height);

    // #899: the first row of the last frame with any of her in it, so
    // captions sit over her head rather than the empty top of the window.
    // Written by Present (UI thread); read like Bounds, a plain field read.
    // Only rescanned when the size, framing or picture changes, not every frame.
    private int visibleTop;
    private bool rescanVisibleTop = true;
    public Rectangle VisibleBounds => VisiblePart(Bounds, visibleTop);

    internal static Rectangle VisiblePart(Rectangle bounds, int top) =>
        top > 0 && top < bounds.Height ? Rectangle.FromLTRB(bounds.Left, bounds.Top + top, bounds.Right, bounds.Bottom) : bounds;

    // Premultiplied BGRA rows; a faint edge (alpha <= 32) doesn't count.
    // Height when there's nothing.
    internal static int FirstOpaqueRow(ReadOnlySpan<byte> bgra, int width, int height)
    {
        for (var row = 0; row < height; row++)
        {
            for (var i = (row * width * 4) + 3; i < (row + 1) * width * 4; i += 4)
            {
                if (bgra[i] > 32)
                {
                    return row;
                }
            }
        }
        return height;
    }

    private static int ReadIntEnv(string name, int fallback)
    {
        return int.TryParse(Environment.GetEnvironmentVariable(name), out var value)
            ? value
            : fallback;
    }
}
