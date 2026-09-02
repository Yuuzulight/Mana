using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class StreamingReplyPlayerTests
{
    // Routes /reply/stream to the given canned NDJSON and /synthesize to a
    // fake WAV, logging each synthesized sentence's text in call order --
    // reuses FakeHttpMessageHandler from ManaBackendClientTests.cs.
    private static ManaBackendClient BuildFakeClient(string replyStreamNdjson, List<string> synthLog)
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/reply/stream")
            {
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(replyStreamNdjson, Encoding.UTF8, "application/x-ndjson"),
                };
            }
            if (path == "/synthesize")
            {
                var body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                using var document = JsonDocument.Parse(body);
                synthLog.Add($"synth:{document.RootElement.GetProperty("text").GetString()}");
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new ByteArrayContent(new byte[] { 1, 2, 3 }),
                };
            }
            throw new InvalidOperationException($"unexpected request to {path}");
        });
        return new ManaBackendClient(handler);
    }

    [Fact]
    public async Task StreamReplyAndPlayAsync_PlaysSentencesInOrderAndReportsUnchanged()
    {
        const string ndjson =
            "{\"type\":\"sentence\",\"text\":\"Hello there.\"}\n" +
            "{\"type\":\"sentence\",\"text\":\"How can I help?\"}\n" +
            "{\"type\":\"final\",\"reply\":\"Hello there. How can I help?\",\"changed\":false}\n";
        var synthLog = new List<string>();
        var playLog = new List<string>();
        var talkingStates = new List<bool>();
        var client = BuildFakeClient(ndjson, synthLog);

        var player = new StreamingReplyPlayer(
            client,
            audio =>
            {
                playLog.Add($"play:{audio.Length}bytes");
                return Task.FromResult(true);
            },
            talking => talkingStates.Add(talking));

        var (reply, changed, expression, interrupted) = await player.StreamReplyAndPlayAsync("hi");

        Assert.Equal("Hello there. How can I help?", reply);
        Assert.False(changed);
        Assert.Null(expression);
        Assert.False(interrupted);
        Assert.Equal(new[] { "synth:Hello there.", "synth:How can I help?" }, synthLog);
        Assert.Equal(2, playLog.Count);
        Assert.Equal(new[] { true, false }, talkingStates);
    }

    [Fact]
    public async Task StreamReplyAndPlayAsync_SynthesizesNextSentenceWhileCurrentOneIsStillPlaying()
    {
        const string ndjson =
            "{\"type\":\"sentence\",\"text\":\"One.\"}\n" +
            "{\"type\":\"sentence\",\"text\":\"Two.\"}\n" +
            "{\"type\":\"final\",\"reply\":\"One. Two.\",\"changed\":false}\n";
        var synthLog = new List<string>();
        var client = BuildFakeClient(ndjson, synthLog);

        var firstPlayback = new TaskCompletionSource<bool>();
        var playCallCount = 0;

        var player = new StreamingReplyPlayer(
            client,
            _ =>
            {
                playCallCount++;
                // Only the first Play() call blocks (until the test
                // releases it below) -- everything after that is where we
                // check that synthesis of the second sentence was already
                // dispatched while the first sentence is still "playing".
                return playCallCount == 1 ? firstPlayback.Task : Task.FromResult(true);
            },
            _ => { });

        var runTask = player.StreamReplyAndPlayAsync("hi");

        // Let the reader/synth pipeline (all in-memory, no real I/O) reach
        // its quiescent point: blocked on the first playAsync call, with
        // the second sentence's synthesis already dispatched.
        await Task.Delay(100);

        Assert.False(runTask.IsCompleted);
        Assert.Contains("synth:Two.", synthLog);

        firstPlayback.SetResult(true);
        var (reply, changed, _, interrupted) = await runTask;

        Assert.Equal("One. Two.", reply);
        Assert.False(changed);
        Assert.False(interrupted);
    }

    [Fact]
    public async Task StreamReplyAndPlayAsync_ChangedTrueWithNoSentencesDoesNotSetTalking()
    {
        const string ndjson = "{\"type\":\"final\",\"reply\":\"Tool result.\",\"changed\":true}\n";
        var synthLog = new List<string>();
        var talkingStates = new List<bool>();
        var client = BuildFakeClient(ndjson, synthLog);

        var player = new StreamingReplyPlayer(client, _ => Task.FromResult(true), talking => talkingStates.Add(talking));

        var (reply, changed, _, interrupted) = await player.StreamReplyAndPlayAsync("hi");

        Assert.Equal("Tool result.", reply);
        Assert.True(changed);
        Assert.False(interrupted);
        Assert.Empty(synthLog);
        Assert.Empty(talkingStates);
    }

    [Fact]
    public async Task StreamReplyAndPlayAsync_ThrowsOnErrorFinalEvent()
    {
        const string ndjson = "{\"type\":\"final\",\"error\":\"no local vision model available\"}\n";
        var client = BuildFakeClient(ndjson, new List<string>());
        var player = new StreamingReplyPlayer(client, _ => Task.FromResult(true), _ => { });

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => player.StreamReplyAndPlayAsync("hi"));
        Assert.Equal("no local vision model available", ex.Message);
    }

    [Fact]
    public async Task StreamReplyAndPlayAsync_ThrowsWhenStreamEndsWithoutAFinalEvent()
    {
        const string ndjson = "{\"type\":\"sentence\",\"text\":\"Hello.\"}\n";
        var synthLog = new List<string>();
        var client = BuildFakeClient(ndjson, synthLog);
        var player = new StreamingReplyPlayer(client, _ => Task.FromResult(true), _ => { });

        await Assert.ThrowsAsync<InvalidOperationException>(() => player.StreamReplyAndPlayAsync("hi"));
    }

    [Fact]
    public async Task StreamReplyAndPlayAsync_SkipsWhitespaceOnlySentenceEvents()
    {
        const string ndjson =
            "{\"type\":\"sentence\",\"text\":\"   \"}\n" +
            "{\"type\":\"sentence\",\"text\":\"Real sentence.\"}\n" +
            "{\"type\":\"final\",\"reply\":\"Real sentence.\",\"changed\":false}\n";
        var synthLog = new List<string>();
        var client = BuildFakeClient(ndjson, synthLog);
        var player = new StreamingReplyPlayer(client, _ => Task.FromResult(true), _ => { });

        var (reply, changed, _, interrupted) = await player.StreamReplyAndPlayAsync("hi");

        Assert.Equal("Real sentence.", reply);
        Assert.False(changed);
        Assert.False(interrupted);
        Assert.Equal(new[] { "synth:Real sentence." }, synthLog);
    }

    // #479 sub-project 3: playAsync reporting completedNaturally: false
    // (a barge-in interruption) must stop the pipeline immediately --
    // no further sentences synthesized/played, Reply is null (nothing
    // meaningful to report), and Interrupted is true.
    [Fact]
    public async Task StreamReplyAndPlayAsync_StopsImmediatelyWhenPlaybackReportsInterrupted()
    {
        const string ndjson =
            "{\"type\":\"sentence\",\"text\":\"One.\"}\n" +
            "{\"type\":\"sentence\",\"text\":\"Two.\"}\n" +
            "{\"type\":\"final\",\"reply\":\"One. Two.\",\"changed\":false}\n";
        var synthLog = new List<string>();
        var playLog = new List<string>();
        var talkingStates = new List<bool>();
        var client = BuildFakeClient(ndjson, synthLog);

        var player = new StreamingReplyPlayer(
            client,
            audio =>
            {
                playLog.Add($"play:{audio.Length}bytes");
                return Task.FromResult(false); // interrupted on the very first chunk
            },
            talking => talkingStates.Add(talking));

        var (reply, changed, expression, interrupted) = await player.StreamReplyAndPlayAsync("hi");

        Assert.Null(reply);
        Assert.False(changed);
        Assert.Null(expression);
        Assert.True(interrupted);
        Assert.Single(playLog); // never attempted to play a second chunk
        Assert.Equal(new[] { true, false }, talkingStates); // still reports talking stopped
    }

    [Fact]
    public async Task StreamReplyAndPlayAsync_DoesNotThrowWhenInterruptedEvenIfTheServerReplyIsMalformed()
    {
        // No final event at all in this NDJSON (would normally throw "ended
        // without a final event") -- but since playback was interrupted
        // before the read side was ever awaited, that malformed-stream
        // detail must never surface to the caller.
        const string ndjson = "{\"type\":\"sentence\",\"text\":\"One.\"}\n";
        var synthLog = new List<string>();
        var client = BuildFakeClient(ndjson, synthLog);

        var player = new StreamingReplyPlayer(client, _ => Task.FromResult(false), _ => { });

        var (reply, _, _, interrupted) = await player.StreamReplyAndPlayAsync("hi");

        Assert.True(interrupted);
        Assert.Null(reply);
    }
}
