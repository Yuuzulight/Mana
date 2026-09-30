using System;
using System.IO;
using System.Text.Json;

namespace Mana.NativeLauncher;

// #576: kept as its own small file rather than folded into #565's
// ManaSettingsStore (not merged at the time this was written) -- avoids
// a cross-PR dependency, and theme choice is conceptually unrelated to
// that file's backend-connection settings anyway. Read at startup
// (Program.cs, before any Form exists); Settings > Theme saves it and
// applies it live (#688).
internal sealed class ManaThemeSettings
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Mana",
        "native-launcher-theme.json");

    // Mana's own preset is the default (#652); a saved choice still wins.
    public string Preset { get; set; } = "mana";
    public string? AccentHex { get; set; }

    public static ManaThemeSettings Load(string? filePath = null)
    {
        try
        {
            var json = File.ReadAllText(filePath ?? FilePath);
            return JsonSerializer.Deserialize<ManaThemeSettings>(json) ?? new ManaThemeSettings();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new ManaThemeSettings();
        }
    }

    public void Save(string? filePath = null)
    {
        var path = filePath ?? FilePath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this));
    }
}
