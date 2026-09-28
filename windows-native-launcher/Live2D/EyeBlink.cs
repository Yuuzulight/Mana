namespace Mana.NativeLauncher.Live2D;

// #683: auto-blink (Electron gets one for free through pixi-live2d-display's
// CubismEyeBlink -- windows-launcher/avatar/live2d-avatar.js ~157-160),
// shaped after human blink figures rather than Cubism's uniform timer:
// - Rate: ~15-20 blinks/min at rest, more in conversation (Bentivoglio et
//   al. 1997), so the interval is log-normal around ~3.5s, clamped to
//   1.2-8s, and ~1.4x as frequent while talking (#661: less often while
//   thinking or concentrating on a task -- the caller passes the rate).
// - Shape: the lid closes fast and accelerating, holds briefly, and opens
//   more slowly, decelerating (VanderWerf et al. 2003: closing ~2x faster
//   than opening), each phase jittered +-15% per blink.
// - ~12% are double blinks, ~10% are partial (lid stops 30-50% open).
// - Trigger() lets a large gaze shift or the start of speech pull the next
//   blink forward (gaze-evoked blinks, Evinger et al. 1994).
// Openness() is a 0..1 factor the caller MULTIPLIES into the eye-open
// parameters after the motion and expression have set them, so it composes
// with both: a motion's baked blink or an expression's half-closed eyes stay
// as they are, a blink just closes them the rest of the way.
internal sealed class EyeBlink
{
    private const float MedianIntervalSeconds = 3.2f; // log-normal, sigma 0.45 -> mean ~3.5s
    private const float IntervalSigma = 0.45f;
    private const float MinIntervalSeconds = 1.2f;
    private const float MaxIntervalSeconds = 8f;
    // #661: blink-rate multipliers for the caller's rate argument.
    public const float TalkingRate = 1.4f;
    public const float ThinkingRate = 0.75f;
    private const float DoubleBlinkChance = 0.12f;
    private const float PartialBlinkChance = 0.1f;
    private const float CloseSeconds = 0.085f;
    private const float ClosedSeconds = 0.045f;
    private const float OpenSeconds = 0.185f;
    // No trigger-forced blink within this long of the last one ending.
    private const float RefractorySeconds = 0.6f;

    private readonly Random random;
    // double, not float: the launcher runs for days, and a float clock loses
    // the few-ms resolution a blink needs.
    private double nextBlinkAt = double.NaN;
    private double blinkStart = double.NaN; // NaN = not blinking
    private double lastBlinkEnd = double.NegativeInfinity;
    private float close, closed, open, depth;
    private bool isSecondOfDouble;

    // seed: null (every real call site) uses genuine randomness; tests pass
    // a fixed seed so the schedule is reproducible.
    public EyeBlink(int? seed = null)
    {
        random = seed is { } s ? new Random(s) : new Random();
    }

    // 1 = fully open, 0 = fully closed, at nowSeconds (monotonic). rate
    // scales how often she blinks (TalkingRate, ThinkingRate; 1 = at rest).
    public float Openness(double nowSeconds, float rate = 1f)
    {
        if (double.IsNaN(nextBlinkAt))
        {
            nextBlinkAt = nowSeconds + NextIntervalSeconds(random, rate);
        }
        if (double.IsNaN(blinkStart))
        {
            if (nowSeconds < nextBlinkAt)
            {
                return 1f;
            }
            StartBlink(nowSeconds);
        }

        var t = (float)(nowSeconds - blinkStart);
        if (t < close)
        {
            var p = t / close;
            return 1f - ((1f - depth) * p * p); // ease-in: accelerating close
        }
        if (t < close + closed)
        {
            return depth;
        }
        if (t < close + closed + open)
        {
            var q = 1f - ((t - close - closed) / open);
            return depth + ((1f - depth) * (1f - (q * q))); // ease-out: decelerating open
        }

        lastBlinkEnd = blinkStart + close + closed + open;
        blinkStart = double.NaN;
        var doubleBlink = !isSecondOfDouble && random.NextDouble() < DoubleBlinkChance;
        isSecondOfDouble = doubleBlink;
        nextBlinkAt = Math.Max(nowSeconds, lastBlinkEnd) + (doubleBlink
            ? 0.25 + (random.NextDouble() * 0.15)
            : NextIntervalSeconds(random, rate));
        return 1f;
    }

    // Blink now (at the next Openness call) unless one is under way or one
    // just ended.
    public void Trigger(double nowSeconds)
    {
        if (double.IsNaN(blinkStart) && nowSeconds - lastBlinkEnd >= RefractorySeconds)
        {
            nextBlinkAt = nowSeconds;
        }
    }

    internal static float NextIntervalSeconds(Random random, float rate)
    {
        // Box-Muller normal -> log-normal.
        var u1 = 1.0 - random.NextDouble();
        var z = Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2.0 * Math.PI * random.NextDouble());
        var seconds = (float)Math.Clamp(MedianIntervalSeconds * Math.Exp(IntervalSigma * z), MinIntervalSeconds, MaxIntervalSeconds);
        return rate > 0 ? seconds / rate : seconds;
    }

    private void StartBlink(double nowSeconds)
    {
        blinkStart = nowSeconds;
        close = Jitter(CloseSeconds);
        closed = Jitter(ClosedSeconds);
        open = Jitter(OpenSeconds);
        depth = random.NextDouble() < PartialBlinkChance ? 0.3f + ((float)random.NextDouble() * 0.2f) : 0f;
    }

    private float Jitter(float seconds) => seconds * (0.85f + ((float)random.NextDouble() * 0.3f));
}
