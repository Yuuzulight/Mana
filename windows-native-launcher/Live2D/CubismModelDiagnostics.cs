using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// Turns "the Live2D model didn't load" into something a user can act on,
// instead of a Console line nobody sees. Each method returns a plain-English
// message (what went wrong + what to do), or null when there's nothing to
// report. No model at all is NOT a problem -- the static PNG avatar is the
// normal default -- so that case stays silent.
internal static class CubismModelDiagnostics
{
    // Called when CubismModelLocator found nothing: only speaks up when the
    // user evidently tried to set a model up.
    public static string? DescribeNoModel(string rootDirectory, string? explicitPath)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            return $"{CubismModelLocator.EnvVar} points to a file that doesn't exist:\n{explicitPath}\n\n" +
                   "Fix the path, or clear the variable to use the model folder instead.";
        }

        var modelDirectory = CubismModelLocator.ModelDirectory(rootDirectory);
        if (!Directory.Exists(modelDirectory))
        {
            return null;
        }
        try
        {
            var legacy = Directory.EnumerateFiles(modelDirectory, "*.model.json", SearchOption.AllDirectories).FirstOrDefault()
                         ?? Directory.EnumerateFiles(modelDirectory, "*.moc", SearchOption.AllDirectories).FirstOrDefault();
            if (legacy is not null)
            {
                return $"Found an older Cubism 2 model ({Path.GetFileName(legacy)}), which isn't supported.\n\n" +
                       "Mana needs a Cubism 3 or newer model (a .model3.json file, the kind VTube Studio uses).";
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        return null;
    }

    public static string EngineMissing(string modelPath) =>
        $"Found the model {Describe(modelPath)}, but the Live2D engine (Live2DCubismCore.dll) isn't installed.\n\n" +
        "See windows-native-launcher/native/cubism-core/README.md for how to add it.";

    // Every file the model needs to render, checked before loading so a
    // missing texture names the file instead of failing somewhere deep inside.
    public static string? DescribeMissingFiles(CubismModelSettings settings, string modelPath)
    {
        var baseDir = Path.GetDirectoryName(modelPath) ?? "";
        var missing = new[] { settings.MocPath }.Concat(settings.TexturePaths)
            .Where(path => !File.Exists(path))
            .Select(path => Path.GetRelativePath(baseDir, path))
            .ToList();
        if (missing.Count == 0)
        {
            return null;
        }
        return $"The model {Describe(modelPath)} is missing files it needs:\n" +
               string.Join("\n", missing.Take(6).Select(file => "  • " + file)) +
               (missing.Count > 6 ? $"\n  … and {missing.Count - 6} more" : "") +
               "\n\nMake sure the whole model folder was copied, not just the .model3.json.";
    }

    public static string DescribeLoadFailure(Exception ex, string modelPath) => ex switch
    {
        JsonException json =>
            $"The model file {Describe(modelPath)} isn't valid JSON" +
            (json.LineNumber is { } line ? $" (around line {line + 1})" : "") + ".\n\nIt may be damaged; try re-exporting or re-downloading the model.",
        KeyNotFoundException or InvalidDataException =>
            $"The model file {Describe(modelPath)} is missing a required section (FileReferences, Moc or Textures).\n\n" +
            "It may not be a complete Live2D runtime export.",
        DllNotFoundException or BadImageFormatException or EntryPointNotFoundException =>
            "The Live2D engine (Live2DCubismCore.dll) couldn't be loaded. It may be damaged or the wrong version (it must be the 64-bit Windows build).",
        FileNotFoundException notFound =>
            $"The model {Describe(modelPath)} refers to a file that doesn't exist: {Path.GetFileName(notFound.FileName ?? "")}.",
        UnauthorizedAccessException =>
            $"Mana doesn't have permission to read the model {Describe(modelPath)}.",
        _ =>
            $"The model {Describe(modelPath)} couldn't be loaded: {ex.Message}\n\n" +
            "It may be made for a newer Cubism version than this launcher supports, or be damaged.",
    };

    public static string SkippedPart(string kind, string name, Exception ex) =>
        $"Skipped the {kind} \"{name}\": {ex.Message}";

    // "hiyori_free (hiyori_free_t08.model3.json)" -- the folder is what the
    // user copied in, so it's the name they'll recognise.
    private static string Describe(string modelPath)
    {
        var file = Path.GetFileName(modelPath);
        var dir = Path.GetDirectoryName(modelPath) ?? "";
        var folder = Path.GetFileName(dir);
        if (string.Equals(folder, "runtime", StringComparison.OrdinalIgnoreCase))
        {
            folder = Path.GetFileName(Path.GetDirectoryName(dir) ?? "");
        }
        return string.IsNullOrEmpty(folder) ? file : $"\"{folder}\" ({file})";
    }
}
