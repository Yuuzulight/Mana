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
    public void NextInterval_IsLogNormalIsh_Within2Point5To6Seconds()
    {
        var random = new Random(1);
        var samples = Enumerable.Range(0, 20000).Select(_ => EyeBlink.NextIntervalSeconds(random, 1f)).ToList();

        Assert.All(samples, s => Assert.InRange(s, 2.5f, 6f));
        Assert.InRange(samples.Average(), 3.7, 4.2);
        // Centred near 3.8s, and long stares are rare.
        var sorted = samples.Order().ToList();
        Assert.InRange(sorted[sorted.Count / 2], 3.6f, 4.0f);
        Assert.True(samples.Count(s => s > 5.5f) < samples.Count * 0.1);
    }

    [Fact]
    public void Talking_BlinksMoreOften_ThinkingLess_StillWithin2Point5To6Seconds()
    {
        var random = new Random(2);
        var rest = Enumerable.Range(0, 20000).Select(_ => EyeBlink.NextIntervalSeconds(random, 1f)).ToList();
        var talk = Enumerable.Range(0, 20000).Select(_ => EyeBlink.NextIntervalSeconds(random, EyeBlink.TalkingRate)).ToList();
        var think = Enumerable.Range(0, 20000).Select(_ => EyeBlink.NextIntervalSeconds(random, EyeBlink.ThinkingRate)).ToList();

        Assert.InRange(rest.Average() / talk.Average(), 1.2, 1.5);
        Assert.True(think.Average() > rest.Average());
        Assert.All(talk.Concat(think), s => Assert.InRange(s, 2.5f, 6f));
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
        Assert.InRange(total, 0.115, 0.23); // Q6: 120-220ms
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

        // ~13-17 blinks/min at rest (doubles included).
        Assert.InRange(total / 80.0, 12, 19);
        // Q6: 12-15% doubles, the second 250-700ms after the first.
        var doubles = gaps.Where(g => g < 1.0).ToList();
        Assert.InRange((double)doubles.Count / gaps.Count, 0.09, 0.18);
        Assert.All(doubles, g => Assert.InRange(g, 0.24, 0.71));
        Assert.InRange((double)partial / total, 0.05, 0.16);
        // Outside double blinks, never closer than the 2.5s floor.
        Assert.All(gaps.Where(g => g >= 1.0), g => Assert.True(g >= 2.49, $"gap {g}"));
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

    // Q6: sleepy blinks are slower (x1.6).
    [Fact]
    public void SleepyBlinks_AreSlower()
    {
        static double Length(bool sleepy, int seed)
        {
            var blink = new EyeBlink(seed);
            var t = 0.0;
            while (blink.Openness(t, 1f, sleepy) == 1f)
            {
                t += Frame;
            }
            var start = t;
            while (blink.Openness(t, 1f, sleepy) < 1f)
            {
                t += Frame;
            }
            return t - start;
        }

        Assert.InRange(Length(sleepy: true, 5), 0.19, 0.36);
        Assert.InRange(Length(sleepy: true, 5) / Length(sleepy: false, 5), 1.5, 1.7);
    }

    // Q6: the "^^" smile only for happy/excited tags, 0.5-3s.
    [Theory]
    [InlineData("happy", true)]
    [InlineData("excited", true)]
    [InlineData("wink", false)]
    [InlineData("surprised", false)]
    [InlineData(null, false)]
    public void ClosedSmile_OnlyForHappyOrExcitedTags(string? tag, bool expected) =>
        Assert.Equal(expected, EyeBlink.IsSmileTag(tag));

    [Fact]
    public void ClosedSmile_LastsHalfASecondToThreeSeconds()
    {
        var random = new Random(9);
        var samples = Enumerable.Range(0, 2000).Select(_ => EyeBlink.ClosedSmileSeconds(random)).ToList();
        Assert.All(samples, s => Assert.InRange(s, 0.5, 3.0));
        Assert.True(samples.Max() - samples.Min() > 2.0);
    }
}
