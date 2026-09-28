using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismModelDiagnosticsTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "mana-diag-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private string Write(string relative, string content = "{}")
    {
        var path = Path.Combine(CubismModelLocator.ModelDirectory(root), relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    [Fact]
    public void DescribeNoModel_IsSilentWhenNothingIsInstalled()
    {
        Assert.Null(CubismModelDiagnostics.DescribeNoModel(root, explicitPath: null));
        Directory.CreateDirectory(CubismModelLocator.ModelDirectory(root));
        Assert.Null(CubismModelDiagnostics.DescribeNoModel(root, explicitPath: null));
    }

    [Fact]
    public void DescribeNoModel_ExplainsABadExplicitPath()
    {
        var message = CubismModelDiagnostics.DescribeNoModel(root, @"C:\nowhere\mana.model3.json");
        Assert.Contains(CubismModelLocator.EnvVar, message);
        Assert.Contains(@"C:\nowhere\mana.model3.json", message);
    }

    [Fact]
    public void DescribeNoModel_RecognisesACubism2Model()
    {
        Write(@"old\old.model.json");
        var message = CubismModelDiagnostics.DescribeNoModel(root, explicitPath: null);
        Assert.Contains("Cubism 2", message);
        Assert.Contains(".model3.json", message);
    }

    [Fact]
    public void DescribeMissingFiles_NamesEachMissingFileRelativeToTheModel()
    {
        var modelPath = Write(@"mana\runtime\mana.model3.json");
        var dir = Path.GetDirectoryName(modelPath)!;
        File.WriteAllText(Path.Combine(dir, "mana.moc3"), "");
        var settings = new CubismModelSettings
        {
            MocPath = Path.Combine(dir, "mana.moc3"),
            TexturePaths = new[] { Path.Combine(dir, "mana.2048", "texture_00.png") },
            ExpressionPaths = new Dictionary<string, string>(),
        };
        var message = CubismModelDiagnostics.DescribeMissingFiles(settings, modelPath);
        Assert.NotNull(message);
        Assert.Contains(Path.Combine("mana.2048", "texture_00.png"), message);
        Assert.DoesNotContain("mana.moc3", message);
        Assert.Contains("\"mana\"", message); // names the folder the user copied, not "runtime"
    }

    [Fact]
    public void DescribeMissingFiles_IsNullWhenEverythingIsThere()
    {
        var modelPath = Write(@"m\m.model3.json");
        var dir = Path.GetDirectoryName(modelPath)!;
        File.WriteAllText(Path.Combine(dir, "m.moc3"), "");
        File.WriteAllText(Path.Combine(dir, "t.png"), "");
        var settings = new CubismModelSettings
        {
            MocPath = Path.Combine(dir, "m.moc3"),
            TexturePaths = new[] { Path.Combine(dir, "t.png") },
            ExpressionPaths = new Dictionary<string, string>(),
        };
        Assert.Null(CubismModelDiagnostics.DescribeMissingFiles(settings, modelPath));
    }

    [Fact]
    public void DescribeLoadFailure_ExplainsCommonFailuresInPlainWords()
    {
        var modelPath = @"C:\m\mana\mana.model3.json";
        Assert.Contains("isn't valid JSON", CubismModelDiagnostics.DescribeLoadFailure(new JsonException("x", null, 3, 0), modelPath));
        Assert.Contains("missing a required section", CubismModelDiagnostics.DescribeLoadFailure(new KeyNotFoundException(), modelPath));
        Assert.Contains("Live2D engine", CubismModelDiagnostics.DescribeLoadFailure(new DllNotFoundException(), modelPath));
        Assert.Contains("boom", CubismModelDiagnostics.DescribeLoadFailure(new InvalidOperationException("boom"), modelPath));
    }

    [Fact]
    public void CubismModelSettingsLoad_MissingFileReferencesSurfacesAsTheRequiredSectionMessage()
    {
        // End to end with the real parser: the exception it actually throws maps to the friendly message.
        var modelPath = Write(@"broken\broken.model3.json", "{\"Version\": 3}");
        var ex = Record.Exception(() => CubismModelSettings.Load(modelPath));
        Assert.NotNull(ex);
        Assert.Contains("missing a required section", CubismModelDiagnostics.DescribeLoadFailure(ex!, modelPath));
    }
}
