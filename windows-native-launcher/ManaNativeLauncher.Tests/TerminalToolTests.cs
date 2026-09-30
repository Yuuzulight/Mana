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

// #1121: the rail's Terminal tool ("Mana's runs") against a fake backend.
// Real controls on an STA thread, never shown; nothing touches the clipboard.
public class TerminalToolTests
{
    private const string Runs = """
        {"runs":[
          {"id":"3","source":"chat","command":"npm test","cwd":"D:\\ws","startedAt":1000,"running":true,"stoppable":true,"droppedChars":0},
          {"id":"2","source":"hook","command":"eslint a.js","cwd":"D:\\ws","startedAt":900,"exitCode":1,"durationMs":1500,"running":false,"stoppable":false},
          {"id":"1","source":"mcp","command":"npx server","cwd":"D:\\","startedAt":800,"exitCode":null,"durationMs":65000,"running":false,"stoppable":false}
        ]}
        """;

    private static ManaBackendClient Backend(List<string> requests) =>
        new(new FakeHttpMessageHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            requests.Add($"{request.Method} {path}");
            var json = path switch
            {
                "/terminal/runs" => Runs,
                "/terminal/runs/3/stop" => """{"stopped":true}""",
                "/terminal/runs/3" => """{"id":"3","source":"chat","command":"npm test","cwd":"D:\\ws","startedAt":1000,"output":"ok 1\nok 2\n","droppedChars":5,"running":true,"stoppable":true}""",
                "/terminal/runs/2" => """{"id":"2","source":"hook","command":"eslint a.js","cwd":"D:\\ws","startedAt":900,"output":"1 problem\n","exitCode":1,"running":false,"stoppable":false}""",
                _ => null,
            };
            return json is null
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));

    [Fact]
    public async Task Client_ReadsRunsAndOutput_AndStops()
    {
        var requests = new List<string>();
        var client = Backend(requests);

        var runs = await client.GetTerminalRunsAsync();
        Assert.Equal(["3", "2", "1"], runs.Select(r => r.Id));
        Assert.True(runs[0].Running && runs[0].Stoppable);
        Assert.Equal((int?)1, runs[1].ExitCode);
        Assert.Null(runs[2].ExitCode);

        var run = await client.GetTerminalRunAsync("3");
        Assert.Equal("ok 1\nok 2\n", run!.Output);
        Assert.Equal(5, run.DroppedChars);
        Assert.Null(await client.GetTerminalRunAsync("99"));

        Assert.True(await client.StopTerminalRunAsync("3"));
        Assert.Equal("POST /terminal/runs/3/stop", requests[^1]);
    }

    [Theory]
    [InlineData(true, null, false, "running")]
    [InlineData(true, null, true, "stopping")]
    [InlineData(false, 0, false, "exit 0")]
    [InlineData(false, null, false, "ended")]
    [InlineData(false, null, true, "stopped")]
    public void Result_SaysRunningExitEndedOrStopped(bool running, int? exitCode, bool stopped, string expected) =>
        Assert.Equal(expected, TerminalTool.Result(new ManaTerminalRun { Running = running, ExitCode = exitCode, Stopped = stopped }));

    [Theory]
    [InlineData(250L, "250ms")]
    [InlineData(1500L, "1.5s")]
    [InlineData(65000L, "1m 05s")]
    public void FormatTime_ReadsAtAGlance(long ms, string expected) =>
        Assert.Equal(expected, TerminalTool.FormatTime(new ManaTerminalRun { DurationMs = ms }));

    [Fact]
    public void Tool_ShowsTheNewestRunsOutput_FiltersBySource_CopiesAndStops()
    {
        RunSta(() =>
        {
            var requests = new List<string>();
            using var tool = new TerminalTool(Backend(requests), System.IO.Path.GetTempPath());
            string? copied = null;
            tool.CopyText = text => copied = text;
            var list = Find<ListView>(tool, _ => true);
            var output = Find<TextBox>(tool, t => t.AccessibleName == "Output");
            var stop = Find<Button>(tool, b => b.Text == "Stop");

            Pump(tool.RefreshAsync());
            Assert.Equal(["npm test", "eslint a.js", "npx server"], list.Items.Cast<ListViewItem>().Select(i => i.Text));
            Assert.Equal("running", list.Items[0].SubItems[2].Text);
            // Nothing picked yet: the newest one, with its output.
            Assert.True(list.Items[0].Selected);
            Assert.Equal("ok 1\r\nok 2\r\n", output.Text);
            Assert.True(stop.Enabled);

            Click(Find<Button>(tool, b => b.Text == "Copy output"));
            Assert.Equal("ok 1\nok 2\n", copied);

            Click(stop);
            Pump(() => requests.Contains("POST /terminal/runs/3/stop"));

            // Hooks only: the hook run, which no Stop reaches.
            Find<ComboBox>(tool, _ => true).SelectedIndex = Array.FindIndex(TerminalTool.Filters, f => f.Source == "hook");
            Pump(() => output.Text == "1 problem\r\n");
            Assert.Equal(["eslint a.js"], list.Items.Cast<ListViewItem>().Select(i => i.Text));
            Assert.False(stop.Enabled);
        });
    }

    // Runs the STA thread's posted continuations until done (or 5 s).
    private static void Pump(Task task) => Pump(() => task.IsCompleted);

    private static void Pump(Func<bool> done)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!done())
        {
            Assert.True(DateTime.UtcNow < deadline, "timed out");
            Application.DoEvents();
            Thread.Sleep(1);
        }
    }

    private static void Click(Button button) =>
        typeof(Control).GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(button, new object[] { EventArgs.Empty });

    private static T Find<T>(Control root, Func<T, bool> match) where T : Control
    {
        foreach (Control child in root.Controls)
        {
            if (child is T hit && match(hit))
            {
                return hit;
            }
            try
            {
                return Find(child, match);
            }
            catch (InvalidOperationException)
            {
            }
        }
        throw new InvalidOperationException($"no {typeof(T).Name} found");
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
