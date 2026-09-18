using System;
using System.Collections.Generic;
using System.IO;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ProceduralIdleMotionTests
{
    // Same real-model/Cubism-Core dependency as CubismModelTests -- see
    // that file's own comment for why this is optional/gitignored and
    // skips gracefully rather than failing CI elsewhere.
    private static readonly string Model3JsonPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..",
        "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");

    private static CubismModel LoadTestModel()
    {
        CubismCoreLibrary.IsAvailable(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var settings = CubismModelSettings.Load(Model3JsonPath);
        return CubismModel.Load(settings);
    }

    [CubismAvailableFact]
    public void ApplyTo_MovesParametersOverTime_NotFrozen()
    {
        using var model = LoadTestModel();
        var idle = new ProceduralIdleMotion(seed: 1);

        idle.ApplyTo(model, 0f);
        var first = Snapshot(model);
        idle.ApplyTo(model, 4f); // past MinSegmentSeconds, so at least one parameter should have retargeted
        var second = Snapshot(model);

        Assert.NotEqual(first, second);
    }

    [CubismAvailableFact]
    public void ApplyTo_NeverExceedsTheParametersOwnDeclaredRange()
    {
        using var model = LoadTestModel();
        var idle = new ProceduralIdleMotion(seed: 2);

        // Sweep across many segment boundaries (segments are 2.5-5.5s) to
        // exercise both mid-segment interpolation and multiple retargets.
        for (var t = 0f; t < 30f; t += 0.5f)
        {
            idle.ApplyTo(model, t);
        }

        foreach (var id in model.ParameterIds)
        {
            var min = model.GetParameterMinValue(id);
            var max = model.GetParameterMaxValue(id);
            if (max - min <= 0)
            {
                continue; // degenerate parameter, ProceduralIdleMotion skips these too
            }
            var value = model.GetParameterCurrentValue(id);
            Assert.True(value >= min && value <= max, $"{id}: {value} outside [{min}, {max}]");
        }
    }

    [CubismAvailableFact]
    public void ApplyTo_StartsNearEachParametersDefaultValue()
    {
        using var model = LoadTestModel();
        var idle = new ProceduralIdleMotion(seed: 3);

        idle.ApplyTo(model, 0f);

        foreach (var id in model.ParameterIds)
        {
            var range = model.GetParameterMaxValue(id) - model.GetParameterMinValue(id);
            if (range <= 0)
            {
                continue;
            }
            var defaultValue = model.GetParameterDefaultValue(id);
            var value = model.GetParameterCurrentValue(id);
            // At t=0 (the very start of the first segment), the eased
            // interpolation factor is 0, so the value must be exactly the
            // segment's FromValue -- which the first call seeds to each
            // parameter's own default. A generous tolerance here would
            // hide a real bug in that seeding, so this checks equality
            // via the same float type the model itself stores.
            Assert.Equal(defaultValue, value);
        }
    }

    [CubismAvailableFact]
    public void ApplyTo_IsDeterministicGivenTheSameSeed()
    {
        using var modelA = LoadTestModel();
        using var modelB = LoadTestModel();
        var idleA = new ProceduralIdleMotion(seed: 42);
        var idleB = new ProceduralIdleMotion(seed: 42);

        for (var t = 0f; t < 10f; t += 0.7f)
        {
            idleA.ApplyTo(modelA, t);
            idleB.ApplyTo(modelB, t);
        }

        Assert.Equal(Snapshot(modelA), Snapshot(modelB));
    }

    private static string Snapshot(CubismModel model)
    {
        var parts = new List<string>();
        foreach (var id in model.ParameterIds)
        {
            parts.Add($"{id}={model.GetParameterCurrentValue(id):F6}");
        }
        return string.Join("|", parts);
    }
}
