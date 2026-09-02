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

    private readonly CubismModel? cubismModel;
    private readonly CubismRenderer? cubismRenderer;
    private readonly System.Windows.Forms.Timer? renderTimer;
    private readonly Stopwatch renderClock = Stopwatch.StartNew();
    private long lastRenderTickMs;
    private float smoothedMouthOpen;
    private float smoothedMouthForm;

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

        (cubismModel, cubismRenderer) = TryLoadCubismModel(rootDirectory);
        if (cubismModel is not null && cubismRenderer is not null)
        {
            renderTimer = new System.Windows.Forms.Timer { Interval = 33 }; // ~30fps
            renderTimer.Tick += (_, _) => RenderFrame(cubismModel, cubismRenderer);
            renderTimer.Start();
        }

        SetState(AvatarState.Idle);
        PositionOverlay();
    }

    // Returns (null, null) -- not a throw -- when the SDK/model aren't
    // available, or if a real model file exists but fails to parse: any
    // of those mean "fall back to the PNG swap", not "crash the launcher".
    private static (CubismModel?, CubismRenderer?) TryLoadCubismModel(string rootDirectory)
    {
        if (!CubismCoreLibrary.IsAvailable(rootDirectory))
        {
            return (null, null);
        }

        var model3JsonPath = Path.Combine(
            rootDirectory, "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
        if (!File.Exists(model3JsonPath))
        {
            return (null, null);
        }

        CubismModel? model = null;
        try
        {
            var settings = CubismModelSettings.Load(model3JsonPath);
            model = CubismModel.Load(settings);
            var renderer = new CubismRenderer(settings.TexturePaths);
            return (model, renderer);
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
            return (null, null);
        }
    }

    private void RenderFrame(CubismModel model, CubismRenderer renderer)
    {
        var nowMs = renderClock.ElapsedMilliseconds;
        var dtMs = lastRenderTickMs == 0 ? 33f : Math.Max(1, nowMs - lastRenderTickMs);
        lastRenderTickMs = nowMs;

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

        // #479 sub-project 4: when a real Cubism model is loaded, the
        // render timer (RenderFrame) is what actually draws every frame
        // going forward -- this method's PNG-swap below is the fallback
        // for when it isn't. Mood states beyond Idle/Talking don't yet
        // change the Cubism render (no exp3.json expression-blending
        // support -- a further scope cut beyond motion/physics/masking,
        // consistent with the ones CubismModel's own header comment
        // already documents); they're tracked by being passed through
        // ReplyEmotionDetector's callers, ready for that to slot in later.
        if (cubismModel is not null)
        {
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
