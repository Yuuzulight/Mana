using System;
using System.IO;
using System.Text.Json;
using Mana.NativeLauncher.Live2D;
using SkiaSharp;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismPoseFileTests
{
    private static CubismPoseFile Parse(string json) => CubismPoseFile.Parse(JsonDocument.Parse(json).RootElement);

    [Fact]
    public void InitialOpacities_ShowsTheFirstPartOfEachGroupAndHidesTheRest()
    {
        var pose = Parse("""{"Type":"Live2D Pose","Groups":[[{"Id":"PartArmA","Link":[]},{"Id":"PartArmB","Link":[]}]]}""");
        var opacities = pose.InitialOpacities();
        Assert.Equal(1f, opacities["PartArmA"]);
        Assert.Equal(0f, opacities["PartArmB"]);
    }

    [Fact]
    public void InitialOpacities_LinkedPartsFollowTheirOwner()
    {
        var pose = Parse("""{"Groups":[[{"Id":"A","Link":["A_hand"]},{"Id":"B","Link":["B_hand","B_sleeve"]}]]}""");
        var opacities = pose.InitialOpacities();
        Assert.Equal(1f, opacities["A_hand"]);
        Assert.Equal(0f, opacities["B_hand"]);
        Assert.Equal(0f, opacities["B_sleeve"]);
    }

    [Fact]
    public void Parse_ToleratesMissingLinksAndSkipsEntriesWithoutAnId()
    {
        var pose = Parse("""{"Groups":[[{"Id":"A"},{"Link":["x"]},{"Id":"C"}],[]]}""");
        var group = Assert.Single(pose.Groups);
        Assert.Equal(new[] { "A", "C" }, group.Select(e => e.Id));
    }

    [Fact]
    public void CubismModelSettings_ReadsThePoseReference()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-pose-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var path = Path.Combine(dir, "m.model3.json");
            File.WriteAllText(path, """{"FileReferences":{"Moc":"m.moc3","Textures":["t.png"],"Pose":"m.pose3.json"}}""");
            Assert.Equal(Path.Combine(dir, "m.pose3.json"), CubismModelSettings.Load(path).PosePath);
            File.WriteAllText(path, """{"FileReferences":{"Moc":"m.moc3","Textures":["t.png"]}}""");
            Assert.Null(CubismModelSettings.Load(path).PosePath);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // End to end against the real hiyori_pro (skipped when the SDK/model aren't installed): with its
    // pose applied, the hidden arm set's drawables must actually end up at zero opacity after Update.
    [HiyoriProAvailableFact]
    public void ApplyInitialPose_HidesHiyoriProsSecondArmSet()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..");
        CubismCoreLibrary.IsAvailable(root);
        var settings = CubismModelSettings.Load(HiyoriProAvailableFactAttribute.Model3JsonPath);
        using var model = CubismModel.Load(settings);
        model.Update();
        var visibleBefore = model.GetDrawables().Count(d => d.Opacity > 0.01f);

        CubismPoseFile.Load(settings.PosePath!).ApplyInitialPose(model);
        model.Update();
        var visibleAfter = model.GetDrawables().Count(d => d.Opacity > 0.01f);

        Assert.True(visibleAfter < visibleBefore, $"expected fewer visible drawables with the pose applied ({visibleBefore} -> {visibleAfter})");
    }
}

public sealed class HiyoriProAvailableFactAttribute : FactAttribute
{
    internal static readonly string Model3JsonPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..",
        "windows-launcher", "avatar", "model", "hiyori_pro", "runtime", "hiyori_pro_t11.model3.json");

    private static readonly string DllPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "native", "cubism-core", "Live2DCubismCore.dll");

    public HiyoriProAvailableFactAttribute()
    {
        if (!File.Exists(DllPath) || !File.Exists(Model3JsonPath))
        {
            Skip = "Cubism Core DLL and/or hiyori_pro not installed locally (both gitignored)";
        }
    }
}
