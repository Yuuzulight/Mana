namespace Mana.NativeLauncher.Live2D;

// Finds which Live2D model to load, the same way the Electron launcher does
// (windows-launcher/avatar/live2d-avatar.js findConfiguredModelJson +
// live2d-logic.js findModelJson): an explicit MANA_LIVE2D_MODEL path wins;
// otherwise the ordinally-first .model3.json anywhere under the model
// directory (git-ignored), so dropping a model folder in there is all it
// takes -- no code change per model.
internal static class CubismModelLocator
{
    public const string EnvVar = "MANA_LIVE2D_MODEL";

    // #681: windows-native-launcher/assets/avatar/model/ first, so native
    // runs with windows-launcher/ gone; windows-launcher/avatar/model/ (where
    // Electron, its fetch-sample-avatar script and existing installs keep
    // the model) is the fallback until Electron is retired (#479).
    public static string ModelDirectory(string rootDirectory) =>
        PreferNativeAsset(
            Path.Combine(rootDirectory, "windows-native-launcher", "assets", "avatar", "model"),
            Path.Combine(rootDirectory, "windows-launcher", "avatar", "model"));

    // #681: nativePath, unless only legacyPath (the windows-launcher/ copy
    // of a git-ignored asset) exists. Also used for the PNG avatar art.
    public static string PreferNativeAsset(string nativePath, string legacyPath) =>
        !Path.Exists(nativePath) && Path.Exists(legacyPath) ? legacyPath : nativePath;

    public static string? Find(string rootDirectory, string? explicitPath)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            return File.Exists(explicitPath) ? explicitPath : null;
        }

        var modelDirectory = ModelDirectory(rootDirectory);
        if (!Directory.Exists(modelDirectory))
        {
            return null;
        }

        try
        {
            return Directory
                .EnumerateFiles(modelDirectory, "*.model3.json", SearchOption.AllDirectories)
                .OrderBy(path => path, StringComparer.Ordinal)
                .FirstOrDefault();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
