namespace Mana.NativeLauncher.Live2D;

// #683: idle "looking around" saccades plus the sleepy head-tilt clamp,
// ported from windows-launcher/avatar/live2d-avatar.js ~243-280/319 and
// live2d-logic.js's randomSaccadeInterval/pickIdleSaccadeTarget/
// smoothTowardTarget. Pure math: Update() advances the clock, then the
// caller reads the offsets and applies them on top of whatever the idle
// motion and expression already set this frame (additively for the gaze,
// as a blend for the tilt), so both layers keep their own movement.
//
// Everything fades in/out with Blend (900ms, same as Electron) so the
// gaze and tilt settle together when she goes idle and hand the head back
// to the motion/talking pose when she doesn't.
internal sealed class IdleGaze
{
    public const float DefaultGazeDegrees = 6f;
    public const float DefaultGazePeriodMs = 9000f;
    public const float DefaultTiltDegrees = 16f;
    public const float DefaultMaxPitchDegrees = 8f;

    private const float BlendMs = 900f;
    private const float SaccadeSmoothingMs = 500f;
    private const float SaccadeStepMs = 400f;

    // live2d-logic.js's SACCADE_INTERVAL_TABLE (ported from Project AIRI,
    // MIT), already cumulative: [probability, baseMs]. Mostly quick
    // corrective glances, tailing off into rarer long holds; the last row is
    // the catch-all.
    private static readonly (float Probability, float BaseMs)[] SaccadeIntervals = BuildSaccadeIntervals();

    private readonly float gazeDegrees;
    private readonly float intervalScale;
    private readonly float tiltDegrees;
    private readonly float maxPitchDegrees;
    private readonly Random random;

    // double: a float millisecond clock stops advancing by a 16ms frame
    // after a few days of uptime.
    private double nowMs;
    private double nextSaccadeAtMs;
    private float targetAngleX, targetEyeX, targetEyeY;

    public IdleGaze(
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
    }

    // 0 = not idle (no effect), 1 = fully idle.
    public float Blend { get; private set; }

    // Smoothed saccade position, NOT yet scaled by Blend -- the *Offset
    // properties below are what a caller applies.
    public float AngleX { get; private set; }
    public float EyeBallX { get; private set; }
    public float EyeBallY { get; private set; }

    public float AngleXOffset => AngleX * Blend;
    public float EyeBallXOffset => EyeBallX * Blend;
    public float EyeBallYOffset => EyeBallY * Blend;

    // Real head-angle parameters rarely exceed ~30 degrees, so a max pitch
    // at or above 90 never clamps anything -- Electron's opt-out convention
    // (idleTiltDeg: 0, idleMaxPitchDeg: 90).
    public bool TiltActive => tiltDegrees != 0 || maxPitchDegrees < 90;
    public bool GazeActive => gazeDegrees != 0;

    public void Update(float dtMs, bool idle)
    {
        nowMs += dtMs;
        Blend += ((idle ? 1f : 0f) - Blend) * Math.Min(1f, dtMs / BlendMs);

        if (!GazeActive)
        {
            return;
        }
        if (nowMs >= nextSaccadeAtMs)
        {
            targetAngleX = ((float)random.NextDouble() * 2f - 1f) * gazeDegrees;
            targetEyeX = (float)random.NextDouble() * 2f - 1f;
            targetEyeY = ((float)random.NextDouble() * 2f - 1f) * 0.7f;
            nextSaccadeAtMs = nowMs + NextSaccadeIntervalMs();
        }
        AngleX = SmoothToward(AngleX, targetAngleX, dtMs, SaccadeSmoothingMs);
        EyeBallX = SmoothToward(EyeBallX, targetEyeX, dtMs, SaccadeSmoothingMs);
        EyeBallY = SmoothToward(EyeBallY, targetEyeY, dtMs, SaccadeSmoothingMs);
    }

    // Eases a (possibly dramatic, "falling backwards") idle-motion head
    // pitch into [-maxPitch, maxPitch].
    public float ApplyPitch(float rawAngleY)
    {
        var clamped = Math.Clamp(rawAngleY, -maxPitchDegrees, maxPitchDegrees);
        return rawAngleY + ((clamped - rawAngleY) * Blend);
    }

    // Eases the head roll toward the configured sleepy side tilt.
    public float ApplyRoll(float rawAngleZ) => rawAngleZ + ((tiltDegrees - rawAngleZ) * Blend);

    // Symmetric time-based lerp -- live2d-logic.js's smoothTowardTarget.
    public static float SmoothToward(float previous, float target, float dtMs, float windowMs) =>
        previous + ((target - previous) * Math.Min(1f, dtMs / Math.Max(1f, windowMs)));

    private float NextSaccadeIntervalMs()
    {
        var r = random.NextDouble();
        foreach (var (probability, baseMs) in SaccadeIntervals)
        {
            if (r <= probability)
            {
                return (baseMs + ((float)random.NextDouble() * SaccadeStepMs)) * intervalScale;
            }
        }
        return (SaccadeIntervals[^1].BaseMs + ((float)random.NextDouble() * SaccadeStepMs)) * intervalScale;
    }

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
