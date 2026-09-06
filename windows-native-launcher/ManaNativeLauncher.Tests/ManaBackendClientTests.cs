using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
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
    public async Task GetPerformanceStatusAsync_ParsesEveryField()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"ok":true,"uptimeSeconds":3725,"config":{"whisperThreads":4,"llamaThreads":8,"llamaMaxTokens":2048,"screenContextEnabled":true,"ttsProvider":"fish"},"gaming":{"gamingAppRunning":false},"process":{"totalMemoryMb":512},"operations":{"reply_token_usage":{"lastTokens":123,"session":"default"}}}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetPerformanceStatusAsync();

        Assert.Equal(512, status.TotalMemoryMb);
        Assert.Equal("fish", status.TtsProvider);
        Assert.False(status.GamingAppRunning);
        Assert.Equal(3725, status.UptimeSeconds);
        Assert.Equal(4, status.WhisperThreads);
        Assert.Equal(8, status.LlamaThreads);
        Assert.Equal(2048, status.LlamaMaxTokens);
        Assert.True(status.ScreenContextEnabled);
        var operation = Assert.Single(status.Operations);
        Assert.Equal("reply_token_usage", operation.Key);
        Assert.Contains("\"lastTokens\":123", operation.Value);
    }

    [Fact]
    public async Task GetPerformanceStatusAsync_DefaultsOperationsToEmptyWhenMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"config":{"ttsProvider":"kokoro"},"gaming":{"gamingAppRunning":true},"process":{"totalMemoryMb":256}}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetPerformanceStatusAsync();

        Assert.Empty(status.Operations);
        Assert.Equal(0, status.UptimeSeconds);
        Assert.True(status.GamingAppRunning);
    }

    [Fact]
    public async Task GetPresetsAsync_ParsesThePresetArray()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"presets":[{"id":"p1","name":"Cheerful","instructions":"Be upbeat and encouraging."}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var presets = await client.GetPresetsAsync();

        var preset = Assert.Single(presets);
        Assert.Equal("p1", preset.Id);
        Assert.Equal("Cheerful", preset.Name);
        Assert.Equal("Be upbeat and encouraging.", preset.Instructions);
    }

    [Fact]
    public async Task GetPresetsAsync_ReturnsEmptyWhenThePresetsKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var presets = await client.GetPresetsAsync();

        Assert.Empty(presets);
    }

    [Fact]
    public async Task CreatePresetAsync_PostsNameAndInstructions()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new StringContent("{\"id\":\"p1\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.CreatePresetAsync("Cheerful", "Be upbeat and encouraging.");

        Assert.Equal("/presets", path);
        Assert.Contains("\"name\":\"Cheerful\"", body);
        Assert.Contains("\"instructions\":\"Be upbeat and encouraging.\"", body);
    }

    [Fact]
    public async Task UpdatePresetAsync_PatchesNameAndInstructions()
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
                Content = new StringContent("{\"id\":\"p1\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.UpdatePresetAsync("p1", "Cheerful v2", "Be even more upbeat.");

        Assert.Equal("/presets/p1", path);
        Assert.Equal("PATCH", method);
        Assert.Contains("\"name\":\"Cheerful v2\"", body);
        Assert.Contains("\"instructions\":\"Be even more upbeat.\"", body);
    }

    [Fact]
    public async Task DeletePresetAsync_SendsDeleteToTheNamedPreset()
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

        await client.DeletePresetAsync("p1");

        Assert.Equal("/presets/p1", path);
        Assert.Equal("DELETE", method);
    }

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
    public async Task GetMcpServersAsync_ParsesServersAndSummarizesEachTransport()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"servers":[{"id":"s1","name":"weather","transport":{"kind":"stdio","command":"python","args":["server.py"]},"allowedTools":["get_forecast","get_alerts"],"registeredAt":"2026-01-01T00:00:00.000Z"},{"id":"s2","name":"remote","transport":{"kind":"http","url":"https://example.com/mcp"},"allowedTools":["search"]}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var servers = await client.GetMcpServersAsync();

        Assert.Equal(2, servers.Count);
        Assert.Equal("weather", servers[0].Name);
        Assert.Equal("stdio: python", servers[0].TransportSummary);
        Assert.Equal("get_forecast, get_alerts", servers[0].AllowedTools);
        Assert.Equal("http: https://example.com/mcp", servers[1].TransportSummary);
    }

    [Fact]
    public async Task GetMcpServersAsync_ReturnsEmptyWhenTheServersKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var servers = await client.GetMcpServersAsync();

        Assert.Empty(servers);
    }

    [Fact]
    public async Task RegisterMcpServerAsync_PostsAStdioTransportAndReturnsTheStatus()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"status\":\"pending\",\"requestId\":\"req-1\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var status = await client.RegisterMcpServerAsync("weather", "stdio", "python", new[] { "server.py" }, null, null, new[] { "get_forecast" });

        Assert.Equal("/mcp-clients/servers", path);
        Assert.Equal("pending", status);
        Assert.Contains("\"name\":\"weather\"", body);
        Assert.Contains("\"kind\":\"stdio\"", body);
        Assert.Contains("\"command\":\"python\"", body);
        Assert.Contains("\"allowedTools\":[\"get_forecast\"]", body);
    }

    [Fact]
    public async Task RegisterMcpServerAsync_PostsAnHttpTransport()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"status\":\"pending\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.RegisterMcpServerAsync("remote", "http", null, null, null, "https://example.com/mcp", new[] { "search" });

        Assert.Contains("\"kind\":\"http\"", body);
        Assert.Contains("\"url\":\"https://example.com/mcp\"", body);
    }

    [Fact]
    public async Task DeleteMcpServerAsync_SendsDeleteToTheNamedServer()
    {
        string? path = null;
        string? method = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            method = request.Method.Method;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.DeleteMcpServerAsync("s1");

        Assert.Equal("/mcp-clients/servers/s1", path);
        Assert.Equal("DELETE", method);
    }

    [Fact]
    public async Task GetHooksAsync_ParsesTheRuleArrayIncludingLastRun()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"rules":[{"id":"abc1","phase":"pre","action":"deny","toolName":"file_write","pathContains":".env","enabled":true},{"id":"def2","phase":"post","action":"run-command","toolName":"file_write","enabled":false,"lastRun":{"at":"2026-01-01T00:00:00.000Z","ok":false,"error":"boom"}}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var hooks = await client.GetHooksAsync();

        Assert.Equal(2, hooks.Count);
        Assert.Equal("abc1", hooks[0].Id);
        Assert.Equal("pre", hooks[0].Phase);
        Assert.Equal("deny", hooks[0].Action);
        Assert.Equal(".env", hooks[0].PathContains);
        Assert.True(hooks[0].Enabled);
        Assert.Null(hooks[0].LastRunOk);
        Assert.False(hooks[1].Enabled);
        Assert.False(hooks[1].LastRunOk);
    }

    [Fact]
    public async Task GetHooksAsync_ReturnsEmptyWhenTheRulesKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var hooks = await client.GetHooksAsync();

        Assert.Empty(hooks);
    }

    [Fact]
    public async Task CreateHookAsync_PostsAllFieldsAsJson()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new StringContent("{\"id\":\"abc1\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.CreateHookAsync("post", "run-command", "file_write", pathContains: "*.cs", command: "dotnet", args: new[] { "format" }, reason: "keep it tidy");

        Assert.Equal("/hooks", path);
        Assert.Contains("\"phase\":\"post\"", body);
        Assert.Contains("\"action\":\"run-command\"", body);
        Assert.Contains("\"toolName\":\"file_write\"", body);
        Assert.Contains("\"pathContains\":\"*.cs\"", body);
        Assert.Contains("\"command\":\"dotnet\"", body);
        Assert.Contains("\"args\":[\"format\"]", body);
        Assert.Contains("\"reason\":\"keep it tidy\"", body);
    }

    [Fact]
    public async Task SetHookEnabledAsync_PatchesTheEnabledField()
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
                Content = new StringContent("{\"enabled\":false}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.SetHookEnabledAsync("abc1", false);

        Assert.Equal("/hooks/abc1", path);
        Assert.Equal("PATCH", method);
        Assert.Contains("\"enabled\":false", body);
    }

    [Fact]
    public async Task DeleteHookAsync_SendsDeleteToTheNamedRule()
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

        await client.DeleteHookAsync("abc1");

        Assert.Equal("/hooks/abc1", path);
        Assert.Equal("DELETE", method);
    }

    [Fact]
    public async Task Constructor_SendsNoAuthorizationHeaderWhenNoAdminTokenIsGiven()
    {
        AuthenticationHeaderValue? authHeader = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            authHeader = request.Headers.Authorization;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"reply\":\"ok\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.ReplyAsync("hi");

        Assert.Null(authHeader);
    }

    [Fact]
    public async Task Constructor_SendsABearerAuthorizationHeaderWhenAnAdminTokenIsGiven()
    {
        AuthenticationHeaderValue? authHeader = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            authHeader = request.Headers.Authorization;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"reply\":\"ok\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler, adminToken: "topsecret");

        await client.ReplyAsync("hi");

        Assert.NotNull(authHeader);
        Assert.Equal("Bearer", authHeader!.Scheme);
        Assert.Equal("topsecret", authHeader.Parameter);
    }

    [Fact]
    public async Task Constructor_UsesTheGivenBaseUrlInsteadOfTheDefault()
    {
        Uri? requestUri = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            requestUri = request.RequestUri;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"reply\":\"ok\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler, baseUrl: "http://192.168.1.50:5005");

        await client.ReplyAsync("hi");

        Assert.Equal("192.168.1.50", requestUri!.Host);
    }

    [Fact]
    public async Task RequestPairingCodeAsync_PostsToPairRequestAndReturnsTheCode()
    {
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"code\":\"123456\",\"expiresAt\":1700000000000}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var (code, expiresAt) = await client.RequestPairingCodeAsync();

        Assert.Equal("/mobile/pair/request", path);
        Assert.Equal("123456", code);
        Assert.Equal(1700000000000L, expiresAt);
    }

    [Fact]
    public async Task GetMobileDevicesAsync_ParsesTheDeviceArray()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"devices":[{"id":"d1","name":"My Phone","tokenHash":"abc","createdAt":"2026-01-01T00:00:00.000Z","lastSeenAt":null,"revoked":false},{"id":"d2","name":"Old Phone","createdAt":"2025-01-01T00:00:00.000Z","lastSeenAt":"2025-06-01T00:00:00.000Z","revoked":true}]}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var devices = await client.GetMobileDevicesAsync();

        Assert.Equal(2, devices.Count);
        Assert.Equal("My Phone", devices[0].Name);
        Assert.Null(devices[0].LastSeenAt);
        Assert.False(devices[0].Revoked);
        Assert.Equal("2025-06-01T00:00:00.000Z", devices[1].LastSeenAt);
        Assert.True(devices[1].Revoked);
    }

    [Fact]
    public async Task RevokeMobileDeviceAsync_ReturnsTrueOnSuccessAndFalseOn404()
    {
        var okHandler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
        });
        var okClient = new ManaBackendClient(okHandler);
        Assert.True(await okClient.RevokeMobileDeviceAsync("d1"));

        var notFoundHandler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        var notFoundClient = new ManaBackendClient(notFoundHandler);
        Assert.False(await notFoundClient.RevokeMobileDeviceAsync("missing"));
    }

    [Fact]
    public async Task RotateMobileDeviceTokenAsync_ReturnsTheNewTokenOrNullOn404()
    {
        string? path = null;
        var okHandler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"token\":\"new-token-value\"}", Encoding.UTF8, "application/json"),
            };
        });
        var okClient = new ManaBackendClient(okHandler);
        var token = await okClient.RotateMobileDeviceTokenAsync("d1");
        Assert.Equal("/mobile/devices/d1/rotate", path);
        Assert.Equal("new-token-value", token);

        var notFoundHandler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        var notFoundClient = new ManaBackendClient(notFoundHandler);
        Assert.Null(await notFoundClient.RotateMobileDeviceTokenAsync("missing"));
    }

    [Fact]
    public async Task GetAccountsAsync_ParsesTheBareJsonArray()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """[{"userId":"u1","email":"admin@example.com","role":"admin"},{"userId":"u2","email":"friend@example.com","role":"user"}]""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var accounts = await client.GetAccountsAsync();

        Assert.Equal(2, accounts.Count);
        Assert.Equal("admin@example.com", accounts[0].Email);
        Assert.Equal("admin", accounts[0].Role);
        Assert.Equal("u2", accounts[1].UserId);
    }

    [Fact]
    public async Task GetAccountsAsync_ReturnsEmptyForAnEmptyArray()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("[]", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var accounts = await client.GetAccountsAsync();

        Assert.Empty(accounts);
    }

    [Fact]
    public async Task CreateAccountAsync_PostsEmailAndRoleAndReturnsTheApiKey()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new StringContent(
                    """{"userId":"u3","email":"new@example.com","role":"user","apiKey":"mana_abc123","message":"Save your API key somewhere safe; it will not be shown again"}""",
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var apiKey = await client.CreateAccountAsync("new@example.com", "user");

        Assert.Equal("/admin/accounts", path);
        Assert.Contains("\"email\":\"new@example.com\"", body);
        Assert.Contains("\"role\":\"user\"", body);
        Assert.Equal("mana_abc123", apiKey);
    }

    [Fact]
    public async Task DeleteAccountAsync_SendsDeleteToTheNamedUser()
    {
        string? path = null;
        string? method = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            method = request.Method.Method;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.DeleteAccountAsync("u1");

        Assert.Equal("/admin/accounts/u1", path);
        Assert.Equal("DELETE", method);
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
    public async Task GetModelStatusAsync_ParsesBrainAndVisionFields()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"activeProfile":"default","profiles":{},"selectedModelPath":"C:\\models\\a.gguf","brain":{"type":"openai_compatible","baseUrl":"https://api.openai.com/v1","model":"gpt-4o","hasApiKey":true},"vision":{"modelPath":"C:\\models\\v.gguf","mmprojPath":"C:\\models\\mmproj.gguf"}}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetModelStatusAsync();

        Assert.Equal(@"C:\models\a.gguf", status.SelectedModelPath);
        Assert.Equal("openai_compatible", status.BrainType);
        Assert.Equal("https://api.openai.com/v1", status.BrainBaseUrl);
        Assert.Equal("gpt-4o", status.BrainModel);
        Assert.True(status.BrainHasApiKey);
        Assert.Equal(@"C:\models\v.gguf", status.VisionModelPath);
        Assert.Equal(@"C:\models\mmproj.gguf", status.VisionMmprojPath);
    }

    [Fact]
    public async Task GetModelStatusAsync_DefaultsBrainTypeToLocalWhenBrainIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var status = await client.GetModelStatusAsync();

        Assert.Equal("local", status.BrainType);
        Assert.False(status.BrainHasApiKey);
        Assert.Null(status.SelectedModelPath);
    }

    [Fact]
    public async Task SetActiveProfileAsync_PostsTheProfileName()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.SetActiveProfileAsync("quality");

        Assert.Equal("/models/active-profile", path);
        Assert.Contains("\"profile\":\"quality\"", body);
    }

    [Fact]
    public async Task ScanForModelsAsync_ParsesFoundFilesAndTruncated()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"found":[{"path":"C:\\models\\a.gguf","name":"a.gguf","sizeBytes":123456}],"truncated":true,"dirsVisited":100}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.ScanForModelsAsync();

        var file = Assert.Single(result.Files);
        Assert.Equal(@"C:\models\a.gguf", file.Path);
        Assert.Equal(123456, file.SizeBytes);
        Assert.True(result.Truncated);
    }

    [Fact]
    public async Task SetModelPathAsync_PostsTheGivenPathOrNull()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.SetModelPathAsync(null);

        Assert.Contains("\"modelPath\":null", body);
    }

    [Fact]
    public async Task SetBrainSettingsAsync_PostsAllFields()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.SetBrainSettingsAsync("openai_compatible", "https://api.openai.com/v1", "sk-abc", "gpt-4o");

        Assert.Equal("/models/brain-provider", path);
        Assert.Contains("\"type\":\"openai_compatible\"", body);
        Assert.Contains("\"apiKey\":\"sk-abc\"", body);
    }

    [Fact]
    public async Task SetBrainSettingsAsync_OmitsApiKeyAsNullWhenNotGiven()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.SetBrainSettingsAsync("local", "http://127.0.0.1:11434/v1", null, "");

        Assert.Contains("\"apiKey\":null", body);
    }

    [Fact]
    public async Task GetBrainProvidersAsync_ParsesTheBareArray()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """[{"id":"openai","label":"OpenAI","baseUrl":"https://api.openai.com/v1","needsKey":true},{"id":"ollama","label":"Ollama (local)","baseUrl":"http://127.0.0.1:11434/v1","needsKey":false}]""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var presets = await client.GetBrainProvidersAsync();

        Assert.Equal(2, presets.Count);
        Assert.Equal("OpenAI", presets[0].Label);
        Assert.True(presets[0].NeedsKey);
        Assert.False(presets[1].NeedsKey);
    }

    [Fact]
    public async Task TestBrainConnectionAsync_ParsesOkAndError()
    {
        var okHandler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
        });
        var okClient = new ManaBackendClient(okHandler);
        var (ok, _) = await okClient.TestBrainConnectionAsync("http://127.0.0.1:11434/v1", null);
        Assert.True(ok);

        var failHandler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"ok\":false,\"error\":\"connection refused\"}", Encoding.UTF8, "application/json"),
        });
        var failClient = new ManaBackendClient(failHandler);
        var (failOk, error) = await failClient.TestBrainConnectionAsync("http://127.0.0.1:9/v1", null);
        Assert.False(failOk);
        Assert.Equal("connection refused", error);
    }

    [Fact]
    public async Task SetVisionSettingsAsync_PostsBothPaths()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.SetVisionSettingsAsync("C:\\models\\v.gguf", "");

        Assert.Equal("/models/vision-path", path);
        Assert.Contains(@"""modelPath"":""C:\\models\\v.gguf""", body);
        Assert.Contains("\"mmprojPath\":\"\"", body);
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

    [Fact]
    public async Task GetProposalsAsync_ParsesTheProposalArray()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/editors/workspace/proposals", request.RequestUri!.AbsolutePath);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"proposals":[{"id":"p1","status":"pending","relativePath":"src/main.js","summary":"refactor","hunkCount":2,"createdAt":"2026-03-15T12:00:00.000Z"}]}""",
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var proposals = await client.GetProposalsAsync();

        Assert.Single(proposals);
        Assert.Equal("p1", proposals[0].Id);
        Assert.Equal("pending", proposals[0].Status);
        Assert.Equal(2, proposals[0].HunkCount);
    }

    [Fact]
    public async Task GetProposalsAsync_ReturnsEmptyWhenTheProposalsKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var proposals = await client.GetProposalsAsync();

        Assert.Empty(proposals);
    }

    [Fact]
    public async Task GetProposalDetailAsync_ParsesHunksWithTheirLines()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/editors/workspace/proposals/p1", request.RequestUri!.AbsolutePath);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """
                    {
                      "proposal": {
                        "id": "p1",
                        "status": "pending",
                        "relativePath": "src/main.js",
                        "summary": "refactor",
                        "hunks": [
                          {"id": "hunk-0", "oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 3, "lines": [" a", "-b", "+b2", "+c"]}
                        ]
                      }
                    }
                    """,
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var detail = await client.GetProposalDetailAsync("p1");

        Assert.NotNull(detail);
        Assert.Equal("p1", detail!.Id);
        Assert.Single(detail.Hunks);
        Assert.Equal("hunk-0", detail.Hunks[0].Id);
        Assert.Equal(1, detail.Hunks[0].OldStart);
        Assert.Equal(new[] { " a", "-b", "+b2", "+c" }, detail.Hunks[0].Lines);
    }

    [Fact]
    public async Task GetProposalDetailAsync_ReturnsNullOn404()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            Content = new StringContent("""{"proposal":null,"error":"edit proposal not found"}""", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var detail = await client.GetProposalDetailAsync("missing");

        Assert.Null(detail);
    }

    [Fact]
    public async Task ApproveProposalAsync_PostsAcceptedHunkIdsAndReturnsApprovedOnSuccess()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"proposal":{"id":"p1","status":"applied"}}""", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var result = await client.ApproveProposalAsync("p1", new[] { "hunk-0", "hunk-1" });

        Assert.Equal("/editors/workspace/proposals/p1/approve", path);
        Assert.Contains("\"acceptedHunkIds\":[\"hunk-0\",\"hunk-1\"]", body);
        Assert.True(result.Approved);
    }

    [Fact]
    public async Task ApproveProposalAsync_ReturnsTheErrorOn400WithoutThrowing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("""{"proposal":null,"error":"edit proposal is not pending"}""", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.ApproveProposalAsync("p1", new[] { "hunk-0" });

        Assert.False(result.Approved);
        Assert.Equal("edit proposal is not pending", result.Error);
    }

    [Fact]
    public async Task GetEditSnapshotsAsync_ParsesTheSnapshotArray()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/editors/workspace/snapshots", request.RequestUri!.AbsolutePath);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"snapshots":[{"id":"s1","relativePath":"src/main.js","summary":"edited main.js","appliedAt":"2026-03-15T12:00:00.000Z"}]}""",
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var snapshots = await client.GetEditSnapshotsAsync();

        Assert.Single(snapshots);
        Assert.Equal("s1", snapshots[0].Id);
        Assert.Equal("src/main.js", snapshots[0].RelativePath);
        Assert.Equal("edited main.js", snapshots[0].Summary);
    }

    [Fact]
    public async Task GetEditSnapshotsAsync_ReturnsEmptyWhenTheSnapshotsKeyIsMissing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var snapshots = await client.GetEditSnapshotsAsync();

        Assert.Empty(snapshots);
    }

    [Fact]
    public async Task RestoreEditSnapshotAsync_PostsConfirmStaleAndReturnsRestoredOnSuccess()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"restored":{"id":"s1","relativePath":"src/main.js","restoredAt":"now"}}""", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var result = await client.RestoreEditSnapshotAsync("s1");

        Assert.Equal("/editors/workspace/snapshots/s1/restore", path);
        Assert.Contains("\"confirmStale\":false", body);
        Assert.True(result.Restored);
        Assert.False(result.Stale);
    }

    [Fact]
    public async Task RestoreEditSnapshotAsync_ReturnsStaleOn409WithoutThrowing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.Conflict)
        {
            Content = new StringContent(
                """{"restored":null,"stale":{"id":"s1","newerSnapshotId":"s2","newerAppliedAt":"2026-03-15T13:00:00.000Z"},"error":"snapshot is stale"}""",
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.RestoreEditSnapshotAsync("s1");

        Assert.False(result.Restored);
        Assert.True(result.Stale);
        Assert.Equal("2026-03-15T13:00:00.000Z", result.NewerAppliedAt);
        Assert.Equal("snapshot is stale", result.Error);
    }

    [Fact]
    public async Task RestoreEditSnapshotAsync_ReturnsTheErrorOn400WithoutThrowing()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("""{"restored":null,"error":"workspace file does not exist"}""", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var result = await client.RestoreEditSnapshotAsync("s1");

        Assert.False(result.Restored);
        Assert.False(result.Stale);
        Assert.Equal("workspace file does not exist", result.Error);
    }

    [Fact]
    public async Task RestoreEditSnapshotAsync_SendsConfirmStaleTrueWhenRequested()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"restored":{"id":"s1"}}""", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.RestoreEditSnapshotAsync("s1", confirmStale: true);

        Assert.Contains("\"confirmStale\":true", body);
    }

    [Fact]
    public async Task GetBrowserAutomationActivityAsync_ParsesTheLogAndScreenshot()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/browser-automation/activity", request.RequestUri!.AbsolutePath);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """
                    {
                      "log": [{"action":"navigate","status":"ok","summary":"Navigating to https://example.com","at":"2026-01-01T00:00:00.000Z"}],
                      "screenshot": {"base64":"base64-jpeg-data","at":"2026-01-01T00:00:00.000Z"}
                    }
                    """,
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var activity = await client.GetBrowserAutomationActivityAsync();

        Assert.Single(activity.Log);
        Assert.Equal("navigate", activity.Log[0].Action);
        Assert.Equal("Navigating to https://example.com", activity.Log[0].Summary);
        Assert.Equal("base64-jpeg-data", activity.ScreenshotBase64);
    }

    [Fact]
    public async Task GetBrowserAutomationActivityAsync_ReturnsEmptyLogAndNullScreenshotBeforeAnythingHasHappened()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"log":[],"screenshot":null}""", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var activity = await client.GetBrowserAutomationActivityAsync();

        Assert.Empty(activity.Log);
        Assert.Null(activity.ScreenshotBase64);
    }

    [Fact]
    public async Task StartResearchAsync_PostsTheQuestionAndReturnsTheJobId()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.Accepted)
            {
                Content = new StringContent("{\"jobId\":\"job-1\",\"status\":\"running\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var jobId = await client.StartResearchAsync("what is FFXIV?");

        Assert.Equal("/research/start", path);
        Assert.Contains("\"question\":\"what is FFXIV?\"", body);
        Assert.DoesNotContain("sessionId", body);
        Assert.Equal("job-1", jobId);
    }

    [Fact]
    public async Task StartResearchAsync_IncludesSessionIdWhenGiven()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.Accepted)
            {
                Content = new StringContent("{\"jobId\":\"job-1\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.StartResearchAsync("question", sessionId: "s1");

        Assert.Contains("\"sessionId\":\"s1\"", body);
    }

    [Fact]
    public async Task StartResearchAsync_ThrowsWithTheServerDetailOnFailure()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
        {
            Content = new StringContent("Deep research is not configured", Encoding.UTF8, "text/plain"),
        });
        var client = new ManaBackendClient(handler);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => client.StartResearchAsync("question"));
        Assert.Equal("Deep research is not configured", ex.Message);
    }

    [Fact]
    public async Task GetResearchJobAsync_ParsesARunningJobsProgressLabel()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/research/job-1", request.RequestUri!.AbsolutePath);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"status":"running","progress":{"step":"searching","label":"Searching the web..."}}""",
                    Encoding.UTF8,
                    "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var job = await client.GetResearchJobAsync("job-1");

        Assert.Equal("running", job.Status);
        Assert.Equal("Searching the web...", job.ProgressLabel);
        Assert.Null(job.Result);
        Assert.Null(job.Error);
    }

    [Fact]
    public async Task GetResearchJobAsync_ParsesAFinishedJobsFullResult()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """
                {
                  "status": "done",
                  "result": {
                    "report": "The findings.",
                    "sources": [{"index": 1, "title": "A Source", "url": "https://example.com", "readFailed": false}],
                    "subQueries": ["q1", "q2"],
                    "bounds": {"hitTimeLimit": true, "hitSourceLimit": false, "sourcesUsed": 4, "maxSources": 10, "elapsedMs": 30000}
                  }
                }
                """,
                Encoding.UTF8,
                "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var job = await client.GetResearchJobAsync("job-1");

        Assert.Equal("done", job.Status);
        Assert.NotNull(job.Result);
        Assert.Equal("The findings.", job.Result!.Report);
        Assert.Single(job.Result.Sources);
        Assert.Equal("A Source", job.Result.Sources[0].Title);
        Assert.Equal(new[] { "q1", "q2" }, job.Result.SubQueries);
        Assert.True(job.Result.Bounds!.HitTimeLimit);
        Assert.Equal(30000, job.Result.Bounds.ElapsedMs);
    }

    [Fact]
    public async Task GetResearchJobAsync_ParsesAnErroredJob()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"status":"error","error":"llama-server exploded"}""", Encoding.UTF8, "application/json"),
        });
        var client = new ManaBackendClient(handler);

        var job = await client.GetResearchJobAsync("job-1");

        Assert.Equal("error", job.Status);
        Assert.Equal("llama-server exploded", job.Error);
        Assert.Null(job.Result);
    }

    [Fact]
    public async Task CancelResearchJobAsync_PostsToTheCancelEndpoint()
    {
        string? path = null;
        string? method = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            method = request.Method.Method;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"status\":\"running\",\"cancelRequested\":true}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        await client.CancelResearchJobAsync("job-1");

        Assert.Equal("/research/job-1/cancel", path);
        Assert.Equal("POST", method);
    }
}
