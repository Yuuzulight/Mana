using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #683: pure easing/scheduling math -- no Cubism Core needed.
public class AvatarGazeTests
{
    private const float Frame = 1000f / 240f;

    // Advances until the next saccade starts; returns whether it asked for a blink.
    private static bool NextSaccade(AvatarGaze gaze, GazeMode mode = GazeMode.Idle)
    {
        var count = gaze.SaccadeCount;
        var wantsBlink = false;
        while (gaze.SaccadeCount == count)
        {
            wantsBlink = gaze.Update(Frame, mode);
        }
        return wantsBlink;
    }

    private static bool IsHome(AvatarGaze gaze) => Math.Abs(gaze.TargetX) <= 0.08f && Math.Abs(gaze.TargetY) <= 0.06f;

    [Fact]
    public void Eyes_JumpFast_ThenHoldWithOnlyTinyDrift()
    {
        var gaze = new AvatarGaze(seed: 1);
        gaze.Update(Frame, GazeMode.Idle);
        // Find a big jump so "fast" is measurable.
        float fromX;
        do
        {
            fromX = gaze.EyeBallX;
            NextSaccade(gaze);
        }
        while (Math.Abs(gaze.TargetX - fromX) < 0.5f);

        var distance = gaze.TargetX - fromX;
        var elapsed = 0f;
        while (Math.Abs(gaze.TargetX - gaze.EyeBallX) > 0.1f * Math.Abs(distance) + 0.035f)
        {
            gaze.Update(Frame, GazeMode.Idle);
            elapsed += Frame;
        }
        Assert.InRange(elapsed, 10f, 90f); // there in ~40-80ms, not a 500ms glide

        // Fixation: once the jump has landed (<= 80ms), the eyes stay within
        // drift range until the next saccade (idle fixations are >= 800ms).
        for (var t = elapsed; t < 90f; t += Frame)
        {
            gaze.Update(Frame, GazeMode.Idle);
        }
        var count = gaze.SaccadeCount;
        for (var i = 0; i < 120 && gaze.SaccadeCount == count; i++)
        {
            gaze.Update(Frame, GazeMode.Idle);
            if (gaze.SaccadeCount == count)
            {
                Assert.InRange(gaze.EyeBallX - gaze.TargetX, -0.04f, 0.04f);
            }
        }
    }

    [Fact]
    public void Head_LagsTheEyes_AndCoversOnlyPartOfTheTurn()
    {
        var gaze = new AvatarGaze(gazeDegrees: 6f, seed: 2);
        gaze.Update(Frame, GazeMode.Idle);
        float headBefore;
        do
        {
            NextSaccade(gaze);
            headBefore = gaze.HeadAngleX;
        }
        while (Math.Abs(gaze.HeadTargetX - headBefore) < 2f);

        // First ~80ms: eyes are well under way, head hasn't moved.
        for (var t = 0f; t < 75f; t += Frame)
        {
            gaze.Update(Frame, GazeMode.Idle);
        }
        Assert.Equal(headBefore, gaze.HeadAngleX, 0.01f);

        // By ~650ms (150ms lag + 500ms move) it has arrived.
        for (var t = 75f; t < 660f; t += Frame)
        {
            gaze.Update(Frame, GazeMode.Idle);
        }
        Assert.Equal(gaze.HeadTargetX, gaze.HeadAngleX, 0.05f);
        Assert.True(Math.Abs(gaze.HeadTargetX) <= 6f * Math.Abs(gaze.TargetX) + 0.001f);
        Assert.True(Math.Abs(gaze.HeadTargetX) >= 0.6f * 6f * Math.Abs(gaze.TargetX) - 0.001f);
    }

    [Fact]
    public void MostGlances_ReturnHome_MoreSoWhileTalking_AndOffHomeGlancesLeanDown()
    {
        var idle = new AvatarGaze(seed: 3);
        var idleHome = 0;
        var offHomeY = new List<float>();
        var offHomeX = new List<float>();
        for (var i = 0; i < 2000; i++)
        {
            NextSaccade(idle);
            if (IsHome(idle))
            {
                idleHome++;
            }
            else
            {
                offHomeY.Add(idle.TargetY);
                offHomeX.Add(idle.TargetX);
            }
        }
        Assert.InRange(idleHome / 2000.0, 0.5, 0.6);
        Assert.True(offHomeY.Average() < 0, "look-away glances should lean downward");
        Assert.True(offHomeY.Average(y => Math.Abs(y)) < offHomeX.Average(x => Math.Abs(x)), "vertical glances should be smaller");
        Assert.True(offHomeY.Max() <= 0.25f && offHomeY.Min() >= -0.5f);

        var talking = new AvatarGaze(seed: 4);
        var talkingHome = 0;
        for (var i = 0; i < 2000; i++)
        {
            NextSaccade(talking, GazeMode.Talking);
            talkingHome += IsHome(talking) ? 1 : 0;
        }
        Assert.InRange(talkingHome / 2000.0, 0.75, 0.85);
    }

