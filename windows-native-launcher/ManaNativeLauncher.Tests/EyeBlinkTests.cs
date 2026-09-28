using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #683: pure timing -- no Cubism Core needed.
public class EyeBlinkTests
{
    private static List<float> Sample(EyeBlink blink, float seconds, float step = 1f / 60f)
    {
        var values = new List<float>();
        for (var t = 0f; t < seconds; t += step)
        {
            values.Add(blink.Openness(t));
        }
        return values;
    }

    [Fact]
    public void Openness_StaysWithinZeroToOne_AndBlinksRepeatedly()
    {
        var values = Sample(new EyeBlink(seed: 1), 60f);

        Assert.All(values, v => Assert.InRange(v, 0f, 1f));
        // A blink = a run of fully-closed frames. Mean interval ~3.5s, so a
        // minute has well over a handful.
        var blinks = values.Zip(values.Skip(1)).Count(pair => pair.First > 0f && pair.Second == 0f);
        Assert.InRange(blinks, 6, 40);
        Assert.True(values.Count(v => v == 1f) > values.Count * 0.8, "eyes should be open most of the time");
    }

    [Fact]
    public void Openness_ClosesThenReopensWithinABlinkDuration()
    {
        var blink = new EyeBlink(seed: 3);
        var t = 0f;
        while (blink.Openness(t) == 1f)
        {
            t += 0.001f;
        }
        var closeStart = t;
        while (blink.Openness(t) < 1f)
        {
            t += 0.001f;
        }

        Assert.InRange(t - closeStart, 0.25f, 0.35f); // 0.1 closing + 0.05 closed + 0.15 opening
    }

    [Fact]
    public void Openness_AfterALongStall_DoesNotBunchUpBlinks()
    {
        var blink = new EyeBlink(seed: 5);
        blink.Openness(0f);

        // Window hidden for ten minutes, then rendering resumes.
        var values = new List<float>();
        for (var t = 600f; t < 601f; t += 1f / 60f)
        {
            values.Add(blink.Openness(t));
        }

        var blinks = values.Zip(values.Skip(1)).Count(pair => pair.First > 0f && pair.Second == 0f);
        Assert.InRange(blinks, 0, 1);
    }
}
