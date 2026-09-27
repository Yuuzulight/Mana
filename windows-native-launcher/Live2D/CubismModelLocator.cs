namespace Mana.NativeLauncher.Live2D;

// Finds which Live2D model to load, the same way the Electron launcher does
// (windows-launcher/avatar/live2d-avatar.js findConfiguredModelJson +
// live2d-logic.js findModelJson): an explicit MANA_LIVE2D_MODEL path wins;
// otherwise the ordinally-first .model3.json anywhere under
// windows-launcher/avatar/model/ (git-ignored), so dropping a model folder
// in there is all it takes -- no code change per model.
internal static class CubismModelLocator
{
    public const string EnvVar = "MANA_LIVE2D_MODEL";

    public static string ModelDirectory(string rootDirectory) =>
        Path.Combine(rootDirectory, "windows-launcher", "avatar", "model");

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
