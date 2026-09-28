namespace Mana.NativeLauncher.Live2D;

// #683: auto-blink, ported from the timing Cubism Framework's own
// CubismEyeBlink uses (and Electron gets for free through
// pixi-live2d-display -- windows-launcher/avatar/live2d-avatar.js ~157-160):
// a random 0-7s wait, then 0.1s closing, 0.05s closed, 0.15s opening.
// Openness() is a 0..1 factor the caller MULTIPLIES into the eye-open
// parameters after the idle motion and expression have set them, so it
// composes with both instead of replacing them: a motion's own baked blink
// or an expression's half-closed eyes stay as they are, a blink just closes
// them the rest of the way.
internal sealed class EyeBlink
{
    private const float ClosingSeconds = 0.1f;
    private const float ClosedSeconds = 0.05f;
    private const float OpeningSeconds = 0.15f;
    private const float BlinkSeconds = ClosingSeconds + ClosedSeconds + OpeningSeconds;
    private const float MeanIntervalSeconds = 4f;

    private readonly Random random;
    // double, not float: the launcher runs for days, and a float clock loses
    // the 0.05s resolution a blink needs after a few of them.
    private double blinkStartSeconds = double.NaN;

    // seed: null (every real call site) uses genuine randomness; tests pass
    // a fixed seed so the schedule is reproducible.
    public EyeBlink(int? seed = null)
    {
        random = seed is { } s ? new Random(s) : new Random();
    }

    // 1 = fully open, 0 = fully closed, at timeSeconds (monotonic).
    public float Openness(double timeSeconds)
    {
        if (double.IsNaN(blinkStartSeconds))
        {
            blinkStartSeconds = timeSeconds + NextInterval();
        }

        var t = (float)(timeSeconds - blinkStartSeconds);
        if (t >= BlinkSeconds)
        {
            // Scheduled from when this blink ended, not from "now", so a
            // stalled frame (window hidden, debugger) doesn't bunch blinks up.
            blinkStartSeconds += BlinkSeconds + NextInterval();
            if (blinkStartSeconds + BlinkSeconds < timeSeconds)
            {
                blinkStartSeconds = timeSeconds + NextInterval();
            }
            t = (float)(timeSeconds - blinkStartSeconds);
        }

        if (t < 0)
        {
            return 1f;
        }
        if (t < ClosingSeconds)
        {
            return 1f - (t / ClosingSeconds);
        }
        if (t < ClosingSeconds + ClosedSeconds)
        {
            return 0f;
        }
        return Math.Min(1f, (t - ClosingSeconds - ClosedSeconds) / OpeningSeconds);
    }

    // Same r * (2 * interval - 1) spread as CubismEyeBlink: 0-7s, mean ~3.5s.
    private float NextInterval() => (float)random.NextDouble() * ((2f * MeanIntervalSeconds) - 1f);
}
