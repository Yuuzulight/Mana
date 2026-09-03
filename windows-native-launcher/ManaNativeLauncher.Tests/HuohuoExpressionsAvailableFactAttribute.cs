using System;
using System.IO;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Same skip-gracefully pattern as SkippableFactAttribute/
// CubismAvailableFactAttribute, for a third optional local asset: the
// disabled "huohuo" Live2D model is the only one of this checkout's real
// local models that actually ships .exp3.json files (hiyori_free/
// hiyori_pro's own model3.json files declare none) -- used here purely as
// a source of genuine expression file content to parse against, gitignored
// like every other Live2D asset in this repo.
internal sealed class HuohuoExpressionsAvailableFactAttribute : FactAttribute
{
    public static readonly string Directory = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..",
        "windows-launcher", "avatar", "model-disabled", "huohuo2", "huohuo");

    public static bool Available => File.Exists(Path.Combine(Directory, "angry.exp3.json"));

    public HuohuoExpressionsAvailableFactAttribute()
    {
        if (!Available)
        {
            Skip = "huohuo model (windows-launcher/avatar/model-disabled/huohuo2/) not available locally";
        }
    }
}
