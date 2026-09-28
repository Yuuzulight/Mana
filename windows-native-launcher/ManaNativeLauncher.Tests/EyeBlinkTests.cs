using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #683: pure timing -- no Cubism Core needed.
public class EyeBlinkTests
{
    private const double Frame = 1.0 / 240.0;

    private sealed record Blink(double Start, double End, float MinOpenness);

    // Runs the blink for `seconds` at 240fps and returns each blink seen.
    private static List<Blink> Simulate(EyeBlink blink, double seconds, float rate = 1f, double from = 0)
    {
        var blinks = new List<Blink>();
        double? start = null;
        var min = 1f;
        for (var t = from; t < from + seconds; t += Frame)
        {
            var v = blink.Openness(t, rate);
            if (v < 1f)
            {
                start ??= t;
                min = Math.Min(min, v);
            }
            else if (start is { } s)
            {
                blinks.Add(new Blink(s, t, min));
                start = null;
                min = 1f;
            }
        }
        return blinks;
    }

    [Fact]
    public void NextInterval_IsLogNormalIsh_WithinBounds_MeanAroundThreeAndAHalfSeconds()
    {
        var random = new Random(1);
        var samples = Enumerable.Range(0, 20000).Select(_ => EyeBlink.NextIntervalSeconds(random, 1f)).ToList();

        Assert.All(samples, s => Assert.InRange(s, 1.2f, 8f));
        Assert.InRange(samples.Average(), 3.2, 3.9);
        // Skewed: the median sits below the mean, and long stares are rare.
        var sorted = samples.Order().ToList();
        Assert.True(sorted[sorted.Count / 2] < samples.Average());
        Assert.True(samples.Count(s => s > 6.5f) < samples.Count * 0.08);
    }

    [Fact]
    public void Talking_BlinksAboutFortyPercentMoreOften()
    {
        var random = new Random(2);
        var rest = Enumerable.Range(0, 20000).Average(_ => EyeBlink.NextIntervalSeconds(random, 1f));
        var talk = Enumerable.Range(0, 20000).Average(_ => EyeBlink.NextIntervalSeconds(random, EyeBlink.TalkingRate));

        Assert.InRange(rest / talk, 1.3, 1.5);
    }

    [Fact]
    public void Blinks_CloseFastAndOpenSlower_Monotonically()
    {
        var blink = new EyeBlink(seed: 3);
        var t = 0.0;
        while (blink.Openness(t) == 1f)
        {
            t += Frame;
        }
        var values = new List<(double T, float V)>();
        for (; values.Count == 0 || values[^1].V < 1f; t += 0.001)
        {
            values.Add((t, blink.Openness(t)));
        }

        var minValue = values.Min(x => x.V);
        var minIndex = values.FindIndex(v => v.V == minValue);
        var closing = values.Take(minIndex + 1).ToList();
        var opening = values.Skip(minIndex).ToList();
        Assert.True(closing.Zip(closing.Skip(1)).All(p => p.Second.V <= p.First.V), "closing must be monotone");
        Assert.True(opening.Zip(opening.Skip(1)).All(p => p.Second.V >= p.First.V), "opening must be monotone");

        var closeDuration = closing[^1].T - closing[0].T;
        var total = values[^1].T - values[0].T;
        Assert.InRange(total, 0.2, 0.45); // ~85ms close + 45ms shut + 185ms open, +-15%
        Assert.True(total - closeDuration > closeDuration * 1.5, "opening (incl. hold) should take clearly longer than closing");

        // Ease-in close: the first half of the closing time covers less than
        // half of the travel.
        var halfway = closing.First(v => v.T - closing[0].T >= closeDuration / 2);
        Assert.True(halfway.V > 0.6f, $"closing should accelerate, was {halfway.V} at halfway");
    }

    [Fact]
    public void OverManySeeds_DoubleAndPartialBlinkRatesAreNearTheirTargets()
    {
        var gaps = new List<double>();
        var partial = 0;
        var total = 0;
        for (var seed = 0; seed < 40; seed++)
        {
            var blinks = Simulate(new EyeBlink(seed), 120);
            total += blinks.Count;
            partial += blinks.Count(b => b.MinOpenness > 0.2f);
            gaps.AddRange(blinks.Zip(blinks.Skip(1)).Select(p => p.Second.Start - p.First.End));
        }

        // ~15-20 blinks/min at rest.
        Assert.InRange(total / 80.0, 13, 22);
        var doubles = gaps.Count(g => g < 0.5);
        Assert.InRange((double)doubles / gaps.Count, 0.07, 0.18);
        Assert.InRange((double)partial / total, 0.05, 0.16);
        // Outside double blinks, never closer than the 1.2s floor.
        Assert.All(gaps.Where(g => g >= 0.5), g => Assert.True(g >= 1.19, $"gap {g}"));
    }

    [Fact]
    public void Trigger_StartsABlinkNow_ButNotRightAfterAnother()
    {
        var blink = new EyeBlink(seed: 4);
        blink.Openness(0);
        blink.Trigger(0.5);
        blink.Openness(0.5);
        Assert.True(blink.Openness(0.5 + 0.05) < 1f, "a triggered blink starts immediately");

        // Let it finish, then trigger again inside the refractory window.
        var t = 0.55;
        while (blink.Openness(t) < 1f)
        {
            t += Frame;
        }
        blink.Trigger(t + 0.1);
        Assert.Equal(1f, blink.Openness(t + 0.15));
    }

    [Fact]
    public void AfterALongStall_DoesNotBunchUpBlinks()
    {
        var blink = new EyeBlink(seed: 5);
        blink.Openness(0);

        // Window hidden for ten minutes, then rendering resumes.
        var blinks = Simulate(blink, 1.0, from: 600);

        Assert.InRange(blinks.Count, 0, 2); // at most one, plus its double
    }
}
