using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: parses the subset of a .model3.json this project
// actually uses -- which .moc3 file to load and which texture PNGs it
// references, in texture-index order (drawables reference textures by
// index into this same array). Motions/Physics/DisplayInfo/Groups
// (eye-blink groups, lip-sync parameter groups, expression/motion file
// lists) are Cubism Framework concerns, not Core -- out of scope for this
// sub-project's rendering pipeline; see CubismModel's own header comment
// for the full scope boundary.
internal sealed class CubismModelSettings
{
    public required string MocPath { get; init; }
    public required IReadOnlyList<string> TexturePaths { get; init; }

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

        return new CubismModelSettings
        {
            MocPath = Path.Combine(baseDir, moc),
            TexturePaths = textures,
        };
    }
}
