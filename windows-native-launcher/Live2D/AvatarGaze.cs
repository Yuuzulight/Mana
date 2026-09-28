namespace Mana.NativeLauncher.Live2D;

// #683: where she's looking. Electron drifts head+eyes toward random targets
// (windows-launcher/avatar/live2d-avatar.js ~243-280/319, live2d-logic.js's
// AIRI saccade-interval table); this keeps that table for fixation lengths
// but moves like a person rather than a lerp:
// - Eyes are saccadic: a fast ease-out jump (~40-80ms, longer for bigger
//   jumps -- the saccadic "main sequence", Bahill et al. 1975), then a hold
//   with only tiny fixational drift.
// - The head follows late and partially (eye-head coordination, Freedman
//   2008): it starts ~80-150ms after the eyes, takes ~300-500ms, covers
//   60-100% of the configured head turn, and stays put for small shifts.
// - Most glances go back to the viewer ("home"): 55% idle, 80% while
//   talking, where look-aways are also brief. Vertical glances are smaller
//   than horizontal ones and biased downward.
// - A large shift asks for a blink 40% of the time (gaze-evoked blinks,
//   Evinger et al. 1994) -- Update() returns true; the caller forwards it
//   to EyeBlink.Trigger.
// Plus Electron's sleepy tilt while idle: pitch clamped to +-maxPitch, roll
// eased toward the tilt, fading in/out over 900ms.
//
// Pure math: the caller adds HeadAngleX/EyeBallX/EyeBallY on top of what
// the motion and expression set this frame and passes pitch/roll through
// ApplyPitch/ApplyRoll, so those layers keep their own movement.
internal enum GazeMode
{
    Idle,
    Talking,
}

internal sealed class AvatarGaze
{
    // Head turn (degrees of ParamAngleX) for a full-range glance.
    public const float DefaultGazeDegrees = 6f;
    public const float DefaultGazePeriodMs = 9000f;
    // Electron's 16 was tuned for a sleepy "dozing off" idle clip on a
    // different model; 8 reads as a relaxed head tilt rather than a slump.
    public const float DefaultTiltDegrees = 8f;
    public const float DefaultMaxPitchDegrees = 8f;

    private const float TiltBlendMs = 900f;
    private const float LargeShift = 0.4f; // eyeball units; smaller shifts are eyes-only
    private const float GazeBlinkChance = 0.4f;
    private const float SaccadeStepMs = 400f;

    // live2d-logic.js's SACCADE_INTERVAL_TABLE (ported from Project AIRI,
    // MIT), made cumulative: [probability, baseMs]. The last row is the
    // catch-all.
    private static readonly (float Probability, float BaseMs)[] SaccadeIntervals = BuildSaccadeIntervals();

    private readonly float gazeDegrees;
    private readonly float intervalScale;
    private readonly float tiltDegrees;
    private readonly float maxPitchDegrees;
    private readonly Random random;
    private readonly float microPhaseX, microPhaseX2, microPhaseY;

    // double: a float millisecond clock stops advancing by a 16ms frame
    // after a few days of uptime.
    private double nowMs;
    private double nextSaccadeAtMs;
    private GazeMode? lastMode;
    private float eyeX, eyeY; // saccade position, without fixational drift
    private float eyeFromX, eyeFromY;
    private double eyeStartMs;
    private float eyeDurationMs = 1f;
    private float headFrom;
    private double headStartMs;
    private float headDurationMs = 1f;

    public AvatarGaze(
        float gazeDegrees = DefaultGazeDegrees,
        float gazePeriodMs = DefaultGazePeriodMs,
        float tiltDegrees = DefaultTiltDegrees,
        float maxPitchDegrees = DefaultMaxPitchDegrees,
        int? seed = null)
    {
        this.gazeDegrees = gazeDegrees;
        intervalScale = gazePeriodMs > 0 && float.IsFinite(gazePeriodMs) ? gazePeriodMs / DefaultGazePeriodMs : 1f;
        this.tiltDegrees = tiltDegrees;
        this.maxPitchDegrees = maxPitchDegrees;
        random = seed is { } s ? new Random(s) : new Random();
        microPhaseX = (float)(random.NextDouble() * Math.Tau);
        microPhaseX2 = (float)(random.NextDouble() * Math.Tau);
        microPhaseY = (float)(random.NextDouble() * Math.Tau);
    }

    // 0 = not idle (tilt off), 1 = fully idle.
    public float TiltBlend { get; private set; }

    // Offsets to add this frame.
    public float HeadAngleX { get; private set; }
    public float EyeBallX { get; private set; }
    public float EyeBallY { get; private set; }

    // Where the current saccade is headed (for tests/diagnostics).
    public float TargetX { get; private set; }
    public float TargetY { get; private set; }
    public float HeadTargetX { get; private set; }
    public int SaccadeCount { get; private set; }

    // Electron's opt-outs: idleGazeDeg 0 disables the gaze; idleTiltDeg 0 +
    // idleMaxPitchDeg 90 (no real head pitches that far) disables the tilt.
    public bool TiltActive => tiltDegrees != 0 || maxPitchDegrees < 90;
    public bool GazeActive => gazeDegrees != 0;

