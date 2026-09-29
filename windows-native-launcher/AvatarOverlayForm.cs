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
    // #661: what she's doing rather than how she feels -- see
    // AvatarStateArbiter for which one shows when several apply.
    Thinking,
    Working,
    Waiting,
    Done,
    Dreaming,
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
    private float sleepiness;
    // Q6: the "^^" closed-eye smile -- until when, and how far in (eased).
    private double closedSmileUntil = double.NegativeInfinity;
    private float closedSmile;
    private readonly Random smileRandom = new();

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

    // #515/#683: plays the model's own motion groups as the base animation
    // layer -- its Idle group at rest, each mood's own group when it has
    // one, plus mana-avatar.json's random ambient motions (see
    // AvatarMotionPlayer). Null without a Live2D model. Only touched on the
    // UI thread (SetState marshals there first; RenderFrame is a UI-thread
    // timer tick).
    private readonly AvatarMotionPlayer? motionPlayer;

    // #342 follow-up: base layer underneath motionPlayer when the model has
    // no Idle group (none declared, all failed to load, or no stateMotions
    // idle mapping) -- without this, the avatar previously had zero idle
    // movement in that case. Mood clips, when the model has any, still
    // play (and crossfade) over it.
    private readonly ProceduralIdleMotion? proceduralIdleMotion;

    // #683: mana-avatar.json / MANA_LIVE2D_* tuning (AvatarConfig).
    private readonly string mouthParam = "ParamMouthOpenY";
    private readonly IReadOnlyDictionary<string, IReadOnlyList<string>> expressionOverrides = new Dictionary<string, IReadOnlyList<string>>();

    // The model's .physics3.json simulation (hair/skirt sway), or null if it
    // ships none or it failed to load. Stateful, stepped once per frame.
    private readonly CubismPhysics? physics;

    // #683: auto-blink and gaze/idle head tilt, layered on top of the idle
    // motion and expression every frame (see RenderFrame). lifeParameters
    // holds every parameter they touch that this model actually has, with
    // its default and range: they're reset to default at the start of each
    // frame so an offset/multiplier never compounds on last frame's value
    // when no motion rewrites that parameter.
    private static readonly string[] GazeIds = ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamEyeBallX", "ParamEyeBallY",
        "ParamBodyAngleX", "ParamBodyAngleZ", "ParamEyeLSmile", "ParamEyeRSmile"];
    private readonly EyeBlink eyeBlink = new();
    private readonly AvatarGaze gaze;
    private readonly string[] eyeBlinkIds = [];
    private readonly Dictionary<string, (float Default, float Min, float Max)> lifeParameters = [];

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
        physics = loaded.Physics;
        ModelPath = loaded.ModelPath;
        ModelLoadProblem = loaded.Problem;
        ModelLoadWarnings = loaded.Warnings ?? Array.Empty<string>();
        var config = loaded.Config ?? AvatarConfig.Parse(null, _ => null);
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
            // ~60fps: WM_TIMER fires on the ~15.6ms system tick, so 15
            // lands on every tick (16 would round up to every other one).
            // MANA_AVATAR_FPS (#683, Electron's knob) can lower that.
            var fps = ReadIntEnv("MANA_AVATAR_FPS", 0);
            renderTimer = new System.Windows.Forms.Timer { Interval = fps > 0 ? Math.Max(15, 1000 / fps) : 15 };
            renderTimer.Tick += (_, _) => RenderFrame(cubismModel, cubismRenderer);
            // Only animate while she's actually on screen -- the launcher
            // shows the overlay after the startup screen closes, so there's
            // no rendering in the background during startup (or while hidden).
            VisibleChanged += (_, _) => renderTimer.Enabled = Visible;
        }

        SetState(AvatarState.Idle);
        stateTimer.Tick += (_, _) => ShowResolvedState(reapply: false);
        stateTimer.Start();
        PositionOverlay();
    }

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
        var gazeMode = shown switch
        {
            AvatarState.Thinking => GazeMode.Thinking,
            AvatarState.Working => GazeMode.Working,
            AvatarState.Waiting => GazeMode.Attentive,
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
        if (shown == AvatarState.Done)
        {
            SetLifeParameter(model, "ParamAngleY", model.GetParameterCurrentValue("ParamAngleY") + AvatarGaze.NodOffset(nowSeconds - doneStartedAt));
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

        using var frame = renderer.Render(model, Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height), SKColors.Transparent);
        Present(frame);
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
        stateTimer.Dispose();
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
