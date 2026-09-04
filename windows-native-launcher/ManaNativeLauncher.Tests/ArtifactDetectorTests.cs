using System.Collections.Generic;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ArtifactDetectorTests
{
    [Fact]
    public void Extract_ReturnsNullWhenThereIsNoFencedBlock()
    {
        Assert.Null(ArtifactDetector.Extract("just plain chat text"));
    }

    [Fact]
    public void Extract_HtmlFenceQualifiesRegardlessOfLength()
    {
        var artifact = ArtifactDetector.Extract("```html\n<div>hi</div>\n```");

        Assert.NotNull(artifact);
        Assert.Equal("html", artifact!.Value.Language);
        Assert.Equal("<div>hi</div>", artifact.Value.Content);
    }

    [Fact]
    public void Extract_MermaidFenceQualifiesRegardlessOfLength()
    {
        var artifact = ArtifactDetector.Extract("```mermaid\ngraph TD\nA-->B\n```");

        Assert.NotNull(artifact);
        Assert.Equal("mermaid", artifact!.Value.Language);
    }

    [Fact]
    public void Extract_ShortNonSpecialFenceDoesNotQualify()
    {
        Assert.Null(ArtifactDetector.Extract("```python\nprint(1)\n```"));
    }

    [Fact]
    public void Extract_LongNonSpecialFenceQualifies()
    {
        var longContent = new string('x', ArtifactDetector.ArtifactMinChars);
        var artifact = ArtifactDetector.Extract($"```python\n{longContent}\n```");

        Assert.NotNull(artifact);
        Assert.Equal("python", artifact!.Value.Language);
    }

    [Fact]
    public void Extract_FenceWithNoLanguageDefaultsToText()
    {
        var longContent = new string('x', ArtifactDetector.ArtifactMinChars);
        var artifact = ArtifactDetector.Extract($"```\n{longContent}\n```");

        Assert.Equal("text", artifact!.Value.Language);
    }

    [Fact]
    public void Extract_TrimsTrailingWhitespaceFromContent()
    {
        var artifact = ArtifactDetector.Extract("```html\n<div>hi</div>\n\n\n```");

        Assert.Equal("<div>hi</div>", artifact!.Value.Content);
    }

    [Fact]
    public void Extract_ReturnsOnlyTheFirstQualifyingFenceWhenTwoArePresent()
    {
        var artifact = ArtifactDetector.Extract("```html\n<a></a>\n```\nsome text\n```mermaid\ngraph TD\n```");

        Assert.Equal("html", artifact!.Value.Language);
    }

    [Fact]
    public void Extract_SkipsANonQualifyingFenceToFindALaterQualifyingOne()
    {
        var artifact = ArtifactDetector.Extract("```python\nprint(1)\n```\n```mermaid\ngraph TD\n```");

        Assert.Equal("mermaid", artifact!.Value.Language);
    }

    [Fact]
    public void AssignVersion_StartsANewThreadWhenHistoryIsEmpty()
    {
        var artifact = new DetectedArtifact("html", "<div>v1</div>", "```html\n<div>v1</div>\n```");

        var versioned = ArtifactDetector.AssignVersion(artifact, System.Array.Empty<VersionedArtifact>());

        Assert.Equal(1, versioned.VersionIndex);
        Assert.StartsWith("html-", versioned.ThreadId);
    }

    [Fact]
    public void AssignVersion_GroupsIntoTheSameThreadWhenContentOverlapsEnough()
    {
        var first = new DetectedArtifact("html", "<div>\nline one\nline two\nline three\n</div>", "");
        var v1 = ArtifactDetector.AssignVersion(first, System.Array.Empty<VersionedArtifact>());

        // Same 4 lines plus one new line -- well above the 0.3 overlap threshold.
        var second = new DetectedArtifact("html", "<div>\nline one\nline two\nline three\nline four\n</div>", "");
        var v2 = ArtifactDetector.AssignVersion(second, new[] { v1 });

        Assert.Equal(v1.ThreadId, v2.ThreadId);
        Assert.Equal(2, v2.VersionIndex);
    }

    [Fact]
    public void AssignVersion_StartsANewThreadWhenContentDoesNotOverlapEnough()
    {
        var first = new DetectedArtifact("html", "<div>completely different content here</div>", "");
        var v1 = ArtifactDetector.AssignVersion(first, System.Array.Empty<VersionedArtifact>());

        var second = new DetectedArtifact("html", "<span>nothing at all shared</span>", "");
        var v2 = ArtifactDetector.AssignVersion(second, new[] { v1 });

        Assert.NotEqual(v1.ThreadId, v2.ThreadId);
        Assert.Equal(1, v2.VersionIndex);
    }

    [Fact]
    public void AssignVersion_OnlyComparesAgainstTheSameLanguage()
    {
        var htmlArtifact = new DetectedArtifact("html", "<div>\nline one\nline two\nline three\n</div>", "");
        var v1 = ArtifactDetector.AssignVersion(htmlArtifact, System.Array.Empty<VersionedArtifact>());

        // Identical content, different language -- must not join the HTML thread.
        var mermaidArtifact = new DetectedArtifact("mermaid", "<div>\nline one\nline two\nline three\n</div>", "");
        var v2 = ArtifactDetector.AssignVersion(mermaidArtifact, new[] { v1 });

        Assert.NotEqual(v1.ThreadId, v2.ThreadId);
        Assert.StartsWith("mermaid-", v2.ThreadId);
    }

    [Fact]
    public void AssignVersion_TwoIndependentEmptyHistoriesStillGetDistinctThreadIds()
    {
        // The reference's own reasoning for a module-level (not
        // history.Count-derived) counter: a caller may thread against
        // more than one independent history list, and each starts at
        // Count == 0 -- a counter tied to any single list's length could
        // produce the SAME threadId for two genuinely unrelated
        // artifacts once merged. This is the property that reasoning is
        // actually for, not just "produces distinct ids" in general.
        var artifactA = new DetectedArtifact("html", "<div>a</div>", "");
        var artifactB = new DetectedArtifact("html", "<div>b</div>", "");

        var versionedA = ArtifactDetector.AssignVersion(artifactA, System.Array.Empty<VersionedArtifact>());
        var versionedB = ArtifactDetector.AssignVersion(artifactB, System.Array.Empty<VersionedArtifact>());

        Assert.NotEqual(versionedA.ThreadId, versionedB.ThreadId);
    }

    [Fact]
    public void AssignVersion_UsesTheMostRecentSameLanguageEntryNotTheFirst()
    {
        var history = new List<VersionedArtifact>
        {
            new("html", "<div>\nalpha\nbeta\ngamma\n</div>", "html-0", 1),
            new("html", "<div>\ndelta\nepsilon\nzeta\n</div>", "html-1", 1),
        };

        var next = new DetectedArtifact("html", "<div>\ndelta\nepsilon\nzeta\ntheta\n</div>", "");
        var versioned = ArtifactDetector.AssignVersion(next, history);

        Assert.Equal("html-1", versioned.ThreadId);
        Assert.Equal(2, versioned.VersionIndex);
    }
}
