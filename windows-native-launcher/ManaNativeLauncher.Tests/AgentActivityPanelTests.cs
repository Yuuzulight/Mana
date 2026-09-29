using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #646: GET /agent/activity / POST /agent/stop, and the panel's text.
public class AgentActivityPanelTests
{
    [Fact]
    public async Task GetAgentActivityAsync_ParsesRunsIncludingNullTool()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/agent/activity", request.RequestUri!.AbsolutePath);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """
                    {"runs":[
                      {"id":"3","elapsedMs":65000,"tool":"web_search","toolElapsedMs":4200,"toolCount":2,"lastTool":"read_file","stopping":false},
                      {"id":"4","elapsedMs":1000,"tool":null,"toolElapsedMs":null,"toolCount":1,"lastTool":"read_file","stopping":true}
                    ]}
                    """,
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var runs = await client.GetAgentActivityAsync();

        Assert.Equal(2, runs.Count);
        Assert.Equal("3", runs[0].Id);
        Assert.Equal("web_search", runs[0].Tool);
        Assert.Equal(4200, runs[0].ToolElapsedMs);
        Assert.Equal(2, runs[0].ToolCount);
        Assert.False(runs[0].Stopping);
        Assert.Null(runs[1].Tool);
        Assert.Null(runs[1].ToolElapsedMs);
        Assert.True(runs[1].Stopping);
    }

    [Fact]
    public async Task StopAgentRunAsync_PostsTheRunId()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().Result;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"stopped":true}""", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.StopAgentRunAsync("3");

        Assert.Equal("/agent/stop", path);
        Assert.Equal("""{"id":"3"}""", body);
    }

    [Fact]
    public void Describe_ShowsTheRunningToolThenTheLastOneThenStopping()
    {
        var running = new ManaAgentRun { Id = "3", ElapsedMs = 65000, Tool = "web_search", ToolElapsedMs = 4200, ToolCount = 2, LastTool = "read_file" };
        Assert.Equal($"Running web_search (4s){Environment.NewLine}1m 05s so far, 2 tool calls", AgentActivityPanel.Describe(running));

        var between = new ManaAgentRun { Id = "3", ElapsedMs = 9000, ToolCount = 1, LastTool = "read_file" };
        Assert.Equal($"Thinking (last: read_file){Environment.NewLine}9s so far, 1 tool call", AgentActivityPanel.Describe(between));

        var stopping = new ManaAgentRun { Id = "3", ElapsedMs = 9000, Tool = "web_search", ToolElapsedMs = 1000, ToolCount = 1, Stopping = true };
        Assert.StartsWith("Stopping...", AgentActivityPanel.Describe(stopping));
    }
}
