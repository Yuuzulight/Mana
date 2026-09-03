using System;
using System.IO;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Pure JSON parsing -- no Cubism Core/native SDK involved, so unlike
// CubismModelTests these run unconditionally, using a synthetic fixture
// instead of a real (gitignored, optional) model.
public class CubismModelSettingsTests
{
    private static string WriteFixture(string dir, string model3Json)
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "test.model3.json");
        File.WriteAllText(path, model3Json);
        return path;
    }

    [Fact]
    public void Load_ParsesMocAndTextures()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-settings-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "FileReferences": {
                    "Moc": "model.moc3",
                    "Textures": ["texture_00.png", "texture_01.png"]
                  }
                }
                """);

            var settings = CubismModelSettings.Load(path);

            Assert.Equal(Path.Combine(dir, "model.moc3"), settings.MocPath);
            Assert.Equal(
                [Path.Combine(dir, "texture_00.png"), Path.Combine(dir, "texture_01.png")],
                settings.TexturePaths);
            Assert.Empty(settings.ExpressionPaths);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Load_ParsesDeclaredExpressions()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-settings-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "FileReferences": {
                    "Moc": "model.moc3",
                    "Textures": ["texture_00.png"],
                    "Expressions": [
                      { "Name": "angry", "File": "angry.exp3.json" },
                      { "Name": "smile", "File": "smile.exp3.json" }
                    ]
                  }
                }
                """);

            var settings = CubismModelSettings.Load(path);

            Assert.Equal(2, settings.ExpressionPaths.Count);
            Assert.Equal(Path.Combine(dir, "angry.exp3.json"), settings.ExpressionPaths["angry"]);
            Assert.Equal(Path.Combine(dir, "smile.exp3.json"), settings.ExpressionPaths["smile"]);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Load_SkipsAMalformedExpressionEntryInsteadOfThrowing()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-settings-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """
                {
                  "FileReferences": {
                    "Moc": "model.moc3",
                    "Textures": [],
                    "Expressions": [
                      { "Name": "angry", "File": "angry.exp3.json" },
                      { "Name": "missing_file_field" },
                      { "File": "missing_name.exp3.json" }
                    ]
                  }
                }
                """);

            var settings = CubismModelSettings.Load(path);

            Assert.Single(settings.ExpressionPaths);
            Assert.True(settings.ExpressionPaths.ContainsKey("angry"));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Load_ThrowsWhenMocIsMissing()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-settings-test-" + Guid.NewGuid());
        try
        {
            var path = WriteFixture(dir, """{ "FileReferences": { "Textures": [] } }""");

            // Not a specific exception type -- JsonElement.GetProperty
            // throws its own KeyNotFoundException for an absent property
            // (pre-existing behavior this test doesn't change), separate
            // from the explicit InvalidDataException this method throws
            // for a present-but-wrong-shaped field elsewhere. Both are
            // caught identically by AvatarOverlayForm's broad catch at the
            // one real call site, so the exact type isn't a meaningful
            // contract here -- only "load fails loudly instead of
            // returning a broken settings object" is.
            Assert.ThrowsAny<Exception>(() => CubismModelSettings.Load(path));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
