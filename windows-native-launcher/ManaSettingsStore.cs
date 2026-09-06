using System;
using System.IO;
using System.Text.Json;

namespace Mana.NativeLauncher;

// #565: launcher-level connection preferences (which node-bot to talk to,
// and the admin bearer token to send it) -- kept in a small per-user JSON
// file rather than threaded through every constructor that needs one,
// since nothing here has live state to keep in sync: every consumer
// (ManaBackendClient, TrayNotificationClient) reads it once at startup,
// and the Settings UI just reads/writes the same file directly. A
// missing or corrupt file degrades to defaults instead of failing
// construction -- this is a "nice to have" override, not a required config.
internal sealed class ManaSettingsStore
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Mana",
        "native-launcher-settings.json");

    public string BackendBaseUrl { get; set; } = "http://127.0.0.1:5005";
    public string? AdminToken { get; set; }

    // filePath: null (every real call site) uses the real per-user
    // settings file. Tests pass a temp file path to exercise
    // load/save/corruption handling without touching LocalApplicationData.
    public static ManaSettingsStore Load(string? filePath = null)
    {
        try
        {
            var json = File.ReadAllText(filePath ?? FilePath);
            return JsonSerializer.Deserialize<ManaSettingsStore>(json) ?? new ManaSettingsStore();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new ManaSettingsStore();
        }
    }

    public void Save(string? filePath = null)
    {
        var path = filePath ?? FilePath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this));
    }
}
