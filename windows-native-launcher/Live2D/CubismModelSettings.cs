using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: parses the subset of a .model3.json this project
// actually uses -- which .moc3 file to load, which texture PNGs it
// references (in texture-index order; drawables reference textures by
// index into this same array), and (#514) which named expression files it
// declares. Motions/Physics/DisplayInfo/Groups (eye-blink groups,
// lip-sync parameter groups, motion file lists) are still out of scope --
// see CubismModel's own header comment for the full boundary.
internal sealed class CubismModelSettings
{
    public required string MocPath { get; init; }
    public required IReadOnlyList<string> TexturePaths { get; init; }

    // #514: Name -> full path, from FileReferences.Expressions (each
    // {"Name":"...","File":"..."}). Empty when the model3.json doesn't
    // declare any -- not every model ships expressions, and that's a
    // property of the asset, not an error.
    public required IReadOnlyDictionary<string, string> ExpressionPaths { get; init; }

    public static CubismModelSettings Load(string model3JsonPath)
    {
        var baseDir = Path.GetDirectoryName(model3JsonPath) ?? "";
        using var stream = File.OpenRead(model3JsonPath);
        using var document = JsonDocument.Parse(stream);
        var fileReferences = document.RootElement.GetProperty("FileReferences");

        var moc = fileReferences.GetProperty("Moc").GetString()
            ?? throw new InvalidDataException($"{model3JsonPath}: FileReferences.Moc is missing");

        var textures = new List<string>();
        foreach (var textureElement in fileReferences.GetProperty("Textures").EnumerateArray())
        {
            var texturePath = textureElement.GetString()
                ?? throw new InvalidDataException($"{model3JsonPath}: a FileReferences.Textures entry is not a string");
            textures.Add(Path.Combine(baseDir, texturePath));
        }

        var expressionPaths = new Dictionary<string, string>();
        if (fileReferences.TryGetProperty("Expressions", out var expressionsElement))
        {
            foreach (var expressionElement in expressionsElement.EnumerateArray())
            {
                var name = expressionElement.TryGetProperty("Name", out var nameElement) ? nameElement.GetString() : null;
                var file = expressionElement.TryGetProperty("File", out var fileElement) ? fileElement.GetString() : null;
                if (name is null || file is null)
                {
                    continue;
                }
                // Last-wins on a duplicate Name -- plain dictionary-indexer
                // semantics, not a policy worth enforcing further: a
                // model3.json with two expressions sharing a Name is
                // malformed authoring content this project doesn't
                // generate, not something Mana needs to guard against.
                expressionPaths[name] = Path.Combine(baseDir, file);
            }
        }

        return new CubismModelSettings
        {
            MocPath = Path.Combine(baseDir, moc),
            TexturePaths = textures,
            ExpressionPaths = expressionPaths,
        };
    }
}
