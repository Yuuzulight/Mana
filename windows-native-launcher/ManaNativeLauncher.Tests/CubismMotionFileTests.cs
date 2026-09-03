using System;
using System.IO;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismMotionFileTests
{
    private static string WriteFixture(string dir, string motion3Json)
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "test.motion3.json");
        File.WriteAllText(path, motion3Json);
        return path;
    }

    private static CubismModel LoadTestModel()
    {
        CubismCoreLibrary.IsAvailable(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var model3JsonPath = Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
        var settings = CubismModelSettings.Load(model3JsonPath);
        return CubismModel.Load(settings);
    }

    // #515: hiyori_free_t08.model3.json genuinely declares an Idle motion
    // group (unlike its Expressions, which don't exist -- see #514's own
    // tests) -- verified end to end against that real file.
    [CubismAvailableFact]
    public void Load_ParsesTheRealFirstHiyoriIdleMotion()
    {
        var model3JsonPath = Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
        var settings = CubismModelSettings.Load(model3JsonPath);

        Assert.NotNull(settings.IdleMotionPath);
        Assert.EndsWith("hiyori_m01.motion3.json", settings.IdleMotionPath);

        var motion = CubismMotionFile.Load(settings.IdleMotionPath!);

        Assert.Equal(4.7f, motion.Duration, 2);
        Assert.True(motion.Loop);
    }

    [CubismAvailableFact]
    public void ApplyTo_TheRealIdleMotionDeformsTheModelAtItsStartingFrame()
    {
        var model3JsonPath = Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
        var settings = CubismModelSettings.Load(model3JsonPath);
        var motion = CubismMotionFile.Load(settings.IdleMotionPath!);
        using var model = LoadTestModel();
        model.Update();

        // ParamAngleX's curve starts at (t=0, v=-8) in the real file --
        // confirms Load parsed real segment data (not an empty/garbage
        // curve list) and ApplyTo actually writes it at t=0.
        motion.ApplyTo(model, 0f);

        Assert.Equal(-8f, model.GetParameterCurrentValue("ParamAngleX"), 2);
    }

    [CubismAvailableFact]
    public void ApplyTo_LinearSegmentInterpolatesBetweenItsTwoPoints()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-motion-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "Version": 3,
                  "Meta": { "Duration": 2.0, "Fps": 30, "Loop": true },
                  "Curves": [
                    { "Target": "Parameter", "Id": "ParamMouthOpenY", "Segments": [0, 0, 0, 1.0, 10] }
                  ]
                }
                """);
            var motion = CubismMotionFile.Load(path);
            using var model = LoadTestModel();
            model.Update();

            motion.ApplyTo(model, 0f);
            Assert.Equal(0f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);

            motion.ApplyTo(model, 0.5f);
            Assert.Equal(5f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);

            motion.ApplyTo(model, 1.0f);
            Assert.Equal(10f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // Distinguishes real cubic-Bezier evaluation from an accidental
    // fallback to linear interpolation: with overshooting control points
    // (p0=0, c1=c2=20, end=10), a LINEAR interpolation at ratio=0.5 would
    // give 5 (the midpoint of 0 and 10), but the real cubic Bezier formula
    // -- 0.125*p0 + 0.375*c1 + 0.375*c2 + 0.125*end -- gives 16.25
    // (hand-computed). If EvaluateBezier's control-point reads (c1Value/
    // c2Value at the wrong array offsets) ever regressed to ignoring the
    // control points, this test would catch it where the boundary-only
    // real-file test (ratio=0, collapses to p0) cannot.
    [CubismAvailableFact]
    public void ApplyTo_BezierSegmentUsesBothControlPointsNotJustLinearInterpolation()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-motion-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "Version": 3,
                  "Meta": { "Duration": 2.0, "Fps": 30, "Loop": true },
                  "Curves": [
                    { "Target": "Parameter", "Id": "ParamMouthOpenY", "Segments": [0, 0, 1, 0.33, 20, 0.67, 20, 1.0, 10] }
                  ]
                }
                """);
            var motion = CubismMotionFile.Load(path);
            using var model = LoadTestModel();
            model.Update();

            motion.ApplyTo(model, 0.5f);

            Assert.Equal(16.25f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [CubismAvailableFact]
    public void ApplyTo_SteppedSegmentHoldsThePreviousValueThenJumpsAtItsTime()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-motion-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "Version": 3,
                  "Meta": { "Duration": 2.0, "Fps": 30, "Loop": true },
                  "Curves": [
                    { "Target": "Parameter", "Id": "ParamMouthOpenY", "Segments": [0, 5, 2, 1.0, 20] }
                  ]
                }
                """);
            var motion = CubismMotionFile.Load(path);
            using var model = LoadTestModel();
            model.Update();

            motion.ApplyTo(model, 0.9f);
            Assert.Equal(5f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);

            motion.ApplyTo(model, 1.0f);
            Assert.Equal(20f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [CubismAvailableFact]
    public void ApplyTo_InverseSteppedSegmentJumpsImmediatelyThenHoldsUntilItsTime()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-motion-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "Version": 3,
                  "Meta": { "Duration": 2.0, "Fps": 30, "Loop": true },
                  "Curves": [
                    { "Target": "Parameter", "Id": "ParamMouthOpenY", "Segments": [0, 5, 3, 1.0, 20] }
                  ]
                }
                """);
            var motion = CubismMotionFile.Load(path);
            using var model = LoadTestModel();
            model.Update();

            // Unlike Stepped above, InverseStepped shows the JUMPED-TO
            // value for the whole span leading up to `time`, not the
            // pre-segment value.
            motion.ApplyTo(model, 0.1f);
            Assert.Equal(20f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);

            motion.ApplyTo(model, 1.0f);
            Assert.Equal(20f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [CubismAvailableFact]
    public void ApplyTo_LoopsBackToTheStartPastDuration()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-motion-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "Version": 3,
                  "Meta": { "Duration": 2.0, "Fps": 30, "Loop": true },
                  "Curves": [
                    { "Target": "Parameter", "Id": "ParamMouthOpenY", "Segments": [0, 0, 0, 2.0, 10] }
                  ]
                }
                """);
            var motion = CubismMotionFile.Load(path);
            using var model = LoadTestModel();
            model.Update();

            // t=2.5 loops to t=0.5 within a [0,10] linear ramp over 2s.
            motion.ApplyTo(model, 2.5f);

            Assert.Equal(2.5f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [CubismAvailableFact]
    public void ApplyTo_SkipsAParameterTheModelDoesNotHaveInsteadOfThrowing()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-motion-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "Version": 3,
                  "Meta": { "Duration": 1.0, "Fps": 30, "Loop": true },
                  "Curves": [
                    { "Target": "Parameter", "Id": "ThisParameterDoesNotExist", "Segments": [0, 0, 0, 1.0, 10] }
                  ]
                }
                """);
            var motion = CubismMotionFile.Load(path);
            using var model = LoadTestModel();
            model.Update();

            var exception = Record.Exception(() => motion.ApplyTo(model, 0.5f));

            Assert.Null(exception);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [CubismAvailableFact]
    public void ApplyTo_IgnoresNonParameterTargetCurves()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-motion-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "Version": 3,
                  "Meta": { "Duration": 1.0, "Fps": 30, "Loop": true },
                  "Curves": [
                    { "Target": "PartOpacity", "Id": "PartArmL", "Segments": [0, 1, 0, 1.0, 0] }
                  ]
                }
                """);
            var motion = CubismMotionFile.Load(path);
            using var model = LoadTestModel();
            model.Update();

            // Just confirms this doesn't throw trying to treat a
            // PartOpacity curve as a Parameter one -- there's no
            // parameter-side observable for a skipped Part curve to assert
            // against.
            var exception = Record.Exception(() => motion.ApplyTo(model, 0.5f));

            Assert.Null(exception);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
