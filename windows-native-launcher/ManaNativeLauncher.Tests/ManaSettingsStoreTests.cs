using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ManaSettingsStoreTests
{
    private static string TempPath() => Path.Combine(Path.GetTempPath(), $"mana-settings-test-{Guid.NewGuid():N}.json");

    [Fact]
    public void Load_ReturnsDefaultsWhenTheFileDoesNotExist()
    {
        var settings = ManaSettingsStore.Load(TempPath());

        Assert.Equal("http://127.0.0.1:5005", settings.BackendBaseUrl);
        Assert.Null(settings.AdminToken);
    }

    [Fact]
    public void Load_ReturnsDefaultsWhenTheFileIsCorruptJson()
    {
        var path = TempPath();
        File.WriteAllText(path, "{not json");
        try
        {
            var settings = ManaSettingsStore.Load(path);

            Assert.Equal("http://127.0.0.1:5005", settings.BackendBaseUrl);
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
            var settings = new ManaSettingsStore
            {
                BackendBaseUrl = "http://192.168.1.50:5005",
                AdminToken = "topsecret",
            };
            settings.Save(path);

            var reloaded = ManaSettingsStore.Load(path);

            Assert.Equal("http://192.168.1.50:5005", reloaded.BackendBaseUrl);
            Assert.Equal("topsecret", reloaded.AdminToken);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Save_CreatesTheParentDirectoryWhenItDoesNotExist()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"mana-settings-dir-{Guid.NewGuid():N}");
        var path = Path.Combine(directory, "settings.json");
        try
        {
            new ManaSettingsStore().Save(path);

            Assert.True(File.Exists(path));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
