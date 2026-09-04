using System.Collections.Generic;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CompareModeFormatterTests
{
    [Fact]
    public void PickDefaultProfiles_PrefersDefaultAndQualityWhenBothExist()
    {
        var (a, b) = CompareModeFormatter.PickDefaultProfiles(new[] { "fast", "default", "quality" });

        Assert.Equal("default", a);
        Assert.Equal("quality", b);
    }

    [Fact]
    public void PickDefaultProfiles_FallsBackToFirstTwoDistinctKeys()
    {
        var (a, b) = CompareModeFormatter.PickDefaultProfiles(new[] { "fast", "balanced" });

        Assert.Equal("fast", a);
        Assert.Equal("balanced", b);
    }

    [Fact]
    public void PickDefaultProfiles_FallsThroughToGenericPairingWhenOnlyDefaultExistsWithoutQuality()
    {
        // Both keys must be present for the special-cased "default"+
        // "quality" pairing -- "default" alone falls through to the
        // generic first-two-distinct-keys branch, same as any other key.
        var (a, b) = CompareModeFormatter.PickDefaultProfiles(new[] { "default", "fast" });

        Assert.Equal("default", a);
        Assert.Equal("fast", b);
    }

    [Fact]
    public void PickDefaultProfiles_ReturnsTheSameKeyTwiceWhenOnlyOneExists()
    {
        var (a, b) = CompareModeFormatter.PickDefaultProfiles(new[] { "fast" });

        Assert.Equal("fast", a);
        Assert.Equal("fast", b);
    }

    [Fact]
    public void PickDefaultProfiles_ReturnsNullsForNoProfiles()
    {
        var (a, b) = CompareModeFormatter.PickDefaultProfiles(System.Array.Empty<string>());

        Assert.Null(a);
        Assert.Null(b);
    }

    [Fact]
    public void FormatProfileLabel_IncludesTheResolvedModelFileName()
    {
        var profiles = new Dictionary<string, ManaModelProfile>
        {
            ["quality"] = new() { Key = "quality", Label = "Quality", Available = true, SelectedModel = @"C:\models\mistral-7b-q4.gguf" },
        };

        Assert.Equal("Quality (mistral-7b-q4.gguf)", CompareModeFormatter.FormatProfileLabel("quality", profiles));
    }

    [Fact]
    public void FormatProfileLabel_HandlesForwardSlashPaths()
    {
        var profiles = new Dictionary<string, ManaModelProfile>
        {
            ["quality"] = new() { Key = "quality", Label = "Quality", Available = true, SelectedModel = "/models/mistral-7b-q4.gguf" },
        };

        Assert.Equal("Quality (mistral-7b-q4.gguf)", CompareModeFormatter.FormatProfileLabel("quality", profiles));
    }

    [Fact]
    public void FormatProfileLabel_MarksAnUnavailableProfile()
    {
        var profiles = new Dictionary<string, ManaModelProfile>
        {
            ["quality"] = new() { Key = "quality", Label = "Quality", Available = false, SelectedModel = null },
        };

        Assert.Equal("Quality (unavailable)", CompareModeFormatter.FormatProfileLabel("quality", profiles));
    }

    [Fact]
    public void FormatProfileLabel_FallsBackToLabelWhenNoModelIsSelected()
    {
        var profiles = new Dictionary<string, ManaModelProfile>
        {
            ["quality"] = new() { Key = "quality", Label = "Quality", Available = true, SelectedModel = null },
        };

        Assert.Equal("Quality", CompareModeFormatter.FormatProfileLabel("quality", profiles));
    }

    [Fact]
    public void FormatProfileLabel_FallsBackToTheKeyWhenTheProfileIsUnknown()
    {
        var profiles = new Dictionary<string, ManaModelProfile>();

        Assert.Equal("missing", CompareModeFormatter.FormatProfileLabel("missing", profiles));
    }

    [Fact]
    public void FormatProfileLabel_ReturnsEmptyStringForNullKey()
    {
        var profiles = new Dictionary<string, ManaModelProfile>();

        Assert.Equal("", CompareModeFormatter.FormatProfileLabel(null, profiles));
    }
}
