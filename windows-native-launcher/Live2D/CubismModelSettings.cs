using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: parses the subset of a .model3.json this project
// actually uses -- which .moc3 file to load, which texture PNGs it
// references (in texture-index order; drawables reference textures by
// index into this same array), (#514) which named expression files it
// declares, (#515) its first Idle motion file, its pose and physics
// files, and (#683) its EyeBlink parameter group.
internal sealed class CubismModelSettings
{
    public required string MocPath { get; init; }
    public required IReadOnlyList<string> TexturePaths { get; init; }

    // #514: Name -> full path, from FileReferences.Expressions (each
    // {"Name":"...","File":"..."}). Empty when the model3.json doesn't
    // declare any -- not every model ships expressions, and that's a
    // property of the asset, not an error.
    public required IReadOnlyDictionary<string, string> ExpressionPaths { get; init; }

    // #515: full path to the FIRST file in FileReferences.Motions.Idle, or
    // null if the model has no Idle motion group. A real model's own Idle
    // group commonly lists several variations (hiyori_free's has 3); this
    // project deliberately plays just one on a continuous loop rather than
    // randomizing/cycling between them -- "so she looks alive at rest" per
    // the issue's own scope, not a full motion-selection system.
    public required string? IdleMotionPath { get; init; }

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

        string? idleMotionPath = null;
        if (fileReferences.TryGetProperty("Motions", out var motionsElement)
            && motionsElement.TryGetProperty("Idle", out var idleGroupElement))
        {
            foreach (var motionElement in idleGroupElement.EnumerateArray())
            {
                var file = motionElement.TryGetProperty("File", out var fileElement) ? fileElement.GetString() : null;
                if (file is not null)
                {
                    idleMotionPath = Path.Combine(baseDir, file);
                    break; // first entry only -- see IdleMotionPath's own comment
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
            IdleMotionPath = idleMotionPath,
            PosePath = pose is null ? null : Path.Combine(baseDir, pose),
            PhysicsPath = physics is null ? null : Path.Combine(baseDir, physics),
            EyeBlinkParameterIds = eyeBlinkIds,
        };
    }
}
