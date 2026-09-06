using System;
using System.Collections.Generic;

namespace Mana.NativeLauncher;

// #577: ports windows-launcher/renderer.js's own formatResearchReply
// verbatim -- report text, then a Sources list, a Searched: subQueries
// line, and an early-stop note, in that order, each section blank-line
// separated and omitted entirely when its underlying data is empty.
internal static class ResearchFormatter
{
    public static string FormatReply(ManaResearchResult result)
    {
        var lines = new List<string> { result.Report, "" };

        if (result.Sources.Count > 0)
        {
            lines.Add("Sources:");
            foreach (var source in result.Sources)
            {
                var suffix = source.ReadFailed ? " (couldn't be read; used search snippet)" : "";
                var title = string.IsNullOrEmpty(source.Title) ? source.Url : source.Title;
                lines.Add($"[{source.Index}] {title} - {source.Url}{suffix}");
            }
        }

        if (result.SubQueries.Count > 0)
        {
            lines.Add("");
            lines.Add($"Searched: {string.Join(" | ", result.SubQueries)}");
        }

        if (result.Bounds is { } bounds && (bounds.HitTimeLimit || bounds.HitSourceLimit))
        {
            lines.Add("");
            var timeNote = bounds.HitTimeLimit ? $", {Math.Round(bounds.ElapsedMs / 1000.0)}s time budget reached" : "";
            lines.Add($"(Stopped early: {bounds.SourcesUsed} of up to {bounds.MaxSources} sources read{timeNote}.)");
        }

        return string.Join("\n", lines);
    }
}
