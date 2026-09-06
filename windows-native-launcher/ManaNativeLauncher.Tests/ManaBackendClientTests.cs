using System;
using System.Linq;
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
    public async Task GetVTubeStatusAsync_ParsesA200WhenConnected()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"enabled":true,"connected":true,"authenticated":true,"url":"ws://127.0.0.1:8001","state":{}}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetVTubeStatusAsync();

        Assert.True(status.Enabled);
        Assert.True(status.Connected);
        Assert.True(status.Authenticated);
        Assert.Equal("ws://127.0.0.1:8001", status.Url);
    }

    [Fact]
    public async Task GetVTubeStatusAsync_ParsesA503WhenEnabledButUnreachableInsteadOfThrowing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
        {
            Content = new StringContent(
                """{"enabled":true,"connected":false,"authenticated":false,"url":"ws://127.0.0.1:8001","error":"connection refused"}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetVTubeStatusAsync();

        Assert.True(status.Enabled);
        Assert.False(status.Connected);
        Assert.Equal("connection refused", status.Error);
    }

    [Fact]
    public async Task GetVTubeStatusAsync_ThrowsOn500()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        var client = new ManaBackendClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetVTubeStatusAsync());
    }

    [Fact]
    public async Task AuthenticateVTubeStudioAsync_PostsAndReturnsAuthenticated()
    {
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"authenticated\":true,\"tokenCreated\":false}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var authenticated = await client.AuthenticateVTubeStudioAsync();

        Assert.Equal("/vtube/auth", path);
        Assert.True(authenticated);
    }

    [Fact]
    public async Task GetVTubeHotkeysAsync_ParsesTheHotkeyArray()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"hotkeys":[{"hotkeyID":"abc-1","name":"Wave","type":"TriggerAnimation"}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var hotkeys = await client.GetVTubeHotkeysAsync();

        var hotkey = Assert.Single(hotkeys);
        Assert.Equal("abc-1", hotkey.Id);
        Assert.Equal("Wave", hotkey.Name);
    }

    [Fact]
    public async Task TriggerVTubeHotkeyAsync_PostsTheHotkeyId()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.TriggerVTubeHotkeyAsync("abc-1");

        Assert.Equal("/vtube/hotkey", path);
        Assert.Contains("\"hotkeyID\":\"abc-1\"", body);
    }

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

        await foreach (var _ in client.ReplyStreamAsync("hi", image: "data:image/jpeg;base64,AAAA"))
        {
        }

        Assert.Contains("\"image\":\"data:image/jpeg;base64,AAAA\"", body);
    }

    [Fact]
    public async Task ReadScreenAsync_PostsTheImageAndReturnsText()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"text\":\"a browser window\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var text = await client.ReadScreenAsync("data:image/jpeg;base64,AAAA");

        Assert.Equal("/screen/read", path);
        Assert.Contains("\"image\":\"data:image/jpeg;base64,AAAA\"", body);
        Assert.Equal("a browser window", text);
    }

    [Fact]
    public async Task ReplyStreamAsync_IncludesScreenTextInTheRequestBody()
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

        await foreach (var _ in client.ReplyStreamAsync("hi", screenText: "a chat window is open"))
        {
        }

        Assert.Contains("\"screenText\":\"a chat window is open\"", body);
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

    [Fact]
    public async Task ReplyStreamAsync_OmitsSessionIdWhenNoneIsGiven()
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

        Assert.DoesNotContain("sessionId", body);
    }

    [Fact]
    public async Task ReplyStreamAsync_IncludesSessionIdWhenGiven()
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

        await foreach (var _ in client.ReplyStreamAsync("hi", "abc-123"))
        {
        }

        Assert.Contains("\"sessionId\":\"abc-123\"", body);
    }

    [Fact]
    public async Task GetSessionsAsync_ParsesTheSessionArray()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"sessions":[{"sessionId":"s1","name":"Chat about FFXIV","updatedAt":"2026-03-15T12:00:00.000Z"},{"sessionId":"s2","updatedAt":"2026-03-14T12:00:00.000Z"}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var sessions = await client.GetSessionsAsync();

        Assert.Equal(2, sessions.Count);
        Assert.Equal("s1", sessions[0].SessionId);
        Assert.Equal("Chat about FFXIV", sessions[0].Name);
        Assert.Equal("s2", sessions[1].SessionId);
        Assert.Null(sessions[1].Name);
    }

    [Fact]
    public async Task GetSessionsAsync_ReturnsEmptyWhenTheSessionsKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var sessions = await client.GetSessionsAsync();

        Assert.Empty(sessions);
    }

    [Fact]
    public async Task RenameSessionAsync_PatchesTheNameAndReturnsTrue()
    {
        string? path = null;
        string? method = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            method = request.Method.Method;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"sessionId\":\"s1\",\"name\":\"New Name\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var renamed = await client.RenameSessionAsync("s1", "New Name");

        Assert.True(renamed);
        Assert.Equal("/sessions/s1", path);
        Assert.Equal("PATCH", method);
        Assert.Contains("\"name\":\"New Name\"", body);
    }

    [Fact]
    public async Task RenameSessionAsync_ReturnsFalseOn404InsteadOfThrowing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        var client = new ManaBackendClient(handler);

        var renamed = await client.RenameSessionAsync("missing", "New Name");

        Assert.False(renamed);
    }

    [Fact]
    public async Task DeleteSessionAsync_ReturnsTrueOnSuccess()
    {
        string? path = null;
        string? method = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            method = request.Method.Method;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"deleted\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var deleted = await client.DeleteSessionAsync("s1");

        Assert.True(deleted);
        Assert.Equal("/sessions/s1", path);
        Assert.Equal("DELETE", method);
    }

    [Fact]
    public async Task DeleteSessionAsync_ReturnsFalseOn404InsteadOfThrowing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        var client = new ManaBackendClient(handler);

        var deleted = await client.DeleteSessionAsync("missing");

        Assert.False(deleted);
    }

    [Fact]
    public async Task RenameSessionAsync_ThrowsOnNonSuccessStatusOtherThan404()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        var client = new ManaBackendClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.RenameSessionAsync("s1", "New Name"));
    }

    [Fact]
    public async Task DeleteSessionAsync_ThrowsOnNonSuccessStatusOtherThan404()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        var client = new ManaBackendClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.DeleteSessionAsync("s1"));
    }

    [Fact]
    public async Task ExportSessionAsync_ReturnsTheRawJsonlText()
    {
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"from\":\"human\",\"value\":\"hi\"}\n", Encoding.UTF8, "application/x-ndjson"),
            };
        });
        var client = new ManaBackendClient(handler);

        var jsonl = await client.ExportSessionAsync("s1");

        Assert.Equal("/sessions/s1/export", path);
        Assert.Equal("{\"from\":\"human\",\"value\":\"hi\"}\n", jsonl);
    }

    [Fact]
    public async Task GetPluginsAsync_FlattensTheCategoryGroupingIntoOneList()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"ok":true,"plugins":{"integrations":[{"key":"ffxiv","name":"FFXIV Market","description":"Market data","enabled":true}],"tools":[{"key":"stocks","name":"Stocks","enabled":false}]}}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var plugins = await client.GetPluginsAsync();

        Assert.Equal(2, plugins.Count);
        var ffxiv = plugins.Single(p => p.Key == "ffxiv");
        Assert.Equal("FFXIV Market", ffxiv.Name);
        Assert.True(ffxiv.Enabled);
        Assert.False(plugins.Single(p => p.Key == "stocks").Enabled);
    }

    [Fact]
    public async Task GetPluginsAsync_ReturnsEmptyWhenThePluginsKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var plugins = await client.GetPluginsAsync();

        Assert.Empty(plugins);
    }

    [Fact]
    public async Task SetPluginEnabledAsync_PostsToTheKeySpecificEndpoint()
    {
        string? path = null;
        string? method = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            method = request.Method.Method;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.SetPluginEnabledAsync("ffxiv", false);

        Assert.Equal("/plugins/ffxiv/enabled", path);
        Assert.Equal("POST", method);
        Assert.Contains("\"enabled\":false", body);
    }

    [Fact]
    public async Task GetMemoryFactsAsync_ParsesTheFactList()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"ok":true,"facts":[{"key":"favorite-color","text":"User likes blue","status":"active"}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var facts = await client.GetMemoryFactsAsync();

        var fact = Assert.Single(facts);
        Assert.Equal("favorite-color", fact.Key);
        Assert.Equal("User likes blue", fact.Text);
        Assert.Equal("active", fact.Status);
    }

    [Fact]
    public async Task GetMemoryFactsAsync_ReturnsEmptyWhenTheFactsKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var facts = await client.GetMemoryFactsAsync();

        Assert.Empty(facts);
    }

    [Fact]
    public async Task ArchiveMemoryFactAsync_PostsToTheArchiveEndpoint()
    {
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.ArchiveMemoryFactAsync("favorite-color");

        Assert.Equal("/admin/memory/facts/favorite-color/archive", path);
    }

    [Fact]
    public async Task GetSkillsAsync_ParsesTheSkillIndex()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"skills":[{"name":"weather-check","description":"Checks the weather","status":"active"}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var skills = await client.GetSkillsAsync();

        var skill = Assert.Single(skills);
        Assert.Equal("weather-check", skill.Name);
        Assert.Equal("Checks the weather", skill.Description);
        Assert.Equal("active", skill.Status);
    }

    [Fact]
    public async Task GetSkillsAsync_ReturnsEmptyWhenTheSkillsKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var skills = await client.GetSkillsAsync();

        Assert.Empty(skills);
    }

    [Fact]
    public async Task DeleteSkillAsync_SendsDeleteToTheNamedSkill()
    {
        string? path = null;
        string? method = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            method = request.Method.Method;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"deleted\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.DeleteSkillAsync("weather-check");

        Assert.Equal("/skills/weather-check", path);
        Assert.Equal("DELETE", method);
    }

    [Fact]
    public async Task GetPendingApprovalsAsync_ParsesThePendingList()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"pending":[{"id":"req-1","actionType":"skill-write","summary":"Create skill \"weather-check\""}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var pending = await client.GetPendingApprovalsAsync();

        var approval = Assert.Single(pending);
        Assert.Equal("req-1", approval.Id);
        Assert.Equal("skill-write", approval.ActionType);
    }

    [Fact]
    public async Task GetPendingApprovalsAsync_ReturnsEmptyWhenThePendingKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var pending = await client.GetPendingApprovalsAsync();

        Assert.Empty(pending);
    }

    [Fact]
    public async Task DecideApprovalAsync_PostsTheDecision()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"status\":\"approved\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.DecideApprovalAsync("req-1", "allow-once");

        Assert.Equal("/approvals/req-1/decide", path);
        Assert.Contains("\"decision\":\"allow-once\"", body);
    }
    [Fact]
    public async Task GetDoctorResultAsync_ParsesSummaryAndChecksOn200()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"ok":true,"summary":{"pass":2,"warn":0,"fail":0},"checks":[{"id":"node-runtime","label":"Node runtime","status":"pass","message":"Node v20 is available."}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.GetDoctorResultAsync();

        Assert.True(result.Ok);
        Assert.Equal(2, result.Pass);
        Assert.Equal(0, result.Warn);
        Assert.Equal(0, result.Fail);
        var check = Assert.Single(result.Checks);
        Assert.Equal("node-runtime", check.Id);
        Assert.Equal("Node runtime", check.Label);
        Assert.Equal("pass", check.Status);
        Assert.Equal("Node v20 is available.", check.Message);
    }

    [Fact]
    public async Task GetDoctorResultAsync_ParsesTheResultBodyOn503InsteadOfThrowing()
    {
        // node-bot's /doctor returns 503 (not 200) specifically when it
        // found real problems -- still a fully-shaped, parseable result,
        // not a transport failure this method should throw on.
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
        {
            Content = new StringContent(
                """{"ok":false,"summary":{"pass":1,"warn":0,"fail":1},"checks":[{"id":"x","label":"X","status":"fail","message":"broken"}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.GetDoctorResultAsync();

        Assert.False(result.Ok);
        Assert.Equal(1, result.Fail);
    }

    [Fact]
    public async Task GetDoctorResultAsync_DefaultsCountsToZeroWhenSummaryIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"ok":true,"checks":[]}""", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.GetDoctorResultAsync();

        Assert.Equal(0, result.Pass);
        Assert.Equal(0, result.Warn);
        Assert.Equal(0, result.Fail);
    }

    [Fact]
    public async Task GetDoctorResultAsync_DefaultsToEmptyChecksWhenChecksIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"ok":true,"summary":{"pass":0,"warn":0,"fail":0}}""", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.GetDoctorResultAsync();

        Assert.Empty(result.Checks);
    }

    [Fact]
    public async Task GetDoctorResultAsync_ThrowsOn500()
    {
        // Distinct from 503: a 500 means the doctor run itself errored,
        // not "problems found" -- there's no fully-shaped result to parse.
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        var client = new ManaBackendClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetDoctorResultAsync());
    }
    [Fact]
    public async Task ReplyAsync_OmitsModelProfileWhenNoneIsGiven()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"reply\":\"ok\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.ReplyAsync("hi");

        Assert.DoesNotContain("modelProfile", body);
    }

    [Fact]
    public async Task ReplyAsync_IncludesModelProfileWhenGiven()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"reply\":\"ok\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.ReplyAsync("hi", "quality");

        Assert.Contains("\"modelProfile\":\"quality\"", body);
    }

    [Fact]
    public async Task ReplyAsync_TaskEndsUpCanceledNotFaultedWhenTheTokenIsCancelled()
    {
        // The riskiest runtime behavior CompareModeForm's Cancel button
        // depends on: an already-cancelled token must produce a Task in
        // the Canceled state (so DescribeOutcome's IsCanceled check
        // fires), not Faulted (which would show "Failed: ..." instead of
        // "Cancelled." to the user).
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var handler = new FakeHttpMessageHandler(_ => throw new TaskCanceledException());
        var client = new ManaBackendClient(handler);

        var task = client.ReplyAsync("hi", cancellationToken: cts.Token);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);

        Assert.True(task.IsCanceled);
        Assert.False(task.IsFaulted);
    }

    [Fact]
    public async Task GetModelStatusAsync_ParsesActiveProfileAndProfiles()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"activeProfile":"default","profiles":{"default":{"label":"Default","available":true,"selectedModel":"C:\\models\\a.gguf"},"quality":{"label":"Quality","available":false}}}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetModelStatusAsync();

        Assert.Equal("default", status.ActiveProfile);
        Assert.Equal(2, status.Profiles.Count);
        Assert.Equal("Default", status.Profiles["default"].Label);
        Assert.True(status.Profiles["default"].Available);
        Assert.Equal(@"C:\models\a.gguf", status.Profiles["default"].SelectedModel);
        Assert.False(status.Profiles["quality"].Available);
        Assert.Null(status.Profiles["quality"].SelectedModel);
    }

    [Fact]
    public async Task GetModelStatusAsync_ReturnsEmptyProfilesWhenTheKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetModelStatusAsync();

        Assert.Null(status.ActiveProfile);
        Assert.Empty(status.Profiles);
    }
}