    [Fact]
    public void LargeShifts_AskForABlinkAboutFortyPercentOfTheTime_SmallOnesNever()
    {
        var gaze = new AvatarGaze(seed: 5);
        gaze.Update(Frame, GazeMode.Idle);
        int large = 0, largeBlinks = 0, smallBlinks = 0;
        for (var i = 0; i < 3000; i++)
        {
            var fromX = gaze.TargetX;
            var fromY = gaze.TargetY;
            var blink = NextSaccade(gaze);
            // Previous saccade has long settled by now, so its target is where the eyes were.
            var shift = MathF.Sqrt(MathF.Pow(gaze.TargetX - fromX, 2) + MathF.Pow(gaze.TargetY - fromY, 2));
            if (shift >= 0.45f)
            {
                large++;
                largeBlinks += blink ? 1 : 0;
            }
            else if (shift < 0.35f)
            {
                smallBlinks += blink ? 1 : 0;
            }
        }
        Assert.InRange((double)largeBlinks / large, 0.3, 0.5);
        Assert.Equal(0, smallBlinks);
    }

    [Fact]
    public void ZeroGaze_NeverMovesTheEyesOrHead()
    {
        var gaze = new AvatarGaze(gazeDegrees: 0f, seed: 6);

        for (var i = 0; i < 6000; i++)
        {
            Assert.False(gaze.Update(Frame, GazeMode.Idle));
        }

        Assert.False(gaze.GazeActive);
        Assert.Equal(0f, gaze.EyeBallX);
        Assert.Equal(0f, gaze.HeadAngleX);
    }

    [Fact]
    public void Tilt_ClampsPitchOnlyWhileIdle()
    {
        var gaze = new AvatarGaze(tiltDegrees: 8f, maxPitchDegrees: 8f, seed: 7);

        // Talking: the pitch clamp stays off, raw values pass through.
        for (var i = 0; i < 300; i++)
        {
            gaze.Update(16f, GazeMode.Talking);
        }
        Assert.Equal(-25f, gaze.ApplyPitch(-25f));

        for (var i = 0; i < 300; i++)
        {
            gaze.Update(16f, GazeMode.Idle);
        }
        Assert.Equal(-8f, gaze.ApplyPitch(-25f), 0.1f);
        Assert.Equal(5f, gaze.ApplyPitch(5f), 0.001f); // in range: unchanged

        for (var i = 0; i < 300; i++)
        {
            gaze.Update(16f, GazeMode.Talking);
        }
        Assert.True(gaze.TiltBlend < 0.01f);
    }

    // Q6: +-8 degrees normally, up to 16 while animated, still while busy;
    // two layered rhythms, so it isn't one repeating sine.
    [Fact]
    public void Sway_PeaksAtTheTilt_BiggerWhenAnimated_StillWhileBusy()
    {
        (float Min, float Max) Range(AvatarGaze gaze, GazeMode mode, bool animated)
        {
            for (var i = 0; i < 400; i++)
            {
                gaze.Update(16f, mode, animated); // settle the amplitude (~6s)
            }
            var values = new List<float>();
            for (var i = 0; i < 1250; i++) // 20s
            {
                gaze.Update(16f, mode, animated);
                values.Add(gaze.Sway);
            }
            return (values.Min(), values.Max());
        }

        var gaze = new AvatarGaze(tiltDegrees: 8f, animatedTiltDegrees: 16f, seed: 21);
        var (min, max) = Range(gaze, GazeMode.Talking, animated: false);
        Assert.InRange(max, 5f, 8.01f);
        Assert.InRange(min, -8.01f, -5f);
        (min, max) = Range(gaze, GazeMode.Talking, animated: true);
        Assert.InRange(max, 11f, 16.01f);
        (min, max) = Range(gaze, GazeMode.Thinking, animated: false);
        Assert.InRange(max - min, 0f, 0.2f);

        // Not a single sine: successive peaks differ in height.
        var idle = new AvatarGaze(tiltDegrees: 8f, seed: 22);
        var peaks = new List<float>();
        float a = 0, b = 0;
        for (var i = 0; i < 2500; i++)
        {
            idle.Update(16f, GazeMode.Idle);
            if (i > 120 && b > a && b > idle.Sway)
            {
                peaks.Add(b);
            }
            a = b;
            b = idle.Sway;
        }
        Assert.True(peaks.Max() - peaks.Min() > 1f, "peaks should vary between the two rhythms");
    }

