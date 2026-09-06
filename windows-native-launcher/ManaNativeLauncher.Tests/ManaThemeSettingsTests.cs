using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ManaThemeSettingsTests
{
    private static string TempPath() => Path.Combine(Path.GetTempPath(), $"mana-theme-test-{Guid.NewGuid():N}.json");

    [Fact]
    public void Load_ReturnsDefaultsWhenTheFileDoesNotExist()
    {
        var settings = ManaThemeSettings.Load(TempPath());

        Assert.Equal("violet", settings.Preset);
        Assert.Null(settings.AccentHex);
    }

    [Fact]
    public void Load_ReturnsDefaultsWhenTheFileIsCorruptJson()
    {
        var path = TempPath();
        File.WriteAllText(path, "{not json");
        try
        {
            var settings = ManaThemeSettings.Load(path);

            Assert.Equal("violet", settings.Preset);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void SaveThenLoad_RoundTripsBothFields()
    {
        var path = TempPath();
        try
        {
            var settings = new ManaThemeSettings { Preset = "highContrast", AccentHex = "#ff00ff" };
            settings.Save(path);

            var reloaded = ManaThemeSettings.Load(path);

            Assert.Equal("highContrast", reloaded.Preset);
            Assert.Equal("#ff00ff", reloaded.AccentHex);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
