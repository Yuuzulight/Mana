namespace Mana.NativeLauncher.Live2D;

// #683: where she's looking. Electron drifts head+eyes toward random targets
// (windows-launcher/avatar/live2d-avatar.js ~243-280/319, live2d-logic.js's
// AIRI saccade-interval table); this moves like a person rather than a
// lerp, with Q6's (2026-09-29) Neuro-style fixation lengths:
// - Eyes are saccadic: they jump to the new spot at once (Q6, 16-32ms,
//   a frame or two), then hold with only tiny fixational drift -- 0.5-1.5s
//   per fixation while talking, 1-3s otherwise (Q6).
// - The head follows late and partially (eye-head coordination, Freedman
//   2008): it starts ~80-150ms after the eyes, takes ~300-500ms, covers
//   60-100% of the configured head turn, and stays put for small shifts.
// - Most glances go back to the viewer ("home"): 55% idle, 80% while
//   talking, where look-aways are also brief. Vertical glances are smaller
//   than horizontal ones and biased downward.
// - A large shift asks for a blink 40% of the time (gaze-evoked blinks,
//   Evinger et al. 1994) -- Update() returns true; the caller forwards it
//   to EyeBlink.Trigger.
// Plus Electron's idle pitch clamp (+-maxPitch, fading in/out over 900ms),
// and (Q6) a head roll that sways on two layered rhythms, ~2.5s and ~5s,
// peaking at the tilt (+-8 by default), or the animated tilt (16) while an
// excited sentence is said; the body leans after it at BodyFollow.
//
// Pure math: the caller adds HeadAngleX/EyeBallX/EyeBallY on top of what
// the motion and expression set this frame and passes pitch/roll through
// ApplyPitch and adds Sway, so those layers keep their own movement.
//
// #661 activity modes: Thinking looks up and to one side and holds there
// (the classic "searching memory" glance); Working looks down with small,
// quick, reading-like hops; Attentive (waiting for you) keeps her eyes on
// the viewer. Idle and Attentive keep the side tilt; the others ease it off.
internal enum GazeMode
{
    Idle,
    Talking,
    Thinking,
    Working,
    Attentive,
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
    public const float DefaultAnimatedTiltDegrees = 16f;
    // Q6: the body leans with the head at 0.5-0.7x its offsets.
    public const float BodyFollow = 0.6f;

    private const float TiltBlendMs = 900f;
    private const float LargeShift = 0.4f; // eyeball units; smaller shifts are eyes-only
    private const float GazeBlinkChance = 0.4f;