    // Advances the clock; returns true when a large saccade just started and
    // would like a blink with it.
    public bool Update(float dtMs, GazeMode mode)
    {
        nowMs += dtMs;
        TiltBlend += ((mode == GazeMode.Idle ? 1f : 0f) - TiltBlend) * Math.Min(1f, dtMs / TiltBlendMs);
        if (!GazeActive)
        {
            return false;
        }

        if (mode != lastMode)
        {
            // A mode change (e.g. starting to talk) re-picks the gaze now,
            // under the new mode's rules.
            nextSaccadeAtMs = lastMode is null ? nowMs + NextFixationMs(mode) : nowMs;
            lastMode = mode;
        }
        var wantsBlink = nowMs >= nextSaccadeAtMs && StartSaccade(mode);

        var pe = (float)Math.Clamp((nowMs - eyeStartMs) / eyeDurationMs, 0, 1);
        var eased = 1f - ((1f - pe) * (1f - pe) * (1f - pe)); // ease-out cubic
        eyeX = eyeFromX + ((TargetX - eyeFromX) * eased);
        eyeY = eyeFromY + ((TargetY - eyeFromY) * eased);

        // Fixational drift: two slow incommensurate sines, <= ~0.03 of range.
        var seconds = nowMs / 1000.0;
        EyeBallX = eyeX + (0.02f * (float)Math.Sin((Math.Tau * 0.37 * seconds) + microPhaseX))
                        + (0.012f * (float)Math.Sin((Math.Tau * 0.83 * seconds) + microPhaseX2));
        EyeBallY = eyeY + (0.015f * (float)Math.Sin((Math.Tau * 0.53 * seconds) + microPhaseY));

        var ph = (float)Math.Clamp((nowMs - headStartMs) / headDurationMs, 0, 1);
        HeadAngleX = headFrom + ((HeadTargetX - headFrom) * (0.5f - (0.5f * MathF.Cos(ph * MathF.PI))));
        return wantsBlink;
    }

    // Eases a (possibly dramatic, "falling backwards") idle-motion head
    // pitch into [-maxPitch, maxPitch].
    public float ApplyPitch(float rawAngleY)
    {
        var clamped = Math.Clamp(rawAngleY, -maxPitchDegrees, maxPitchDegrees);
        return rawAngleY + ((clamped - rawAngleY) * TiltBlend);
    }

    // Eases the head roll toward the configured side tilt.
    public float ApplyRoll(float rawAngleZ) => rawAngleZ + ((tiltDegrees - rawAngleZ) * TiltBlend);

    private bool StartSaccade(GazeMode mode)
    {
        SaccadeCount++;
        var talking = mode == GazeMode.Talking;
        var home = random.NextDouble() < (talking ? 0.8 : 0.55);
        float x, y;
        if (home)
        {
            x = Uniform(-0.08f, 0.08f);
            y = Uniform(-0.06f, 0.06f);
        }
        else
        {
            x = (random.Next(2) == 0 ? -1f : 1f) * Uniform(0.3f, 1f);
            y = Uniform(-0.5f, 0.25f); // smaller, and more often down than up
        }

        var shift = MathF.Sqrt(((x - eyeX) * (x - eyeX)) + ((y - eyeY) * (y - eyeY)));
        eyeFromX = eyeX;
        eyeFromY = eyeY;
        TargetX = x;
        TargetY = y;
        eyeStartMs = nowMs;
        eyeDurationMs = 40f + (40f * Math.Min(1f, shift / 1.5f));

        var large = shift >= LargeShift;
        if (large)
        {
            headFrom = HeadAngleX;
            HeadTargetX = x * gazeDegrees * Uniform(0.6f, 1f);
            headStartMs = nowMs + Uniform(80f, 150f);
            headDurationMs = Uniform(300f, 500f);
        }

        nextSaccadeAtMs = nowMs + (talking && !home ? Uniform(400f, 900f) : NextFixationMs(mode));
        return large && random.NextDouble() < GazeBlinkChance;
    }

    private float NextFixationMs(GazeMode mode)
    {
        var scale = intervalScale * (mode == GazeMode.Talking ? 1.3f : 1f);
        var r = random.NextDouble();
        foreach (var (probability, baseMs) in SaccadeIntervals)
        {
            if (r <= probability)
            {
                return (baseMs + ((float)random.NextDouble() * SaccadeStepMs)) * scale;
            }
        }
        return (SaccadeIntervals[^1].BaseMs + ((float)random.NextDouble() * SaccadeStepMs)) * scale;
    }

    private float Uniform(float min, float max) => min + ((float)random.NextDouble() * (max - min));

    private static (float, float)[] BuildSaccadeIntervals()
    {
        float[] probabilities = [0.075f, 0.11f, 0.125f, 0.14f, 0.125f, 0.05f, 0.04f, 0.03f, 0.02f, 1f];
        var table = new (float, float)[probabilities.Length];
        table[0] = (probabilities[0], 800f);
        for (var i = 1; i < table.Length; i++)
        {
            table[i] = (table[i - 1].Item1 + probabilities[i], table[i - 1].Item2 + SaccadeStepMs);
        }
        return table;
    }
}
