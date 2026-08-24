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
}
