using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Mana.NativeLauncher;

// #1318: one step of a chat reply from GET /agent/activity (see the
// contract in the issue). Everything but the id is optional on the wire.
internal sealed record AgentStep(
    string Id,
    string Kind,
    string? Description,
    string Status,
    DateTimeOffset? StartedAt = null,
    DateTimeOffset? EndedAt = null,
    string? File = null,
    int? Added = null,
    int? Removed = null,
    string? Command = null,
    string? ResultPreview = null,
    string? Tool = null)
{
    public bool IsRunning => Status is "running" or "awaiting_approval";

    public string StatusLabel => Status switch
    {
        "awaiting_approval" => "awaiting approval",
        "" => "done",
        _ => Status,
    };

    public TimeSpan? Duration(DateTimeOffset now) =>
        StartedAt is { } start ? (EndedAt ?? now) - start : null;
}

// #1318: the reply's steps in order, plus whether the reply is still going.
internal sealed record AgentSteps(string? RunId, bool Running, IReadOnlyList<AgentStep> Steps);

// #1318: a run of consecutive tool steps, summed up as one grey chat line:
// "Created vault_1318.py, ran a command", "Ran a command, used 4 tools...".
internal sealed class StepGroup
{
    public StepGroup(IReadOnlyList<AgentStep> steps, bool running)
    {
        Steps = steps;
        Running = running;
    }

    public IReadOnlyList<AgentStep> Steps { get; }
    public bool Running { get; }

    public bool ChangedFiles => Steps.Any(s => s.Kind is "file_create" or "file_edit" || s.Added > 0 || s.Removed > 0);
    public int Added => Steps.Sum(s => s.Added ?? 0);
    public int Removed => Steps.Sum(s => s.Removed ?? 0);

    // The step being worked on: the running one, else the latest.
    public string? CurrentDescription =>
        (Steps.LastOrDefault(s => s.IsRunning) ?? Steps.LastOrDefault())?.Description;

    public string Summary => ChatStepGroups.Summarize(Steps);

    // The whole grey line, minus the +/- totals the control colours itself.
    public string Line => Running
        ? $"{Summary}… {CurrentDescription}".TrimEnd()
        : Summary;
}

internal static class ChatStepGroups
{
    // Kinds that aren't tool steps (text the reply wrote between tool
    // rounds) end a group. The contract has none yet, so today a reply's
    // steps are one group.
    private static bool IsToolStep(AgentStep step) => step.Kind is not ("text" or "message");

    public static IReadOnlyList<StepGroup> Group(AgentSteps activity)
    {
        var groups = new List<List<AgentStep>>();
        List<AgentStep>? current = null;
        foreach (var step in activity.Steps)
        {
            if (!IsToolStep(step))
            {
                current = null;
                continue;
            }
            if (current is null)
            {
                current = new List<AgentStep>();
                groups.Add(current);
            }
            current.Add(step);
        }
        // The last group is still going while the reply is (she may be about
        // to call the next tool); any group with a running step is too.
        return groups.Select((g, i) => new StepGroup(g,
            g.Any(s => s.IsRunning) || (activity.Running && i == groups.Count - 1 && current is not null))).ToList();
    }

    public static string Summarize(IReadOnlyList<AgentStep> steps)
    {
        var parts = new List<string>();
        var otherTools = 0;
        foreach (var kind in steps.Select(s => Normalize(s.Kind)).Distinct())
        {
            var ofKind = steps.Where(s => Normalize(s.Kind) == kind).ToList();
            var n = ofKind.Count;
            switch (kind)
            {
                case "command":
                    parts.Add(n == 1 ? "ran a command" : $"ran {n} commands");
                    break;
                case "file_create":
                    parts.Add(n == 1 ? $"created {FileName(ofKind[0])}" : $"created {n} files");
                    break;
                case "file_edit":
                    parts.Add(n == 1 ? $"edited {FileName(ofKind[0])}" : $"edited {n} files");
                    break;
                case "web":
                    parts.Add("browsed the web");
                    break;
                case "search":
                    parts.Add("searched the repo");
                    break;
                case "read":
                    parts.Add(n == 1 ? "read a file" : $"read {n} files");
                    break;
                case "agent":
                    parts.Add(n == 1 ? "ran an agent" : $"ran {n} agents");
                    break;
                default:
                    otherTools += n;
                    break;
            }
        }
        if (otherTools > 0)
        {
            parts.Add(otherTools == 1 ? "used a tool" : $"used {otherTools} tools");
        }
        if (parts.Count == 0)
        {
            return "";
        }
        var text = string.Join(", ", parts);
        return char.ToUpperInvariant(text[0]) + text[1..];
    }

    private static string Normalize(string? kind) => kind switch
    {
        "command" or "file_create" or "file_edit" or "web" or "search" or "read" or "agent" => kind,
        _ => "tool",
    };

    private static string FileName(AgentStep step) =>
        string.IsNullOrWhiteSpace(step.File) ? "a file" : Path.GetFileName(step.File.Replace('\\', '/').TrimEnd('/'));

    public static string FormatDuration(TimeSpan duration)
    {
        var ms = Math.Max(0, (long)duration.TotalMilliseconds);
        return ms < 1000 ? $"{ms}ms" : ms < 60_000 ? $"{ms / 1000}s" : $"{ms / 60_000}m {ms / 1000 % 60:00}s";
    }

    // One expanded step: "Run the self-work tests - done - 4s".
    public static string StepLine(AgentStep step, DateTimeOffset now)
    {
        var parts = new List<string> { string.IsNullOrWhiteSpace(step.Description) ? step.Tool ?? step.Kind : step.Description!, step.StatusLabel };
        if (step.Duration(now) is { } d)
        {
            parts.Add(FormatDuration(d));
        }
        return string.Join(" · ", parts);
    }
}
