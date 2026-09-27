using System;
using System.IO;
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
}
