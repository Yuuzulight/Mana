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
}
