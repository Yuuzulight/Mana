using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// A parsed .pose3.json: groups of mutually exclusive parts (only one part in
// a group shows at a time -- e.g. hiyori_pro's PartArmA / PartArmB arm sets),
// each optionally carrying "Link" parts that show and hide with it. Applies
// the Cubism Framework's initial pose: the first part of every group is
// visible, the rest hidden. Pose switching at runtime (fading between
// alternatives when a motion's PartOpacity curve asks) is out of scope, like
// CubismMotionFile's own PartOpacity curves.
internal sealed class CubismPoseFile
{
    public sealed record Entry(string Id, IReadOnlyList<string> Links);

    public required IReadOnlyList<IReadOnlyList<Entry>> Groups { get; init; }

    public static CubismPoseFile Load(string pose3JsonPath)
    {
        using var stream = File.OpenRead(pose3JsonPath);
        return Parse(JsonDocument.Parse(stream).RootElement);
    }

    public static CubismPoseFile Parse(JsonElement root)
    {
        var groups = new List<IReadOnlyList<Entry>>();
        foreach (var groupElement in root.GetProperty("Groups").EnumerateArray())
        {
            var group = new List<Entry>();
            foreach (var entryElement in groupElement.EnumerateArray())
            {
                var id = entryElement.TryGetProperty("Id", out var idElement) ? idElement.GetString() : null;
                if (string.IsNullOrEmpty(id))
                {
                    continue;
                }
                var links = new List<string>();
                if (entryElement.TryGetProperty("Link", out var linkElement) && linkElement.ValueKind == JsonValueKind.Array)
                {
                    links.AddRange(linkElement.EnumerateArray().Select(l => l.GetString()).OfType<string>());
                }
                group.Add(new Entry(id, links));
            }
            if (group.Count > 0)
            {
                groups.Add(group);
            }
        }
        return new CubismPoseFile { Groups = groups };
    }

    // Opacity per part id for the initial pose -- split out so it's testable
    // without a native model.
    public IReadOnlyDictionary<string, float> InitialOpacities()
    {
        var opacities = new Dictionary<string, float>();
        foreach (var group in Groups)
        {
            for (var i = 0; i < group.Count; i++)
            {
                var value = i == 0 ? 1f : 0f;
                opacities[group[i].Id] = value;
                foreach (var link in group[i].Links)
                {
                    opacities[link] = value;
                }
            }
        }
        return opacities;
    }

    public void ApplyInitialPose(CubismModel model)
    {
        foreach (var (id, opacity) in InitialOpacities())
        {
            model.SetPartOpacity(id, opacity);
        }
    }
}