    private readonly float gazeDegrees;
    private readonly float intervalScale;
    private readonly float tiltDegrees;
    private readonly float animatedTiltDegrees;
    private readonly float maxPitchDegrees;
    private readonly Random random;
    private readonly float microPhaseX, microPhaseX2, microPhaseY, swayPhase, swayPhase2;
    private float swayAmplitude;

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
        float animatedTiltDegrees = DefaultAnimatedTiltDegrees,
        int? seed = null)
    {
        this.gazeDegrees = gazeDegrees;
        intervalScale = gazePeriodMs > 0 && float.IsFinite(gazePeriodMs) ? gazePeriodMs / DefaultGazePeriodMs : 1f;
        this.tiltDegrees = tiltDegrees;
        this.animatedTiltDegrees = animatedTiltDegrees;
        this.maxPitchDegrees = maxPitchDegrees;
        random = seed is { } s ? new Random(s) : new Random();
        microPhaseX = (float)(random.NextDouble() * Math.Tau);
        microPhaseX2 = (float)(random.NextDouble() * Math.Tau);
        microPhaseY = (float)(random.NextDouble() * Math.Tau);
        swayPhase = (float)(random.NextDouble() * Math.Tau);
        swayPhase2 = (float)(random.NextDouble() * Math.Tau);
    }

    // 0 = not idle (pitch clamp off), 1 = fully idle.
    public float TiltBlend { get; private set; }

    // Q6: head roll (degrees of ParamAngleZ) to add this frame.
    public float Sway { get; private set; }

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
    // would like a blink with it. animated: an excited sentence is being
    // said (bigger sway).
    public bool Update(float dtMs, GazeMode mode, bool animated = false)
    {
        nowMs += dtMs;
        var ease = Math.Min(1f, dtMs / TiltBlendMs);
        TiltBlend += ((mode is GazeMode.Idle or GazeMode.Attentive ? 1f : 0f) - TiltBlend) * ease;
        // Busy (thinking/working) holds her head still; otherwise it sways.
        var swayTarget = mode is GazeMode.Thinking or GazeMode.Working ? 0f : animated ? animatedTiltDegrees : tiltDegrees;
        swayAmplitude += (swayTarget - swayAmplitude) * ease;
        var t = nowMs / 1000.0;
        Sway = swayAmplitude * ((0.6f * (float)Math.Sin((Math.Tau * t / 2.5) + swayPhase))
                              + (0.4f * (float)Math.Sin((Math.Tau * t / 5.0) + swayPhase2)));
        if (!GazeActive)
        {
            return false;
        }

        if (mode != lastMode)
        {
            // A mode change (e.g. starting to talk) re-picks the gaze now,
            // under the new mode's rules.
            nextSaccadeAtMs = lastMode is null ? nowMs + FixationMs(mode) : nowMs;
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

    // #661: the "done" beat's small nod -- a ParamAngleY dip (degrees) to
    // add, sinceSeconds after the beat started; 0 outside it.
    public const float NodSeconds = 0.5f;
    public static float NodOffset(double sinceSeconds) =>
        sinceSeconds is >= 0 and < NodSeconds ? -6f * MathF.Sin(MathF.PI * (float)(sinceSeconds / NodSeconds)) : 0f;

    // Q34: clicking her -- a quick attentive look: (pitch, roll) degrees to
    // add, a small lift and a head tilt toward you that ease in and back
    // out, sinceSeconds after the click; (0, 0) outside it. The eyes come to
    // the viewer through GazeMode.Attentive for the same window.
    public const float AttentiveSeconds = 1.2f;
    public static (float Pitch, float Roll) AttentiveLookOffset(double sinceSeconds)
    {
        if (sinceSeconds is not (>= 0 and < AttentiveSeconds))
        {
            return (0f, 0f);
        }
        var k = MathF.Sin(MathF.PI * (float)(sinceSeconds / AttentiveSeconds));
        return (3f * k, 7f * k);
    }

    private bool StartSaccade(GazeMode mode)
    {
        SaccadeCount++;
        var busy = mode is GazeMode.Thinking or GazeMode.Working;
        var home = random.NextDouble() < mode switch
        {
            GazeMode.Talking => 0.8,
            GazeMode.Attentive => 1.0,
            GazeMode.Thinking or GazeMode.Working => 0.15, // an occasional glance back at you
            _ => 0.55,
        };
        float x, y, holdMs;
        if (home)
        {
            x = Uniform(-0.08f, 0.08f);
            y = Uniform(-0.06f, 0.06f);
            holdMs = busy ? Uniform(500f, 1000f) : FixationMs(mode);
        }
        else if (mode == GazeMode.Thinking)
        {
            x = Side() * Uniform(0.35f, 0.7f);
            y = Uniform(0.4f, 0.75f);
            holdMs = Uniform(1500f, 3500f);
        }
        else if (mode == GazeMode.Working)
        {
            x = Uniform(-0.4f, 0.4f);
            y = Uniform(-0.55f, -0.3f);
            holdMs = Uniform(250f, 600f);
        }
        else
        {
            x = Side() * Uniform(0.3f, 1f);
            y = Uniform(-0.5f, 0.25f); // smaller, and more often down than up
            holdMs = FixationMs(mode);
        }

        var shift = MathF.Sqrt(((x - eyeX) * (x - eyeX)) + ((y - eyeY) * (y - eyeY)));
        eyeFromX = eyeX;
        eyeFromY = eyeY;
        TargetX = x;
        TargetY = y;
        eyeStartMs = nowMs;
        eyeDurationMs = 16f + (16f * Math.Min(1f, shift / 1.5f));

        var large = shift >= LargeShift;
        if (large)
        {
            headFrom = HeadAngleX;
            HeadTargetX = x * gazeDegrees * Uniform(0.6f, 1f);
            headStartMs = nowMs + Uniform(80f, 150f);
            headDurationMs = Uniform(300f, 500f);
        }

        nextSaccadeAtMs = nowMs + holdMs;
        return large && random.NextDouble() < GazeBlinkChance;
    }

    // Q6: how long a fixation holds -- 0.5-1.5s while talking, 1-3s
    // otherwise, scaled by idleGazePeriodMs.
    private float FixationMs(GazeMode mode) =>
        (mode == GazeMode.Talking ? Uniform(500f, 1500f) : Uniform(1000f, 3000f)) * intervalScale;

    private float Side() => random.Next(2) == 0 ? -1f : 1f;

    private float Uniform(float min, float max) => min + ((float)random.NextDouble() * (max - min));
}
