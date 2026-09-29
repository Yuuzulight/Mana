namespace Mana.NativeLauncher.Live2D;

// #683: auto-blink (Electron gets one for free through pixi-live2d-display's
// CubismEyeBlink -- windows-launcher/avatar/live2d-avatar.js ~157-160),
// shaped after human blink figures rather than Cubism's uniform timer:
// - Rate: log-normal around ~3.8s, more often in conversation (Bentivoglio
//   et al. 1997: ~1.4x while talking; #661: less often while thinking or
//   concentrating -- the caller passes the rate), always 2.5-6s apart
//   (Q6, the Neuro-style tuning of 2026-09-29).
// - Shape: 120-220ms in all (Q6), slower (x1.6) when she's sleepy; the lid
//   closes fast and accelerating, holds briefly, and opens more slowly,
//   decelerating (VanderWerf et al. 2003: closing ~2x faster than opening).
// - ~13.5% are double blinks, the second 250-700ms after the first (Q6);
//   ~10% are partial (lid stops 30-50% open).
// - Trigger() lets a large gaze shift or the start of speech pull the next
//   blink forward (gaze-evoked blinks, Evinger et al. 1994).
// Openness() is a 0..1 factor the caller MULTIPLIES into the eye-open
// parameters after the motion and expression have set them, so it composes
// with both: a motion's baked blink or an expression's half-closed eyes stay
// as they are, a blink just closes them the rest of the way.
internal sealed class EyeBlink
{
    private const float MedianIntervalSeconds = 3.8f; // log-normal, sigma 0.25 -> mean ~3.9s
    private const float IntervalSigma = 0.25f;
    private const float MinIntervalSeconds = 2.5f;
    private const float MaxIntervalSeconds = 6f;
    // #661: blink-rate multipliers for the caller's rate argument.
    public const float TalkingRate = 1.4f;
    public const float ThinkingRate = 0.75f;
    private const float DoubleBlinkChance = 0.135f;
    private const float PartialBlinkChance = 0.1f;
    // A blink's length and how it splits: close / shut / open.
    private const float MinBlinkSeconds = 0.12f;
    private const float MaxBlinkSeconds = 0.22f;
    private const float CloseShare = 0.27f;
    private const float ClosedShare = 0.15f;
    private const float SleepySlowdown = 1.6f;
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
    // scales how often she blinks (TalkingRate, ThinkingRate; 1 = at rest);
    // sleepy makes the blinks that start now slower.
    public float Openness(double nowSeconds, float rate = 1f, bool sleepy = false)
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
            StartBlink(nowSeconds, sleepy);
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
            ? 0.25 + (random.NextDouble() * 0.45)
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
        var seconds = (float)(MedianIntervalSeconds * Math.Exp(IntervalSigma * z));
        return Math.Clamp(rate > 0 ? seconds / rate : seconds, MinIntervalSeconds, MaxIntervalSeconds);
    }

    // Q6: a closed-eye "^^" smile only with a happy/excited emotion tag,
    // held 0.5-3s.
    public static bool IsSmileTag(string? emotionTag) => emotionTag is "happy" or "excited";

    public static double ClosedSmileSeconds(Random random) => 0.5 + (random.NextDouble() * 2.5);

    private void StartBlink(double nowSeconds, bool sleepy)
    {
        blinkStart = nowSeconds;
        var total = (MinBlinkSeconds + ((float)random.NextDouble() * (MaxBlinkSeconds - MinBlinkSeconds))) * (sleepy ? SleepySlowdown : 1f);
        close = total * CloseShare;
        closed = total * ClosedShare;
        open = total - close - closed;
        depth = random.NextDouble() < PartialBlinkChance ? 0.3f + ((float)random.NextDouble() * 0.2f) : 0f;
    }
}
