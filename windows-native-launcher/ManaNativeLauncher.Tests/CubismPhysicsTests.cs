using System;
using System.IO;
using System.Linq;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismPhysicsTests
{
    [Theory]
    // Parameter range -30..30 mapped onto -10..10; the Framework inverts unless Reflect.
    [InlineData(0f, false, 0f)]
    [InlineData(30f, false, -10f)]
    [InlineData(-30f, false, 10f)]
    [InlineData(15f, true, 5f)]
    [InlineData(99f, true, 10f)] // clamped to the parameter range first
    public void NormalizeParameterValue_MapsTheParameterRangeOntoTheNormalizationRange(float value, bool reflect, float expected)
    {
        var result = CubismPhysics.NormalizeParameterValue(value, -30f, 30f, -10f, 10f, 0f, reflect);
        Assert.Equal(expected, result, 4);
    }

    [Fact]
    public void CubismModelSettings_ReadsThePhysicsReference()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-physics-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var path = Path.Combine(dir, "m.model3.json");
            File.WriteAllText(path, """{"FileReferences":{"Moc":"m.moc3","Textures":["t.png"],"Physics":"m.physics3.json"}}""");
            Assert.Equal(Path.Combine(dir, "m.physics3.json"), CubismModelSettings.Load(path).PhysicsPath);
            File.WriteAllText(path, """{"FileReferences":{"Moc":"m.moc3","Textures":["t.png"]}}""");
            Assert.Null(CubismModelSettings.Load(path).PhysicsPath);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // End to end against the real hiyori_pro: turning her head swings the front hair, and it settles
    // back to rest once the head straightens.
    [HiyoriProAvailableFact]
    public void Evaluate_SwingsHiyoriProsHairWhenHerHeadTurnsAndSettlesAtRest()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..");
        CubismCoreLibrary.IsAvailable(root);
        var settings = CubismModelSettings.Load(HiyoriProAvailableFactAttribute.Model3JsonPath);
        using var model = CubismModel.Load(settings);
        var physics = CubismPhysics.Load(settings.PhysicsPath!);
        Assert.Equal(11, physics.SettingCount);

        var maxSwing = 0f;
        model.SetParameterValue("ParamAngleX", 30f);
        for (var i = 0; i < 20; i++)
        {
            physics.Evaluate(model, 1 / 30f);
            maxSwing = Math.Max(maxSwing, Math.Abs(model.GetParameterCurrentValue("ParamHairFront")));
        }
        Assert.True(maxSwing > 0.1f, $"front hair barely moved ({maxSwing})");

        model.SetParameterValue("ParamAngleX", 0f);
        for (var i = 0; i < 300; i++)
        {
            physics.Evaluate(model, 1 / 30f);
        }
        Assert.InRange(model.GetParameterCurrentValue("ParamHairFront"), -0.05f, 0.05f);
    }

    // Fixed stepping: jittery frame timing (the render timer's 15/16/31ms ticks) must land on the
    // same simulation as perfectly even frames once the same time has passed.
    [HiyoriProAvailableFact]
    public void Evaluate_UnevenFrameTimesGiveTheSameMotionAsEvenOnes()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..");
        CubismCoreLibrary.IsAvailable(root);
        var settings = CubismModelSettings.Load(HiyoriProAvailableFactAttribute.Model3JsonPath);

        float Run(float[] frameTimes)
        {
            using var model = CubismModel.Load(settings);
            var physics = CubismPhysics.Load(settings.PhysicsPath!);
            model.SetParameterValue("ParamAngleX", 30f);
            foreach (var dt in frameTimes)
            {
                physics.Evaluate(model, dt);
            }
            return model.GetParameterCurrentValue("ParamHairFront");
        }

        var even = Run(Enumerable.Repeat(1 / 60f, 30).ToArray()); // 0.5s
        var uneven = Run([.. Enumerable.Repeat(new[] { 0.015f, 0.031f, 0.004f }, 10).SelectMany(x => x)]); // also 0.5s
        Assert.NotEqual(0f, even);
        Assert.Equal(even, uneven, 3);
    }
}
