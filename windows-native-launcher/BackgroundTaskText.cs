using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Mana.NativeLauncher;

// #1318: the words on a running task's card and in its transcript window,
// kept apart from the controls so they're testable. Every #1318 field is
// optional: a missing one is left out, never shown as "0" or "unknown".
internal static class BackgroundTaskText
{
    // "38s", "4m 12s", "1h 5m".
    internal static string Elapsed(TimeSpan span)
    {
        if (span < TimeSpan.Zero)
        {
            span = TimeSpan.Zero;
        }
        if (span.TotalMinutes < 1)
        {
            return $"{(int)span.TotalSeconds}s";
        }
        if (span.TotalHours < 1)
        {
            return span.Seconds == 0 ? $"{(int)span.TotalMinutes}m" : $"{(int)span.TotalMinutes}m {span.Seconds}s";
        }
        return span.Minutes == 0 ? $"{(int)span.TotalHours}h" : $"{(int)span.TotalHours}h {span.Minutes}m";
    }

    // "950 tokens", "71.5k tokens", "1.2M tokens".
    internal static string Tokens(double tokens)
    {
        var k = Math.Round(tokens / 1000, 1);
        return tokens < 1000 ? $"{(long)tokens} {(tokens == 1 ? "token" : "tokens")}"
            : k < 1000 ? $"{k.ToString("0.#", CultureInfo.InvariantCulture)}k tokens"
            : $"{Math.Round(tokens / 1_000_000, 1).ToString("0.#", CultureInfo.InvariantCulture)}M tokens";
    }

    internal static string ToolUses(int count) => count == 1 ? "1 tool use" : $"{count} tool uses";

    internal static string Kind(string kind) => kind switch
    {
        "" => "Task",
        "self-work" => "Self-work",
        _ => char.ToUpperInvariant(kind[0]) + kind[1..],
    };

    // How long it ran: to now while running, to its end once it has one.
    internal static TimeSpan? Duration(DateTimeOffset? started, DateTimeOffset? ended, DateTimeOffset now) =>
        started is { } s ? (ended ?? now) - s : null;

    // "Agent 38s"; just "Agent" without a start time.
    internal static string Headline(ManaBackgroundTask task, DateTimeOffset now) =>
        Duration(task.StartedAt, task.EndedAt, now) is { } d ? $"{Kind(task.Kind)} {Elapsed(d)}" : Kind(task.Kind);

    // "Qwen3.5-9B · 71.5k tokens · 7 tool uses", whichever are known.
    internal static string Stats(ManaBackgroundTask task) => Join(" · ",
        task.Model,
        task.Tokens is { } t ? Tokens(t) : null,
        task.ToolUses is { } u ? ToolUses(u) : null);

    // "Running a command"; a pre-#1318 backend's detail line otherwise.
    internal static string Action(ManaBackgroundTask task) =>
        !string.IsNullOrWhiteSpace(task.CurrentAction) ? task.CurrentAction! : task.Detail ?? "";

    // The card's line under the title, and its screen-reader name.
    internal static string Meta(ManaBackgroundTask task, DateTimeOffset now) => Join(" · ", Headline(task, now), Stats(task));

    internal static string CardName(ManaBackgroundTask task, DateTimeOffset now) =>
        Join(", ", task.Title, Headline(task, now), task.Model, task.Tokens is { } t ? Tokens(t) : null, task.ToolUses is { } u ? ToolUses(u) : null, Action(task));

    internal static string StepStatus(string status) => status switch
    {
        "running" => "Running",
        "done" => "Done",
        "failed" => "Failed",
        "awaiting_approval" => "Waiting for approval",
        _ => status,
    };

    // "Run the self-work tests · Done · 4s".
    internal static string StepLine(ManaTaskStep step, DateTimeOffset now) => Join(" · ",
        string.IsNullOrWhiteSpace(step.Description) ? step.Tool ?? Kind(step.Kind) : step.Description,
        StepStatus(step.Status),
        Duration(step.StartedAt, step.EndedAt, now) is { } d ? Elapsed(d) : null);

    // What expanding a step shows: its file, command and result preview,
    // one line each (a tree node holds one line).
    internal static IReadOnlyList<string> StepDetail(ManaTaskStep step)
    {
        var lines = new List<string>();
        if (!string.IsNullOrEmpty(step.File))
        {
            var counts = step.Added is null && step.Removed is null ? "" : $"  +{step.Added ?? 0} −{step.Removed ?? 0}";
            lines.Add($"File: {step.File}{counts}");
        }
        if (!string.IsNullOrWhiteSpace(step.Command))
        {
            lines.Add($"Command: {step.Command.ReplaceLineEndings(" ")}");
        }
        if (!string.IsNullOrWhiteSpace(step.ResultPreview))
        {
            lines.Add("Result:");
            lines.AddRange(step.ResultPreview.ReplaceLineEndings("\n").TrimEnd('\n').Split('\n').Select(l => "  " + l));
        }
        return lines;
    }

    private static string Join(string separator, params string?[] parts) =>
        string.Join(separator, parts.Where(p => !string.IsNullOrWhiteSpace(p)));
}
