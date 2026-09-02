using System;
using System.IO;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismModelTests
{
    // Both the native Core DLL (native/cubism-core/, gitignored -- see its
    // README.md) and the model files themselves (windows-launcher/avatar/model/,
    // also gitignored, shared with the Electron apps per AvatarOverlayForm's
    // existing fallback-PNG convention) are optional, environment-specific
    // binaries -- not guaranteed present in every checkout/CI environment.
    // Skips gracefully rather than failing CI elsewhere, matching
    // SileroVadRunnerTests' own pattern for the same kind of dependency.
    private static readonly string DllPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "native", "cubism-core", "Live2DCubismCore.dll");

    private static readonly string Model3JsonPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..",
        "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");

    internal static bool CubismCoreAvailable => File.Exists(DllPath) && File.Exists(Model3JsonPath);

    private static CubismModel LoadTestModel()
    {
        CubismCoreLibrary.IsAvailable(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var settings = CubismModelSettings.Load(Model3JsonPath);
        return CubismModel.Load(settings);
    }

    [CubismAvailableFact]
    public void Load_ReadsRealModelParametersAndDrawables()
    {
        using var model = LoadTestModel();

        // No assertion on exact counts (those depend on the specific
        // model's own art/rig, not this class's logic) -- this confirms
        // Core actually parsed a real, non-trivial model rather than
        // silently returning empty/garbage data.
        Assert.True(model.HasParameter("ParamMouthOpenY"), "expected a standard Cubism mouth-openness parameter");
        var drawables = model.GetDrawables();
        Assert.NotEmpty(drawables);
        Assert.All(drawables, d => Assert.NotEmpty(d.VertexPositions));
        Assert.All(drawables, d => Assert.NotEmpty(d.Indices));
    }

    [CubismAvailableFact]
    public void SetParameterValue_ForAnUnknownParameterIsANoOpNotAThrow()
    {
        using var model = LoadTestModel();

        var exception = Record.Exception(() => model.SetParameterValue("ThisParameterDoesNotExist", 1.0f));

        Assert.Null(exception);
    }

    [CubismAvailableFact]
    public void SetParameterValue_ThenUpdate_ActuallyDeformsTheMesh()
    {
        using var model = LoadTestModel();
        model.Update();
        var beforePositions = FirstDrawableVertexSnapshot(model);

        // Push the mouth parameter to its (Cubism-standard) fully-open
        // value and re-update -- if Core is wired correctly end to end
        // (parameter write -> csmUpdateModel -> deformed mesh), at least
        // some vertex somewhere on the model must have moved. This is the
        // real proof the whole pipeline works, not just that individual
        // calls don't throw.
        model.SetParameterValue("ParamMouthOpenY", 1.0f);
        model.Update();
        var afterPositions = FirstDrawableVertexSnapshot(model);

        Assert.NotEqual(beforePositions, afterPositions);
    }

    // Concatenates every drawable's vertex positions into one comparable
    // string snapshot -- simplest way to detect "something about the mesh
    // changed" without needing to know which specific drawable/vertex the
    // mouth parameter actually influences (that's per-model rig detail).
    private static string FirstDrawableVertexSnapshot(CubismModel model)
    {
        var drawables = model.GetDrawables();
        var parts = new List<string>();
        foreach (var drawable in drawables)
        {
            foreach (var vertex in drawable.VertexPositions)
            {
                parts.Add($"{vertex.X:F6},{vertex.Y:F6}");
            }
        }
        return string.Join("|", parts);
    }
}
