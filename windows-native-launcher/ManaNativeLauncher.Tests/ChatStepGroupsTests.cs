using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1318: the chat's step-group lines -- grouping, wording, counts, file
// names, +/- totals and the running state -- and GET /agent/activity's steps.
public class ChatStepGroupsTests
{
    private static AgentStep Step(string kind, string status = "done", string? file = null, int? added = null, int? removed = null, string? description = null) =>
        new(Guid.NewGuid().ToString(), kind, description, status, File: file, Added: added, Removed: removed);

    private static StepGroup Single(bool running, params AgentStep[] steps) =>
        Assert.Single(ChatStepGroups.Group(new AgentSteps("r1", running, steps)));

    [Fact]
    public void CreatedFileIsNamedThenCommand()
    {
        var group = Single(false, Step("file_create", file: "node-bot/vault_1318.py", added: 19, removed: 0), Step("command"));

        Assert.Equal("Created vault_1318.py, ran a command", group.Line);
        Assert.True(group.ChangedFiles);
        Assert.Equal(19, group.Added);
        Assert.Equal(0, group.Removed);
    }

    [Fact]
    public void OtherKindsRollIntoUsedNToolsLast()
    {
        var group = Single(false, Step("tool"), Step("command"), Step("mystery"), Step("tool"), Step("tool"));

        Assert.Equal("Ran a command, used 4 tools", group.Summary);
        Assert.False(group.ChangedFiles);
    }

    [Theory]
    [InlineData("Browsed the web, used a tool", "web", "tool")]
    [InlineData("Read 3 files, searched the repo", "read", "read", "search", "read", "search")]
    [InlineData("Ran 2 commands", "command", "command")]
    [InlineData("Edited 2 files", "file_edit", "file_edit")]
    [InlineData("Ran an agent", "agent")]
    public void Wording(string expected, params string[] kinds) =>
        Assert.Equal(expected, ChatStepGroups.Summarize(kinds.Select(k => Step(k)).ToList()));

    [Fact]
    public void SingleEditNamesTheFileAndSumsLines()
    {
        var group = Single(false, Step("file_edit", file: @"windows-native-launcher\ChatView.cs", added: 5, removed: 3), Step("file_create", file: "a/b.js", added: 10));

        Assert.Equal("Edited ChatView.cs, created b.js", group.Summary);
        Assert.Equal(15, group.Added);
        Assert.Equal(3, group.Removed);
    }

    [Fact]
    public void FileStepWithoutAPathStillReads() =>
        Assert.Equal("Created a file", ChatStepGroups.Summarize(new[] { Step("file_create") }));

    [Fact]
    public void RunningGroupShowsEllipsisAndCurrentStep()
    {
        var group = Single(true, Step("command", description: "Run the tests"), Step("tool", "running", description: "Look up the weather"));

        Assert.True(group.Running);
        Assert.Equal("Ran a command, used a tool… Look up the weather", group.Line);
    }

    [Fact]
    public void AwaitingApprovalCountsAsRunning() =>
        Assert.True(Single(false, Step("command", "awaiting_approval")).Running);

    [Fact]
    public void FinishedReplyIsNotRunning()
    {
        var group = Single(false, Step("command", description: "Run the tests"));

        Assert.False(group.Running);
        Assert.Equal("Ran a command", group.Line);
    }

    [Fact]
    public void TextBetweenToolRoundsSplitsGroupsAndOnlyTheLastRuns()
    {
        var groups = ChatStepGroups.Group(new AgentSteps("r1", true, new[]
        {
            Step("file_create", file: "x.py"), Step("command"), Step("text"), Step("web"), Step("tool"),
        }));

        Assert.Equal(new[] { "Created x.py, ran a command", "Browsed the web, used a tool" }, groups.Select(g => g.Summary));
        Assert.False(groups[0].Running);
        Assert.True(groups[1].Running);
    }

    [Fact]
    public void EachSegmentStartsItsOwnGroup()
    {
        AgentStep Seg(string kind, int segment) => Step(kind) with { Segment = segment };
        var groups = ChatStepGroups.Group(new AgentSteps("r1", true, new[] { Seg("command", 0), Seg("tool", 0), Seg("web", 1) }));

        Assert.Equal(new[] { "Ran a command, used a tool", "Browsed the web" }, groups.Select(g => g.Summary));
        Assert.Equal(new int?[] { 0, 1 }, groups.Select(g => g.Segment));
        Assert.False(groups[0].Running);
        Assert.True(groups[1].Running);
    }

