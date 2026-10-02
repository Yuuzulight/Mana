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
    string? Tool = null,
    int? Segment = null,
    // #1337: the reply text shown before its round (UTF-16 chars), and the
    // background task an agent step started (its id and title).
    int? TextOffset = null,
    string? TaskId = null,
    string? Title = null)
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

    // Which run of reply text it follows; null when the backend sends none.
    public int? Segment => Steps[0].Segment;

    public IReadOnlyList<AgentStep> Steps { get; }
    public bool Running { get; }

    public bool ChangedFiles => Steps.Any(s => s.Kind is "file_create" or "file_edit" || s.Added > 0 || s.Removed > 0);
    public int Added => Steps.Sum(s => s.Added ?? 0);
    public int Removed => Steps.Sum(s => s.Removed ?? 0);

    // The step being worked on: the running one, else the latest.
    public string? CurrentDescription =>
        (Steps.LastOrDefault(s => s.IsRunning) ?? Steps.LastOrDefault())?.Description;

    public string Summary => ChatStepGroups.Summarize(Steps);

    // #1337: a sub-agent or background job's own line, which opens its
    // transcript; Notice ("Background task completed") makes it the line
    // saying that task ended.
    public string? TaskId => Steps.Count == 1 && Steps[0].TaskId is { Length: > 0 } id ? id : null;
    public string? Notice { get; init; }

    // The whole grey line, minus the +/- totals the control colours itself.
    public string Line => TaskId is not null ? TaskLine
        : Running ? $"{Summary}… {CurrentDescription}".TrimEnd()
        : Summary;

    private string TaskLine
    {
        get
        {
            var title = Steps[0].Title ?? Steps[0].Description;
            if (Notice is not null)
            {
                return string.IsNullOrWhiteSpace(title) ? Notice : $"{Notice} · {title}";
            }
            title = string.IsNullOrWhiteSpace(title) ? "Background task" : title;
            return Steps[0].Status == "failed" ? $"{title} · failed" : title;
        }
    }
}

internal static class ChatStepGroups
{
    // A new segment (she wrote reply text between tool rounds) starts a new
    // group; so does a non-tool step, should the backend ever send one.
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
            // #1337: an agent step that started a task gets a line of its own.
            if (current is null || current[^1].Segment != step.Segment || step.TaskId is { Length: > 0 } || current[0].TaskId is { Length: > 0 })
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

    // #1337: a saved reply's text cut at its groups' textOffsets, in order:
    // text, group, text... A group without one goes at the end.
    // ponytail: a cut inside a code block or table splits it in two; the
    // backend's offsets fall between rounds, where that's rare.
    public static List<(string? Text, StepGroup? Group)> Interleave(string text, IReadOnlyList<AgentStep> steps)
    {
        var pieces = new List<(string? Text, StepGroup? Group)>();
        void AddText(string piece)
        {
            if (!string.IsNullOrWhiteSpace(piece))
            {
                pieces.Add((piece.Trim(), null));
            }
        }
        var at = 0;
        foreach (var group in Group(new AgentSteps(null, false, steps)).OrderBy(g => g.Steps[0].TextOffset ?? text.Length))
        {
            var cut = Math.Clamp(group.Steps[0].TextOffset ?? text.Length, at, text.Length);
            AddText(text[at..cut]);
            pieces.Add((null, group));
            at = cut;
        }
        AddText(text[at..]);
        return pieces;
    }

    // #1337: the line a finished background task leaves in its chat.
    public static StepGroup TaskNotice(string taskId, string? title, string? status, string? text) =>
        new(new[] { new AgentStep(taskId, "agent", null, status ?? "done", TaskId: taskId, Title: title) }, false)
        {
            Notice = !string.IsNullOrWhiteSpace(text) ? text
                : status == "failed" ? "Background task failed" : "Background task completed",
        };

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

    // Markers ChatView colours green/red in a step line.
    public const string AddedPrefix = "+";
    public const string RemovedPrefix = "−";

    // A group as ChatView draws it inline: the grey summary line (its +/-
    // totals and chevron as runs of their own), then, when open, a bullet
    // per step and each step's command and result as a code block.
    public static List<MarkdownBlock> Blocks(StepGroup group, bool open, DateTimeOffset now)
    {
        static MarkdownRun Run(string text) => new(text, false, false, false);
        var head = new List<MarkdownRun> { Run(group.Line) };
        if (group.TaskId is not null)
        {
            // Opens the task's transcript rather than expanding.
            head.Add(Run("  ›"));
            return new List<MarkdownBlock> { new(MarkdownBlockType.Paragraph, head) };
        }
        if (group.ChangedFiles)
        {
            head.Add(Run($"  {AddedPrefix}{group.Added}"));
            head.Add(Run($" {RemovedPrefix}{group.Removed}"));
        }
        head.Add(Run(open ? "  ⌄" : "  ›"));
        var blocks = new List<MarkdownBlock> { new(MarkdownBlockType.Paragraph, head) };
        if (!open)
        {
            return blocks;
        }
        foreach (var step in group.Steps)
        {
            blocks.Add(new(MarkdownBlockType.BulletItem, new[] { Run(StepLine(step, now)) }));
            var detail = string.Join("\n\n", new[] { step.Command is { Length: > 0 } c ? "$ " + c : null, step.ResultPreview }
                .Where(t => !string.IsNullOrWhiteSpace(t)));
            if (detail.Length > 0)
            {
                blocks.Add(new(MarkdownBlockType.CodeBlock, new[] { Run(detail) }));
            }
        }
        return blocks;
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