    [Fact]
    public void TiltOptOut_MatchesElectronsConvention()
    {
        Assert.False(new AvatarGaze(tiltDegrees: 0f, maxPitchDegrees: 90f).TiltActive);
        Assert.True(new AvatarGaze(tiltDegrees: 0f, maxPitchDegrees: 8f).TiltActive);
    }

    // #661: Thinking looks up and aside and holds; Working looks down with
    // quick small hops; Attentive keeps her eyes on the viewer.
    [Fact]
    public void ActivityModes_LookWhereTheActivitySuggests()
    {
        var thinking = new AvatarGaze(seed: 8);
        var upAside = 0;
        for (var i = 0; i < 400; i++)
        {
            NextSaccade(thinking, GazeMode.Thinking);
            if (thinking.TargetY >= 0.4f && Math.Abs(thinking.TargetX) >= 0.35f)
            {
                upAside++;
            }
            else
            {
                Assert.True(IsHome(thinking), "thinking glances are up-aside or back at the viewer");
            }
        }
        Assert.InRange(upAside / 400.0, 0.78, 0.92);

        var working = new AvatarGaze(seed: 9);
        var down = 0;
        for (var i = 0; i < 400; i++)
        {
            NextSaccade(working, GazeMode.Working);
            down += working.TargetY <= -0.3f ? 1 : 0;
        }
        Assert.InRange(down / 400.0, 0.78, 0.92);

        var attentive = new AvatarGaze(seed: 10);
        for (var i = 0; i < 200; i++)
        {
            NextSaccade(attentive, GazeMode.Attentive);
            Assert.True(IsHome(attentive));
        }
    }

    [Fact]
    public void ThinkingHoldsLonger_WorkingHopsFaster()
    {
        static double MeanHoldMs(GazeMode mode, int seed)
        {
            var gaze = new AvatarGaze(seed: seed);
            NextSaccade(gaze, mode);
            var elapsed = 0.0;
            for (var i = 0; i < 200; i++)
            {
                var count = gaze.SaccadeCount;
                while (gaze.SaccadeCount == count)
                {
                    gaze.Update(Frame, mode);
                    elapsed += Frame;
                }
            }
            return elapsed / 200;
        }

        Assert.InRange(MeanHoldMs(GazeMode.Thinking, 11), 1500, 3200);
        Assert.InRange(MeanHoldMs(GazeMode.Working, 12), 250, 650);
    }

    [Fact]
    public void Tilt_StaysOnWhileAttentive_OffWhileThinking()
    {
        var gaze = new AvatarGaze(seed: 13);
        for (var i = 0; i < 300; i++)
        {
            gaze.Update(16f, GazeMode.Attentive);
        }
        Assert.True(gaze.TiltBlend > 0.95f);
        for (var i = 0; i < 300; i++)
        {
            gaze.Update(16f, GazeMode.Thinking);
        }
        Assert.True(gaze.TiltBlend < 0.05f);
    }

    [Fact]
    public void AttentiveLookOffset_TiltsAndLiftsOnceAfterAClick()
    {
        Assert.Equal((0f, 0f), AvatarGaze.AttentiveLookOffset(double.PositiveInfinity)); // never clicked
        Assert.Equal((0f, 0f), AvatarGaze.AttentiveLookOffset(-0.1));
        var (pitch, roll) = AvatarGaze.AttentiveLookOffset(AvatarGaze.AttentiveSeconds / 2);
        Assert.Equal(3f, pitch, 0.01f);
        Assert.Equal(7f, roll, 0.01f);
        Assert.Equal((0f, 0f), AvatarGaze.AttentiveLookOffset(AvatarGaze.AttentiveSeconds));
    }

    [Fact]
    public void NodOffset_DipsOnceAndReturns()
    {
        Assert.Equal(0f, AvatarGaze.NodOffset(-0.1));
        Assert.Equal(0f, AvatarGaze.NodOffset(0));
        Assert.Equal(-6f, AvatarGaze.NodOffset(AvatarGaze.NodSeconds / 2), 0.01f);
        Assert.Equal(0f, AvatarGaze.NodOffset(AvatarGaze.NodSeconds));
        Assert.Equal(0f, AvatarGaze.NodOffset(double.PositiveInfinity));
    }
}
