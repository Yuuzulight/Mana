using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1125: GET /background-tasks' DTO, the panel's grouping and time/progress
// text, and the panel itself (STA, never shown, fake backend).
public class BackgroundTasksPanelTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    private const string SampleJson =
        """
        {"tasks":[
          {"id":"reminder:r1","kind":"reminder","title":"Raid","status":"scheduled","nextRunAt":"2026-10-01T12:12:00.000Z","progress":{"done":1800000,"total":2400000,"unit":"ms"},"canCancel":true},
          {"id":"retriever-embeddings","kind":"memory","title":"Indexing files for search","status":"running","startedAt":"2026-10-01T11:57:00.000Z","progress":{"done":25,"total":100,"unit":"files"},"etaSeconds":540,"canCancel":false},
          {"id":"llama-load","kind":"model","title":"Loading qwen.gguf","status":"running","startedAt":"2026-10-01T11:59:30.000Z","canCancel":false},
          {"id":"self-work","kind":"self-work","title":"#7: Fix add","status":"running","startedAt":"2026-10-01T11:58:00.000Z","progress":{"done":5,"total":20,"unit":"rounds"},"detail":"Working on it","canCancel":true},
          {"id":"odd","kind":"reminder","title":"Broken progress","status":"running","progress":{"done":1,"total":0},"canCancel":false}
        ]}
        """;

    private static ManaBackendClient ClientReturning(Func<HttpRequestMessage, HttpResponseMessage> respond) => new(new FakeHttpMessageHandler(respond));

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static ManaBackgroundTask Task(string status, ManaTaskProgress? progress = null, double? eta = null, string kind = "memory", DateTimeOffset? started = null, DateTimeOffset? next = null) =>
        new() { Id = Guid.NewGuid().ToString(), Kind = kind, Title = "T", Status = status, Progress = progress, EtaSeconds = eta, StartedAt = started, NextRunAt = next };

    [Fact]
    public async Task GetBackgroundTasksAsync_ReadsEveryField()
    {
        string? path = null;
        var tasks = await ClientReturning(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return Json(SampleJson);
        }).GetBackgroundTasksAsync();

        Assert.Equal("/background-tasks", path);
        Assert.Equal(5, tasks.Count);
        var raid = tasks[0];
        Assert.Equal(("reminder:r1", "reminder", "Raid", "scheduled"), (raid.Id, raid.Kind, raid.Title, raid.Status));
        Assert.Equal(Now.AddMinutes(12), raid.NextRunAt);
        Assert.Null(raid.StartedAt);
        Assert.Equal(new ManaTaskProgress(1800000, 2400000, "ms"), raid.Progress);
        Assert.True(raid.CanCancel);
        Assert.Equal(540, tasks[1].EtaSeconds);
        Assert.Null(tasks[2].Progress);
        Assert.Null(tasks[2].EtaSeconds);
        Assert.Equal("Working on it", tasks[3].Detail);
        Assert.Null(tasks[4].Progress); // a zero total isn't a percentage
    }

    [Fact]
    public async Task CancelBackgroundTaskAsync_PostsTheEscapedId_AndReadsEndedTasksAsFalse()
    {
        string? path = null;
        var status = HttpStatusCode.OK;
        var client = ClientReturning(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            Assert.Equal(HttpMethod.Post, request.Method);
            return Json("{}", status);
        });

        Assert.True(await client.CancelBackgroundTaskAsync("reminder:a b"));
        Assert.Equal("/background-tasks/reminder%3Aa%20b/cancel", path);
        status = HttpStatusCode.Conflict;
        Assert.False(await client.CancelBackgroundTaskAsync("heartbeat:h1"));
        status = HttpStatusCode.NotFound;
        Assert.False(await client.CancelBackgroundTaskAsync("gone"));
        status = HttpStatusCode.Unauthorized;
        await Assert.ThrowsAsync<HttpRequestException>(() => client.CancelBackgroundTaskAsync("x"));
    }

    [Fact]
    public void Group_FollowsKindOrder_RunningFirstThenSoonest()
    {
        var soon = Task("scheduled", kind: "reminder", next: Now.AddMinutes(5));
        var later = Task("scheduled", kind: "reminder", next: Now.AddHours(2));
        var running = Task("running", kind: "reminder");
        var odd = Task("running", kind: "zzz");
        var model = Task("running", kind: "model");

        var groups = BackgroundTasksPanel.Group(new[] { later, odd, soon, model, running });

        Assert.Equal(new[] { "Models", "Reminders", "zzz" }, groups.Select(g => g.Title));
        Assert.Equal(new[] { running, soon, later }, groups[1].Tasks);
    }

    [Theory]
    [InlineData("running", -3 * 60, null, "running 3 min")]
    [InlineData("running", -20, null, "running 20 s")]
    [InlineData("scheduled", null, 12 * 60, "next in 12 min")]
    [InlineData("scheduled", null, 90 * 60, "next in 1 h 30 min")]
    [InlineData("scheduled", null, 3 * 86400, "next in 3 days")]
    [InlineData("scheduled", null, -60, "due now")]
    [InlineData("failed", -120, null, "started 2 min ago")]
    [InlineData("paused", null, 60, "")]
    [InlineData("waiting", null, null, "")]
    public void When_ReadsLikeTheIssue(string status, int? startedOffset, int? nextOffset, string expected)
    {
        var task = Task(status, started: startedOffset is { } s ? Now.AddSeconds(s) : null, next: nextOffset is { } n ? Now.AddSeconds(n) : null);
        Assert.Equal(expected, BackgroundTasksPanel.When(task, Now));
    }

    [Fact]
    public void ProgressText_PercentOrCount_WithAnEtaOnlyWhenSent()
    {
        Assert.Equal("25 of 100 files, about 9 min left", BackgroundTasksPanel.ProgressText(Task("running", new(25, 100, "files"), eta: 540)));
        Assert.Equal("40%", BackgroundTasksPanel.ProgressText(Task("running", new(400, 1000, "bytes"))));
        Assert.Equal("40%, less than a minute left", BackgroundTasksPanel.ProgressText(Task("running", new(400, 1000, "bytes"), eta: 20)));
        Assert.Equal("5 of 20 rounds", BackgroundTasksPanel.ProgressText(Task("running", new(5, 20, "rounds"))));
        // A countdown is the bar and "next in", not a percentage.
        Assert.Equal("", BackgroundTasksPanel.ProgressText(Task("scheduled", new(1, 4, "ms"))));
        Assert.Equal("about 1.5 h left", BackgroundTasksPanel.Eta(5400));
    }

    [Fact]
    public void Bar_NeverMakesUpAPercentage()
    {
        Assert.Equal(BackgroundTasksPanel.BarKind.Indeterminate, BackgroundTasksPanel.Bar(Task("running")));
        Assert.Equal(BackgroundTasksPanel.BarKind.Determinate, BackgroundTasksPanel.Bar(Task("running", new(1, 4, "files"))));
        Assert.Equal(BackgroundTasksPanel.BarKind.Determinate, BackgroundTasksPanel.Bar(Task("scheduled", new(1, 4, "ms"))));
        Assert.Equal(BackgroundTasksPanel.BarKind.None, BackgroundTasksPanel.Bar(Task("scheduled")));
        Assert.Equal(BackgroundTasksPanel.BarKind.None, BackgroundTasksPanel.Bar(Task("done", new(4, 4, "files"))));
        Assert.Equal(0.25, new ManaTaskProgress(1, 4, null).Fraction);
        Assert.Equal(1, new ManaTaskProgress(9, 4, null).Fraction);
    }

    [Fact]
    public void Panel_GroupsRows_NamesThem_AndShowsSelfWorkApart()
    {
        RunSta(() =>
        {
            var opened = 0;
            using var panel = new BackgroundTasksPanel(ClientReturning(_ => Json(SampleJson)), () => opened++, () => Now);
            Pump(panel.RefreshAsync());

            var items = panel.ListItems;
            Assert.Equal(new[] { "Models", "Loading qwen.gguf", "Memory", "Indexing files for search", "Reminders", "Broken progress", "Raid" },
                items.Select(c => c is BackgroundTasksPanel.TaskRow row ? row.Task!.Title : c.Text));
            var raid = items.OfType<BackgroundTasksPanel.TaskRow>().Single(r => r.Task!.Id == "reminder:r1");
            Assert.Equal("Raid, Scheduled, next in 12 min", raid.AccessibleName);
            Assert.True(raid.CancelButton.Visible);
            Assert.Equal("Cancel Raid", raid.CancelButton.AccessibleName);
            Assert.Equal(BackgroundTasksPanel.BarKind.Determinate, raid.BarKind);
            var load = items.OfType<BackgroundTasksPanel.TaskRow>().Single(r => r.Task!.Id == "llama-load");
            Assert.False(load.CancelButton.Visible);
            Assert.True(load.Indeterminate);
            Assert.Equal("running 30 s", load.MetaText);
            Assert.True(items.All(c => !string.IsNullOrEmpty(c.AccessibleName)));
            Assert.True(items.OfType<BackgroundTasksPanel.TaskRow>().All(r => r.TabStop));

            Assert.False(panel.EmptyLabel.Visible);
            Assert.True(panel.SelfWorkRow.Visible);
            Assert.Equal("running 2 min · 5 of 20 rounds · Working on it", panel.SelfWorkRow.MetaText);
            Click(panel.OpenSelfWorkButton);
            Assert.Equal(1, opened);
            Assert.Equal("Open What I'm working on", panel.OpenSelfWorkButton.AccessibleName);
        });
    }

    [Fact]
    public void Panel_EmptyState_ErrorWithRetry_AndCancel()
    {
        RunSta(() =>
        {
            var responses = new Queue<HttpResponseMessage>();
            var requests = new List<string>();
            using var panel = new BackgroundTasksPanel(ClientReturning(request =>
            {
                requests.Add($"{request.Method} {request.RequestUri!.AbsolutePath}");
                return responses.Dequeue();
            }), () => { }, () => Now);

            responses.Enqueue(Json("""{"tasks":[]}"""));
            Pump(panel.RefreshAsync());
            Assert.True(panel.EmptyLabel.Visible);
            Assert.Equal("Nothing running right now", panel.EmptyLabel.Text);
            Assert.False(panel.SelfWorkRow.Visible);

            // Unreachable: an inline error with Retry, not "nothing running".
            responses.Enqueue(new HttpResponseMessage(HttpStatusCode.InternalServerError));
            Pump(panel.RefreshAsync());
            Assert.True(panel.ErrorRow.Visible);
            Assert.False(panel.EmptyLabel.Visible);
            Assert.StartsWith("Couldn't reach Mana", panel.ErrorLabel.Text);
            Assert.Equal("Retry loading background tasks", panel.RetryButton.AccessibleName);

            responses.Enqueue(Json(SampleJson));
            Click(panel.RetryButton);
            PumpUntil(() => !panel.ErrorRow.Visible);
            Assert.Equal(7, panel.ListItems.Count);

            // Cancel posts, then refreshes; the row is gone once the backend drops it.
            responses.Enqueue(Json("""{"ok":true}"""));
            responses.Enqueue(Json("""{"tasks":[]}"""));
            var raid = panel.ListItems.OfType<BackgroundTasksPanel.TaskRow>().Single(r => r.Task!.Id == "reminder:r1");
            Click(raid.CancelButton);
            PumpUntil(() => panel.EmptyLabel.Visible);
            Assert.Contains("POST /background-tasks/reminder%3Ar1/cancel", requests);
            Assert.True(raid.IsDisposed);
        });
    }

    [Fact]
    public void Panel_PollsAndAnimatesOnlyWhileActive()
    {
        RunSta(() =>
        {
            using var panel = new BackgroundTasksPanel(ClientReturning(_ => Json(SampleJson)), () => { }, () => Now);
            Assert.False(panel.Polling);
            panel.SetActive(true);
            Assert.True(panel.Polling);
            PumpUntil(() => panel.ListItems.Count > 0);
            // The sweep only runs when Windows' animation effects are on.
            Assert.Equal(GlassShimmer.AnimationsEnabled(), panel.Animating);
            panel.SetActive(false);
            Assert.False(panel.Polling);
            Assert.False(panel.Animating);
        });
    }

    private static void Click(Button button) =>
        typeof(Control).GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(button, new object[] { EventArgs.Empty });

    // Async continuations come back through the WinForms message queue on
    // this STA thread, so the test pumps it (never showing a window).
    private static void Pump(Task task) => PumpUntil(() => task.IsCompleted);

    private static void PumpUntil(Func<bool> done)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!done())
        {
            Assert.True(DateTime.UtcNow < deadline, "timed out");
            Application.DoEvents();
            Thread.Sleep(1);
        }
    }

    private static void RunSta(Action body)
    {
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                body();
            }
            catch (Exception ex)
            {
                error = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null)
        {
            ExceptionDispatchInfo.Capture(error).Throw();
        }
    }
}
