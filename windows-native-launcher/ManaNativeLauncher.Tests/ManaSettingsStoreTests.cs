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
                ActivePresetId = "preset-1",
            };
            settings.Save(path);

            var reloaded = ManaSettingsStore.Load(path);

            Assert.Equal("http://192.168.1.50:5005", reloaded.BackendBaseUrl);
            Assert.Equal("topsecret", reloaded.AdminToken);
            Assert.Equal("preset-1", reloaded.ActivePresetId); // #681
        }
        finally
        {
            File.Delete(path);
        }
    }

    // #645 (Q19): the token is stored DPAPI-encrypted, never in plain text.
    [Fact]
    public void Save_StoresTheAdminTokenEncrypted()
    {
        var path = TempPath();
        try
        {
            new ManaSettingsStore { AdminToken = "topsecret" }.Save(path);

            var json = File.ReadAllText(path);
            Assert.DoesNotContain("topsecret", json);
            Assert.Contains("AdminTokenProtected", json);
            Assert.Equal("topsecret", ManaSettingsStore.Load(path).AdminToken);
        }
        finally
        {
            File.Delete(path);
        }
    }

    // An existing plain-text token is moved into DPAPI on the first load.
    [Fact]
    public void Load_MigratesAPlainTextAdminToken()
    {
        var path = TempPath();
        try
        {
            File.WriteAllText(path, """{"BackendBaseUrl":"http://127.0.0.1:5005","AdminToken":"legacy-token","ActivePresetId":"p"}""");

            var settings = ManaSettingsStore.Load(path);

            Assert.Equal("legacy-token", settings.AdminToken);
            Assert.Equal("p", settings.ActivePresetId);
            Assert.DoesNotContain("legacy-token", File.ReadAllText(path));
            Assert.Equal("legacy-token", ManaSettingsStore.Load(path).AdminToken);
        }
        finally
        {
            File.Delete(path);
        }
    }

    // A blob this account can't decrypt leaves the token unset, not a crash.
    [Fact]
    public void Load_LeavesTheTokenUnsetWhenItCannotBeDecrypted()
    {
        var path = TempPath();
        try
        {
            File.WriteAllText(path, """{"AdminTokenProtected":"bm90IGEgZHBhcGkgYmxvYg=="}""");

            var settings = ManaSettingsStore.Load(path);

            Assert.Null(settings.AdminToken);
            Assert.Equal("http://127.0.0.1:5005", settings.BackendBaseUrl);
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
