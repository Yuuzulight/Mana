using System;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1318: the words on a background task's card and transcript.
public class BackgroundTaskTextTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(-5, "0s")]
    [InlineData(38, "38s")]
    [InlineData(60, "1m")]
    [InlineData(252, "4m 12s")]
    [InlineData(3600, "1h")]
    [InlineData(3900, "1h 5m")]
    [InlineData(90000, "25h")]
    public void Elapsed(int seconds, string expected) =>
        Assert.Equal(expected, BackgroundTaskText.Elapsed(TimeSpan.FromSeconds(seconds)));

    [Theory]
    [InlineData(1, "1 token")]
    [InlineData(950, "950 tokens")]
    [InlineData(1000, "1k tokens")]
    [InlineData(71500, "71.5k tokens")]
    [InlineData(999_960, "1M tokens")]
    [InlineData(1_234_567, "1.2M tokens")]
    public void Tokens(double tokens, string expected) => Assert.Equal(expected, BackgroundTaskText.Tokens(tokens));

    [Fact]
    public void ToolUsesAndKind()
    {
        Assert.Equal("1 tool use", BackgroundTaskText.ToolUses(1));
        Assert.Equal("7 tool uses", BackgroundTaskText.ToolUses(7));
        Assert.Equal("Agent", BackgroundTaskText.Kind("agent"));
        Assert.Equal("Self-work", BackgroundTaskText.Kind("self-work"));
        Assert.Equal("Task", BackgroundTaskText.Kind(""));
    }

    [Fact]
    public void Card_FullAndToday()
    {
        var full = new ManaBackgroundTask
        {
            Id = "a", Kind = "agent", Title = "Mana #1318", Status = "running", StartedAt = Now.AddSeconds(-38),
            Model = "Qwen3.5-9B", Tokens = 71500, ToolUses = 7, CurrentAction = "Running a command", Detail = "old detail",
        };
        Assert.Equal("Agent 38s · Qwen3.5-9B · 71.5k tokens · 7 tool uses", BackgroundTaskText.Meta(full, Now));
        Assert.Equal("Running a command", BackgroundTaskText.Action(full));
        Assert.Equal("Mana #1318, Agent 38s, Qwen3.5-9B, 71.5k tokens, 7 tool uses, Running a command", BackgroundTaskText.CardName(full, Now));

        // A backend from before #1318: no stats, its detail as the action.
        var today = new ManaBackgroundTask { Id = "b", Kind = "memory", Title = "Indexing", Status = "running", Detail = "Working on it" };
        Assert.Equal("Memory", BackgroundTaskText.Meta(today, Now));
        Assert.Equal("Working on it", BackgroundTaskText.Action(today));
        Assert.Equal("Indexing, Memory, Working on it", BackgroundTaskText.CardName(today, Now));

        // Finished: elapsed stops at its end.
        var done = new ManaBackgroundTask { Kind = "agent", StartedAt = Now.AddMinutes(-10), EndedAt = Now.AddMinutes(-9) };
        Assert.Equal("Agent 1m", BackgroundTaskText.Headline(done, Now));
    }

    [Fact]
    public void Steps()
    {
        var run = new ManaTaskStep
        {
            Kind = "command", Description = "Run the self-work tests", Status = "done", StartedAt = Now.AddSeconds(-10), EndedAt = Now.AddSeconds(-6),
            Command = "node --test\ntest/x.test.js", ResultPreview = "ok 1\r\nok 2\n",
        };
        Assert.Equal("Run the self-work tests · Done · 4s", BackgroundTaskText.StepLine(run, Now));
        Assert.Equal(new[] { "Command: node --test test/x.test.js", "Result:", "  ok 1", "  ok 2" }, BackgroundTaskText.StepDetail(run));

        var edit = new ManaTaskStep { Kind = "file_edit", Tool = "coding__edit", Status = "awaiting_approval", StartedAt = Now.AddSeconds(-2), File = "x.py", Added = 19, Removed = 0 };
        Assert.Equal("coding__edit · Waiting for approval · 2s", BackgroundTaskText.StepLine(edit, Now));
        Assert.Equal(new[] { "File: x.py  +19 −0" }, BackgroundTaskText.StepDetail(edit));
        Assert.Empty(BackgroundTaskText.StepDetail(new ManaTaskStep { Status = "running" }));
        Assert.Equal("Tool · Running", BackgroundTaskText.StepLine(new ManaTaskStep { Kind = "tool", Status = "running" }, Now));
    }
}
