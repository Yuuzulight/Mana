using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: parses the subset of a .model3.json this project
// actually uses -- which .moc3 file to load, which texture PNGs it
// references (in texture-index order; drawables reference textures by
// index into this same array), (#514) which named expression files it
// declares, (#515/#683) its motion groups, its pose and physics files,
// and (#683) its EyeBlink parameter group.
internal sealed class CubismModelSettings
{
    public required string MocPath { get; init; }
    public required IReadOnlyList<string> TexturePaths { get; init; }

    // #514: Name -> full path, from FileReferences.Expressions (each
    // {"Name":"...","File":"..."}). Empty when the model3.json doesn't
    // declare any -- not every model ships expressions, and that's a
    // property of the asset, not an error.
    public required IReadOnlyDictionary<string, string> ExpressionPaths { get; init; }

    // #515/#683: every FileReferences.Motions group, name -> full paths in file
    // order (groups with no usable File are left out). Empty when the model
    // declares no motions.
    public IReadOnlyDictionary<string, IReadOnlyList<string>> MotionGroups { get; init; } =
        new Dictionary<string, IReadOnlyList<string>>();

    // FileReferences.Pose (.pose3.json), or null. A pose file says which
    // parts are mutually exclusive alternatives (e.g. hiyori_pro's two arm
    // sets) -- without applying it, every alternative renders at once.
    public string? PosePath { get; init; }

    // FileReferences.Physics (.physics3.json), or null -- hair/clothing sway.
    public string? PhysicsPath { get; init; }

    // #683: the Ids of the top-level Groups entry named "EyeBlink" -- which
    // parameters auto-blink drives. Empty when the model doesn't declare
    // one (the caller backfills the standard ids, like Electron's
    // augmentModelSettings).
    public IReadOnlyList<string> EyeBlinkParameterIds { get; init; } = [];

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

        var motionGroups = new Dictionary<string, IReadOnlyList<string>>();
        if (fileReferences.TryGetProperty("Motions", out var motionsElement) && motionsElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var group in motionsElement.EnumerateObject())
            {
                if (group.Value.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }
                var files = group.Value.EnumerateArray()
                    .Select(motion => motion.ValueKind == JsonValueKind.Object && motion.TryGetProperty("File", out var fileElement) && fileElement.ValueKind == JsonValueKind.String
                        ? fileElement.GetString()
                        : null)
                    .Where(file => !string.IsNullOrEmpty(file))
                    .Select(file => Path.Combine(baseDir, file!))
                    .ToList();
                if (files.Count > 0)
                {
                    motionGroups[group.Name] = files;
                }
            }
        }

        var pose = fileReferences.TryGetProperty("Pose", out var poseElement) ? poseElement.GetString() : null;
        var physics = fileReferences.TryGetProperty("Physics", out var physicsElement) ? physicsElement.GetString() : null;

        var eyeBlinkIds = new List<string>();
        if (document.RootElement.TryGetProperty("Groups", out var groupsElement) && groupsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var group in groupsElement.EnumerateArray())
            {
                if (group.ValueKind == JsonValueKind.Object
                    && group.TryGetProperty("Name", out var groupName) && groupName.ValueKind == JsonValueKind.String
                    && groupName.GetString() == "EyeBlink"
                    && group.TryGetProperty("Ids", out var ids) && ids.ValueKind == JsonValueKind.Array)
                {
                    eyeBlinkIds.AddRange(ids.EnumerateArray()
                        .Where(id => id.ValueKind == JsonValueKind.String)
                        .Select(id => id.GetString()!)
                        .Where(id => id.Length > 0));
                }
            }
        }

        return new CubismModelSettings
        {
            MocPath = Path.Combine(baseDir, moc),
            TexturePaths = textures,
            ExpressionPaths = expressionPaths,
            MotionGroups = motionGroups,
            PosePath = pose is null ? null : Path.Combine(baseDir, pose),
            PhysicsPath = physics is null ? null : Path.Combine(baseDir, physics),
            EyeBlinkParameterIds = eyeBlinkIds,
        };
    }
}
