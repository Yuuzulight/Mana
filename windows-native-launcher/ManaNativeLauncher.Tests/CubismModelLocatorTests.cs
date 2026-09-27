using System;
using System.IO;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismModelLocatorTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "mana-locator-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private string AddModel(params string[] relativeParts)
    {
        var path = Path.Combine(new[] { CubismModelLocator.ModelDirectory(root) }.Concat(relativeParts).ToArray());
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "{}");
        return path;
    }

    [Fact]
    public void Find_LocatesAModelNestedInSubfolders()
    {
        var model = AddModel("my-model", "runtime", "mana.model3.json");
        Assert.Equal(model, CubismModelLocator.Find(root, explicitPath: null));
    }

    [Fact]
    public void Find_PicksTheOrdinallyFirstWhenSeveralExist()
    {
        AddModel("zeta", "z.model3.json");
        var first = AddModel("alpha", "a.model3.json");
        Assert.Equal(first, CubismModelLocator.Find(root, explicitPath: null));
    }

    [Fact]
    public void Find_IgnoresNonModelJsonFiles()
    {
        AddModel("m", "m.physics3.json");
        AddModel("m", "m.cdi3.json");
        Assert.Null(CubismModelLocator.Find(root, explicitPath: null));
    }

    [Fact]
    public void Find_ReturnsNullWhenTheModelFolderIsMissing()
    {
        Assert.Null(CubismModelLocator.Find(root, explicitPath: null));
    }

    [Fact]
    public void Find_ExplicitPathWinsOverTheFolder()
    {
        AddModel("folder", "folder.model3.json");
        var elsewhere = Path.Combine(root, "elsewhere", "explicit.model3.json");
        Directory.CreateDirectory(Path.GetDirectoryName(elsewhere)!);
        File.WriteAllText(elsewhere, "{}");
        Assert.Equal(elsewhere, CubismModelLocator.Find(root, elsewhere));
    }

    [Fact]
    public void Find_MissingExplicitPathDoesNotFallBackToTheFolder()
    {
        // Matches the Electron launcher: a set-but-wrong MANA_LIVE2D_MODEL is a
        // configuration error to surface, not something to silently paper over.
        AddModel("folder", "folder.model3.json");
        Assert.Null(CubismModelLocator.Find(root, Path.Combine(root, "nope.model3.json")));
    }
}
