using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #683: pure easing/scheduling math -- no Cubism Core needed.
public class IdleGazeTests
{
    [Fact]
    public void Blend_FadesInWhileIdle_AndOutWhenNot()
    {
        var gaze = new IdleGaze(seed: 1);

        for (var i = 0; i < 180; i++)
        {
            gaze.Update(16f, idle: true);
        }
        Assert.True(gaze.Blend > 0.95f);

        for (var i = 0; i < 180; i++)
        {
            gaze.Update(16f, idle: false);
        }
        Assert.True(gaze.Blend < 0.05f);
        Assert.True(Math.Abs(gaze.AngleXOffset) < 0.05f * IdleGaze.DefaultGazeDegrees);
    }

    [Fact]
    public void Saccades_MoveTheEyesAndHead_WithinTheConfiguredAmplitude()
    {
        var gaze = new IdleGaze(gazeDegrees: 6f, seed: 2);
        var eyeXs = new HashSet<float>();

        for (var i = 0; i < 60 * 30; i++)
        {
            gaze.Update(16f, idle: true);
            Assert.InRange(gaze.AngleX, -6f, 6f);
            Assert.InRange(gaze.EyeBallX, -1f, 1f);
            Assert.InRange(gaze.EyeBallY, -0.7f, 0.7f);
            eyeXs.Add(MathF.Round(gaze.EyeBallX, 1));
        }

        Assert.True(eyeXs.Count > 5, "eyes should look around over 30s of idle");
    }

    [Fact]
    public void ZeroGaze_NeverMovesTheEyes()
    {
        var gaze = new IdleGaze(gazeDegrees: 0f, seed: 3);

        for (var i = 0; i < 600; i++)
        {
            gaze.Update(16f, idle: true);
        }

        Assert.False(gaze.GazeActive);
        Assert.Equal(0f, gaze.EyeBallXOffset);
        Assert.Equal(0f, gaze.AngleXOffset);
    }

    [Fact]
    public void Tilt_ClampsPitchAndEasesRoll_ScaledByBlend()
    {
        var gaze = new IdleGaze(tiltDegrees: 16f, maxPitchDegrees: 8f, seed: 4);

        // Not idle yet: blend 0, raw values pass through untouched.
        Assert.Equal(-25f, gaze.ApplyPitch(-25f));
        Assert.Equal(3f, gaze.ApplyRoll(3f));

        for (var i = 0; i < 300; i++)
        {
            gaze.Update(16f, idle: true);
        }

        Assert.Equal(-8f, gaze.ApplyPitch(-25f), 0.1f);
        Assert.Equal(5f, gaze.ApplyPitch(5f), 0.001f); // in range: unchanged
        Assert.Equal(16f, gaze.ApplyRoll(3f), 0.1f);
    }

    [Fact]
    public void TiltOptOut_MatchesElectronsConvention()
    {
        Assert.False(new IdleGaze(tiltDegrees: 0f, maxPitchDegrees: 90f).TiltActive);
        Assert.True(new IdleGaze(tiltDegrees: 0f, maxPitchDegrees: 8f).TiltActive);
    }

    [Fact]
    public void SmoothToward_IsFrameRateIndependentAndNeverOvershoots()
    {
        Assert.Equal(10f, IdleGaze.SmoothToward(0f, 10f, 1000f, 500f));
        Assert.Equal(5f, IdleGaze.SmoothToward(0f, 10f, 250f, 500f), 0.001f);
    }
}