    [Fact]
    public void BlocksShowTotalsAsTheirOwnRunsAndStepsWhenOpen()
    {
        var step = new AgentStep("s1", "file_create", "Write it", "done", File: "x.py", Added: 19, Removed: 0, Command: "write x.py", ResultPreview: "ok");
        var group = Single(false, step);

        var closed = ChatStepGroups.Blocks(group, false, DateTimeOffset.UtcNow);
        Assert.Equal(new[] { "Created x.py", "  +19", " −0", "  ›" }, Assert.Single(closed).Runs.Select(r => r.Text));

        var open = ChatStepGroups.Blocks(group, true, DateTimeOffset.UtcNow);
        Assert.Equal(new[] { MarkdownBlockType.Paragraph, MarkdownBlockType.BulletItem, MarkdownBlockType.CodeBlock }, open.Select(b => b.Type));
        Assert.Equal("$ write x.py\n\nok", open[2].Runs[0].Text);
    }

    [Fact]
    public void StepColorsTotalsOnly()
    {
        Assert.Equal(DarkTheme.Green, ChatView.StepColor("  +19"));
        Assert.Equal(ChatStepsStrip.RemovedColor, ChatView.StepColor(" −3"));
        Assert.Equal(DarkTheme.Muted, ChatView.StepColor("Created x.py"));
        Assert.Equal(DarkTheme.Muted, ChatView.StepColor("+"));
    }

    [Fact]
    public void ChatViewPlacesEachSegmentsLineAfterItsTextWithoutRepeatingTheReply()
    {
        using var view = new ChatView();
        AgentStep Seg(string id, int segment) => new(id, "command", "Run it", "done", Segment: segment);
        view.AppendUserMessage("hi");
        view.AppendReplySentence("Let me check.");
        view.ShowSteps(new AgentSteps("r1", true, new[] { Seg("a", 0) }));
        view.AppendReplySentence("Now the web.");
        view.ShowSteps(new AgentSteps("r1", true, new[] { Seg("a", 0), Seg("b", 1) }));
        view.AppendReplySentence("Done.");
        view.ShowSteps(new AgentSteps("r1", false, new[] { Seg("a", 0), Seg("b", 1) }));
        view.ReportReply("Let me check. Now the web. Done.");

        Assert.Equal(new[] { "Let me check.", "Ran a command  ›", "Now the web.", "Ran a command  ›", "Done." },
            view.Messages.Skip(1).Select(m => m.PlainText));
    }

    [Fact]
    public void NoStepsNoGroups() =>
        Assert.Empty(ChatStepGroups.Group(new AgentSteps(null, true, Array.Empty<AgentStep>())));

    [Fact]
    public void StepLineHasDescriptionStatusAndDuration()
    {
        var start = DateTimeOffset.Parse("2026-10-03T10:00:00Z");
        var step = new AgentStep("s1", "command", "Run the tests", "awaiting_approval", start, start.AddSeconds(65));

        Assert.Equal("Run the tests · awaiting approval · 1m 05s", ChatStepGroups.StepLine(step, start.AddHours(1)));
        Assert.Equal("coding__x · running · 4s",
            ChatStepGroups.StepLine(new AgentStep("s2", "tool", null, "running", start, Tool: "coding__x"), start.AddSeconds(4)));
    }

