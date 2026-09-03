using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

internal sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> responder;

    public FakeHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
    {
        this.responder = responder;
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        return Task.FromResult(responder(request));
    }
}

public class ManaBackendClientTests
{
    [Fact]
    public async Task TranscribeAsync_PostsToTranscribeOnlyAndReturnsTranscript()
    {
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"transcript\":\"hello mana\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var transcript = await client.TranscribeAsync(new byte[] { 1, 2, 3 });

        Assert.Equal("/transcribe-only", path);
        Assert.Equal("hello mana", transcript);
    }

    [Fact]
    public async Task ReplyAsync_SendsTextAsJsonAndReturnsReply()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"reply\":\"Hi there!\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var reply = await client.ReplyAsync("hello");

        Assert.Equal("/reply", path);
        Assert.Contains("\"text\":\"hello\"", body);
        Assert.Equal("Hi there!", reply);
    }

    [Fact]
    public async Task SynthesizeAsync_ReturnsRawResponseBytes()
    {
        var expectedBytes = new byte[] { 0x52, 0x49, 0x46, 0x46 };
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(expectedBytes),
            };
        });
        var client = new ManaBackendClient(handler);

        var bytes = await client.SynthesizeAsync("hello");

        Assert.Equal("/synthesize", path);
        Assert.Equal(expectedBytes, bytes);
    }

    [Fact]
    public async Task TranscribeAsync_ThrowsOnNonSuccessStatus()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        var client = new ManaBackendClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.TranscribeAsync(new byte[] { 1 }));
    }

    [Fact]
    public async Task ReplyStreamAsync_OmitsTheImageFieldWhenNoneIsGiven()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"type\":\"final\",\"reply\":\"ok\",\"changed\":false}\n",
                    Encoding.UTF8,
                    "application/x-ndjson"),
            };
        });
        var client = new ManaBackendClient(handler);

        await foreach (var _ in client.ReplyStreamAsync("hi"))
        {
        }

        Assert.DoesNotContain("image", body);
    }

    [Fact]
    public async Task ReplyStreamAsync_IncludesTheImageFieldWhenGiven()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"type\":\"final\",\"reply\":\"ok\",\"changed\":false}\n",
                    Encoding.UTF8,
                    "application/x-ndjson"),
            };
        });
        var client = new ManaBackendClient(handler);

        await foreach (var _ in client.ReplyStreamAsync("hi", "data:image/jpeg;base64,AAAA"))
        {
        }

        Assert.Contains("\"image\":\"data:image/jpeg;base64,AAAA\"", body);
    }

    [Fact]
    public async Task ReplyStreamAsync_PostsToReplyStreamAndYieldsEventsInOrder()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            var ndjson =
                "{\"type\":\"sentence\",\"text\":\"Hello there.\"}\n" +
                "{\"type\":\"sentence\",\"text\":\"How can I help?\"}\n" +
                "{\"type\":\"final\",\"reply\":\"Hello there. How can I help?\",\"changed\":false}\n";
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(ndjson, Encoding.UTF8, "application/x-ndjson"),
            };
        });
        var client = new ManaBackendClient(handler);

        var events = new System.Collections.Generic.List<ReplyStreamEvent>();
        await foreach (var evt in client.ReplyStreamAsync("hi"))
        {
            events.Add(evt);
        }

        Assert.Equal("/reply/stream", path);
        Assert.Contains("\"text\":\"hi\"", body);
        Assert.Equal(3, events.Count);
        Assert.Equal("sentence", events[0].Type);
        Assert.Equal("Hello there.", events[0].Text);
        Assert.Equal("sentence", events[1].Type);
        Assert.Equal("How can I help?", events[1].Text);
        Assert.Equal("final", events[2].Type);
        Assert.Equal("Hello there. How can I help?", events[2].Reply);
        Assert.False(events[2].Changed);
    }

    [Fact]
    public async Task ReplyStreamAsync_ParsesErrorOnFinalEvent()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "{\"type\":\"final\",\"error\":\"no local vision model available\"}\n",
                Encoding.UTF8,
                "application/x-ndjson"),
        });
        var client = new ManaBackendClient(handler);

        var events = new System.Collections.Generic.List<ReplyStreamEvent>();
        await foreach (var evt in client.ReplyStreamAsync("hi"))
        {
            events.Add(evt);
        }

        Assert.Single(events);
        Assert.Equal("no local vision model available", events[0].Error);
    }

    [Fact]
    public async Task ReplyStreamAsync_ThrowsOnAMalformedLineInsteadOfHangingOrSwallowingIt()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "{\"type\":\"sentence\",\"text\":\"One.\"}\nnot json\n",
                Encoding.UTF8,
                "application/x-ndjson"),
        });
        var client = new ManaBackendClient(handler);

        async Task ConsumeAsync()
        {
            await foreach (var _ in client.ReplyStreamAsync("hi"))
            {
                // draining the enumerable is what triggers the parse of the malformed line
            }
        }

        // Utf8JsonReader throws JsonReaderException specifically for a
        // syntax error like this -- it derives from JsonException, so
        // ThrowsAnyAsync (not the exact-type ThrowsAsync) is the correct
        // assertion for "some JSON parse failure surfaces to the caller".
        await Assert.ThrowsAnyAsync<System.Text.Json.JsonException>(ConsumeAsync);
    }

    [Fact]
    public async Task ReplyStreamAsync_SkipsBlankLines()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "{\"type\":\"sentence\",\"text\":\"One.\"}\n\n{\"type\":\"final\",\"reply\":\"One.\",\"changed\":false}\n",
                Encoding.UTF8,
                "application/x-ndjson"),
        });
        var client = new ManaBackendClient(handler);

        var events = new System.Collections.Generic.List<ReplyStreamEvent>();
        await foreach (var evt in client.ReplyStreamAsync("hi"))
        {
            events.Add(evt);
        }

        Assert.Equal(2, events.Count);
    }

    [Fact]
    public async Task ClassifyBargeInAsync_PostsToClassifyAndReturnsCategory()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"success\":true,\"input_length\":5,\"category\":\"amend\",\"reason\":\"matched_amend_keyword\"}",
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var category = await client.ClassifyBargeInAsync("the other");

        Assert.Equal("/barge-in/classify", path);
        Assert.Contains("\"text\":\"the other\"", body);
        Assert.Equal("amend", category);
    }

    [Fact]
    public async Task ClassifyBargeInAsync_FallsBackToUnclassifiedOnNonSuccessStatus()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        var client = new ManaBackendClient(handler);

        var category = await client.ClassifyBargeInAsync("whatever");

        Assert.Equal("unclassified", category);
    }

    [Fact]
    public async Task ClassifyBargeInAsync_FallsBackToUnclassifiedWhenTheRequestThrows()
    {
        var handler = new FakeHttpMessageHandler(_ => throw new HttpRequestException("connection refused"));
        var client = new ManaBackendClient(handler);

        var category = await client.ClassifyBargeInAsync("whatever");

        Assert.Equal("unclassified", category);
    }

    [Fact]
    public async Task ClassifyBargeInAsync_FallsBackToUnclassifiedWhenTheCategoryFieldIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"success\":true}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var category = await client.ClassifyBargeInAsync("whatever");

        Assert.Equal("unclassified", category);
    }

    [Fact]
    public async Task ClassifyBargeInAsync_FallsBackToUnclassifiedOnATimeout()
    {
        // A slow/hung backend surfaces as TaskCanceledException (what
        // HttpClient's own timeout throws) -- this method's own doc
        // comment promises it never throws, and its only caller
        // (VoiceLoop.ProcessTurnAsync) has no try/catch of its own around
        // this specific call, unlike every other backend call there.
        var handler = new FakeHttpMessageHandler(_ => throw new TaskCanceledException("the request timed out"));
        var client = new ManaBackendClient(handler);

        var category = await client.ClassifyBargeInAsync("whatever");

        Assert.Equal("unclassified", category);
    }
}
