using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

internal readonly record struct DetectedArtifact(string Language, string Content, string MatchedText);

internal readonly record struct VersionedArtifact(string Language, string Content, string ThreadId, int VersionIndex);

// #528: ports windows-launcher/renderer/artifact-detector.js verbatim --
// pure, DOM-free logic deciding whether a reply contains content
// substantial enough for its own standalone viewer, and which "version
// thread" a newly detected artifact belongs to. The actual rendering
// (MermaidParser/MermaidLayout/ArtifactViewerForm) is untested WinForms/
// GDI+-coupled code, same split the reference itself uses (this part
// doesn't need a DOM, the renderer does).
internal static class ArtifactDetector
{
    public const int ArtifactMinChars = 400;
    private static readonly HashSet<string> AlwaysArtifactLanguages = new(System.StringComparer.Ordinal) { "html", "mermaid" };
    private const double SameArtifactLineOverlapThreshold = 0.3;

    private static readonly Regex FencePattern = new(@"```(\w*)\r?\n([\s\S]*?)```", RegexOptions.Compiled);

    // Returns the first artifact-worthy fenced block in text, or null --
    // only the first match, a reply naming a second one is treated as
    // chat content, not a second artifact.
    public static DetectedArtifact? Extract(string? markdownText)
    {
        var text = markdownText ?? "";
        foreach (Match match in FencePattern.Matches(text))
        {
            var language = match.Groups[1].Value.ToLowerInvariant();
            var content = match.Groups[2].Value;
            if (AlwaysArtifactLanguages.Contains(language) || content.Length >= ArtifactMinChars)
            {
                return new DetectedArtifact(
                    language.Length > 0 ? language : "text",
                    content.TrimEnd(),
                    match.Value);
            }
        }
        return null;
    }

    // Groups a newly detected artifact into the version thread of the
    // most recent same-language entry in history, when the two share
    // enough content to plausibly be revisions of one thing. history is
    // not mutated -- the caller decides whether/where to store the
    // returned, enriched artifact.
    //
    // A module-level, ever-incrementing thread counter (not derived from
    // history.Count) -- matches the reference's own reasoning: a caller
    // may thread against more than one independent history list, and a
    // counter tied to any single list's length could produce the same
    // threadId for two genuinely unrelated artifacts once merged.
    private static int nextNewThreadId;

    public static VersionedArtifact AssignVersion(DetectedArtifact artifact, IReadOnlyList<VersionedArtifact> history)
    {
        VersionedArtifact? lastSameLanguage = null;
        for (var i = history.Count - 1; i >= 0; i--)
        {
            if (history[i].Language == artifact.Language)
            {
                lastSameLanguage = history[i];
                break;
            }
        }

        var isNewVersion = lastSameLanguage is { } last
            && LineOverlapRatio(artifact.Content, last.Content) >= SameArtifactLineOverlapThreshold;
        var threadId = isNewVersion ? lastSameLanguage!.Value.ThreadId : $"{artifact.Language}-{nextNewThreadId++}";

        var versionIndex = 1;
        if (isNewVersion)
        {
            var count = 0;
            foreach (var entry in history)
            {
                if (entry.ThreadId == threadId)
                {
                    count++;
                }
            }
            versionIndex = count + 1;
        }

        return new VersionedArtifact(artifact.Language, artifact.Content, threadId, versionIndex);
    }

    private static double LineOverlapRatio(string contentA, string contentB)
    {
        var linesA = NonEmptyTrimmedLines(contentA);
        var linesB = NonEmptyTrimmedLines(contentB);
        if (linesA.Count == 0 || linesB.Count == 0)
        {
            return 0;
        }

        var shared = 0;
        foreach (var line in linesA)
        {
            if (linesB.Contains(line))
            {
                shared++;
            }
        }
        return (double)shared / System.Math.Max(linesA.Count, linesB.Count);
    }

    private static HashSet<string> NonEmptyTrimmedLines(string content)
    {
        var lines = new HashSet<string>();
        foreach (var line in content.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.Length > 0)
            {
                lines.Add(trimmed);
            }
        }
        return lines;
    }
}