    [Fact]
    public async Task GetAgentStepsAsync_ParsesStepsAndToleratesMissingFields()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/agent/activity", request.RequestUri!.AbsolutePath);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """
                    {"runs":[],"runId":"7","running":true,"steps":[
                      {"id":"s1","kind":"file_create","tool":"coding__write_file","description":"Write the vault script","status":"done",
                       "startedAt":"2026-10-03T10:00:00Z","endedAt":"2026-10-03T10:00:02Z","file":"node-bot/vault_1318.py","added":19,"removed":0,
                       "detail":{"command":null,"resultPreview":"ok"}},
                      {"id":"s2"}
                    ]}
                    """,
                    Encoding.UTF8,
                    "application/json"),
            };
        });

        var activity = await new ManaBackendClient(handler).GetAgentStepsAsync();

        Assert.Equal("7", activity.RunId);
        Assert.True(activity.Running);
        Assert.Equal(2, activity.Steps.Count);
        var first = activity.Steps[0];
        Assert.Equal("file_create", first.Kind);
        Assert.Equal(19, first.Added);
        Assert.Equal("node-bot/vault_1318.py", first.File);
        Assert.Null(first.Command);
        Assert.Equal("ok", first.ResultPreview);
        Assert.Equal(TimeSpan.FromSeconds(2), first.Duration(DateTimeOffset.UtcNow));
        Assert.Equal("tool", activity.Steps[1].Kind);
        Assert.Null(activity.Steps[1].StartedAt);
        Assert.Equal("Created vault_1318.py, used a tool…", ChatStepGroups.Group(activity).Single().Line);
    }

    // #1337: an agent step that started a task is its own line, not "ran an agent".
    [Fact]
    public void AgentWithATaskGetsItsOwnLine()
    {
        var agent = new AgentStep("a1", "agent", "Start an agent", "done", Segment: 0, TaskId: "t9", Title: "Draft Folio M6 + optional track");
        var groups = ChatStepGroups.Group(new AgentSteps("r1", false, new[]
        {
            Step("command") with { Segment = 0 }, Step("command") with { Segment = 0 }, agent, Step("tool") with { Segment = 0 },
        }));

        Assert.Equal(new[] { "Ran 2 commands", "Draft Folio M6 + optional track", "Used a tool" }, groups.Select(g => g.Line));
        Assert.Equal("t9", groups[1].TaskId);
        Assert.Null(groups[0].TaskId);
        Assert.Equal("Draft Folio M6 + optional track  ›", string.Concat(ChatStepGroups.Blocks(groups[1], true, DateTimeOffset.UtcNow).Single().Runs.Select(r => r.Text)));
    }

    [Fact]
    public void TaskNoticeSaysHowItEnded()
    {
        Assert.Equal("Background task completed · View umbrella issues 169-175", ChatStepGroups.TaskNotice("t1", "View umbrella issues 169-175", "done", null).Line);
        Assert.Equal("Background task failed", ChatStepGroups.TaskNotice("t1", null, "failed", null).Line);
        Assert.Equal("t1", ChatStepGroups.TaskNotice("t1", null, "done", "Done").TaskId);
    }

    // #1337: a saved reply: text, steps line, text, agent line, text.
    [Fact]
    public void InterleaveCutsTheTextAtEachGroupsOffset()
    {
        const string text = "Looking first. Found it. All three are drafting.";
        var pieces = ChatStepGroups.Interleave(text, new[]
        {
            new AgentStep("s1", "command", null, "done", Segment: 0, TextOffset: 14),
            new AgentStep("s2", "read", null, "done", Segment: 0, TextOffset: 14),
            new AgentStep("a1", "agent", null, "done", Segment: 1, TextOffset: 24, TaskId: "t1", Title: "Draft M6"),
        });

        Assert.Equal(new[] { "Looking first.", "Ran a command, read a file", "Found it.", "Draft M6", "All three are drafting." },
            pieces.Select(p => p.Text ?? p.Group!.Line));
    }

    [Fact]
    public void InterleaveWithoutStepsOrOffsetsKeepsTheTextFirst()
    {
        Assert.Equal("Hi.", Assert.Single(ChatStepGroups.Interleave("Hi.", Array.Empty<AgentStep>())).Text);
        var pieces = ChatStepGroups.Interleave("Hi.", new[] { new AgentStep("s1", "command", null, "done", TextOffset: 99) });
        Assert.Equal(new[] { "Hi.", null }, pieces.Select(p => p.Text));
    }

    // #1337: saved steps and "background task ended" events in a session's history.
    [Fact]
    public async Task GetSessionDetailAsync_ReadsSavedStepsAndTaskEvents()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """
                {"turns":[
                  {"user":"go","assistant":"On it. Done.","steps":[{"id":"s1","kind":"command","status":"done","segment":0,"textOffset":6}]},
                  {"role":"event","kind":"background_task","taskId":"t1","title":"Draft M6","status":"done","at":"2026-10-03T10:00:00Z","text":"Background task completed"},
                  {"role":"event","kind":"something_else"},
                  {"user":"old","assistant":"No steps."}
                ]}
                """,
                Encoding.UTF8,
                "application/json"),
        });

        var turns = (await new ManaBackendClient(handler).GetSessionDetailAsync("c1"))!.RecentTurns;

        Assert.Equal(3, turns.Count);
        Assert.Equal(6, Assert.Single(turns[0].Steps).TextOffset);
        Assert.Equal(new ManaTaskNotice("t1", "Draft M6", "done", "Background task completed"), turns[1].Notice);
        Assert.Empty(turns[2].Steps);
    }
}
