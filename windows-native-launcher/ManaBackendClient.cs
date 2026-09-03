using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

internal sealed class ManaBackendClient
{
    private readonly HttpClient http;

    // handler: null (the default, and every existing call site's
    // behavior) constructs a real HttpClient against the live backend.
    // Tests pass a fake HttpMessageHandler to exercise the request/parse
    // logic without a live server.
    public ManaBackendClient(HttpMessageHandler? handler = null)
    {
        http = handler is null
            ? new HttpClient()
            : new HttpClient(handler);
        http.BaseAddress = new System.Uri("http://127.0.0.1:5005");
    }

    public async Task<ManaPerformanceStatus> GetPerformanceStatusAsync()
    {
        using var response = await http.GetAsync("/perf/status");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var process = root.GetProperty("process");
        var config = root.GetProperty("config");
        var gaming = root.GetProperty("gaming");

        return new ManaPerformanceStatus
        {
            TotalMemoryMb = process.GetProperty("totalMemoryMb").GetInt32(),
            TtsProvider = config.GetProperty("ttsProvider").GetString() ?? "unknown",
            GamingAppRunning = gaming.GetProperty("gamingAppRunning").GetBoolean(),
        };
    }

    public async Task<string> TranscribeAsync(byte[] wavBytes)
    {
        using var content = new MultipartFormDataContent();
        using var fileContent = new ByteArrayContent(wavBytes);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        content.Add(fileContent, "file", "clip.wav");

        using var response = await http.PostAsync("/transcribe-only", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.GetProperty("transcript").GetString() ?? string.Empty;
    }

    public async Task<string> ReplyAsync(string text)
    {
        var payload = JsonSerializer.Serialize(new { text });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/reply", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.GetProperty("reply").GetString() ?? string.Empty;
    }

    public async Task<byte[]> SynthesizeAsync(string text)
    {
        var payload = JsonSerializer.Serialize(new { text });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/synthesize", content);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsByteArrayAsync();
    }

    // Issue #331 (#479 sub-project 2): POST /reply/stream sends newline-
    // delimited JSON, one object per line -- zero or more {"type":
    // "sentence","text":"..."} events as the reply streams, then exactly
    // one {"type":"final",...} event. HttpCompletionOption.ResponseHeadersRead
    // is required here (unlike every other call in this file) -- without
    // it, HttpClient buffers the entire response body before this method
    // could read a single line, defeating the whole point of streaming.
    // #520: sessionId, when present, routes this turn's history into that
    // ACP memory-store session instead of node-bot's implicit "default"
    // one -- omitted (not sent as null) exactly matches every call this
    // launcher made before session support existed.
    public async IAsyncEnumerable<ReplyStreamEvent> ReplyStreamAsync(string text, string? sessionId = null)
    {
        var payload = sessionId is null
            ? JsonSerializer.Serialize(new { text })
            : JsonSerializer.Serialize(new { text, sessionId });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/reply/stream") { Content = content };
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream, Encoding.UTF8);

        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }
            using var document = JsonDocument.Parse(line);
            yield return ParseReplyStreamEvent(document.RootElement);
        }
    }

    // #520: node-bot's ACP memory-store sessions -- see
    // capabilities/sessions-capability.js for the exact route shapes.
    public async Task<IReadOnlyList<ManaSession>> GetSessionsAsync()
    {
        using var response = await http.GetAsync("/sessions");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var sessions = new List<ManaSession>();
        if (document.RootElement.TryGetProperty("sessions", out var sessionsElement))
        {
            foreach (var element in sessionsElement.EnumerateArray())
            {
                sessions.Add(new ManaSession
                {
                    SessionId = element.TryGetProperty("sessionId", out var idElement) ? idElement.GetString() ?? "" : "",
                    Name = element.TryGetProperty("name", out var nameElement) ? nameElement.GetString() : null,
                    UpdatedAt = element.TryGetProperty("updatedAt", out var updatedElement) ? updatedElement.GetString() : null,
                });
            }
        }
        return sessions;
    }

    // Returns false (rather than throwing) on a 404 -- "the session doesn't
    // exist to rename" is an expected outcome here (e.g. deleted from
    // elsewhere between listing and acting), not a transport failure.
    public async Task<bool> RenameSessionAsync(string sessionId, string name)
    {
        var payload = JsonSerializer.Serialize(new { name });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PatchAsync($"/sessions/{Uri.EscapeDataString(sessionId)}", content);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return false;
        }
        response.EnsureSuccessStatusCode();
        return true;
    }

    public async Task<bool> DeleteSessionAsync(string sessionId)
    {
        using var response = await http.DeleteAsync($"/sessions/{Uri.EscapeDataString(sessionId)}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return false;
        }
        response.EnsureSuccessStatusCode();
        return true;
    }

    // Raw ShareGPT-style JSONL text -- the caller (SessionListForm) is
    // what actually writes it to disk via a native save dialog, matching
    // windows-launcher's own split (node-bot just returns the text; the
    // client owns the save UI).
    public async Task<string> ExportSessionAsync(string sessionId)
    {
        using var response = await http.GetAsync($"/sessions/{Uri.EscapeDataString(sessionId)}/export");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    // #479 sub-project 3 (barge-in): classifies a transcribed interruption
    // so the caller can decide how to react -- currently just whether to
    // wrap the transcript as an amendment before treating it as the next
    // turn. On any failure (network, non-2xx, malformed body), falls back
    // to "unclassified" rather than throwing -- matches
    // windows-launcher/renderer/renderer.js's classifyBargeInText, which
    // treats a failed classify call as a soft signal, not a fatal error:
    // the interruption still gets handled, just without the category hint.
    public async Task<string> ClassifyBargeInAsync(string text)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new { text });
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var response = await http.PostAsync("/barge-in/classify", content);
            if (!response.IsSuccessStatusCode)
            {
                return "unclassified";
            }
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            return document.RootElement.TryGetProperty("category", out var categoryProp)
                ? categoryProp.GetString() ?? "unclassified"
                : "unclassified";
        }
        catch (HttpRequestException)
        {
            return "unclassified";
        }
        catch (JsonException)
        {
            return "unclassified";
        }
        catch (OperationCanceledException)
        {
            // Covers TaskCanceledException (HttpClient's own timeout throws
            // this specifically) -- without it, a slow backend would break
            // this method's own "falls back to unclassified rather than
            // throwing" contract, and the caller (VoiceLoop.ProcessTurnAsync)
            // has no try/catch of its own around this call, unlike every
            // other backend call in that method.
            return "unclassified";
        }
    }

    private static ReplyStreamEvent ParseReplyStreamEvent(JsonElement root)
    {
        return new ReplyStreamEvent
        {
            Type = root.GetProperty("type").GetString() ?? "",
            Text = root.TryGetProperty("text", out var textProp) ? textProp.GetString() : null,
            Reply = root.TryGetProperty("reply", out var replyProp) ? replyProp.GetString() : null,
            Changed = root.TryGetProperty("changed", out var changedProp) && changedProp.GetBoolean(),
            Expression = root.TryGetProperty("expression", out var exprProp) ? exprProp.GetString() : null,
            Error = root.TryGetProperty("error", out var errProp) ? errProp.GetString() : null,
        };
    }
}

internal sealed class ManaPerformanceStatus
{
    public int TotalMemoryMb { get; init; }
    public string TtsProvider { get; init; } = "unknown";
    public bool GamingAppRunning { get; init; }
}

// #520: a row from GET /sessions -- see acp-memory-store.js's
// listSessions for the full stored shape; this only carries what the
// session list UI needs.
internal sealed class ManaSession
{
    public string SessionId { get; init; } = "";
    public string? Name { get; init; }
    public string? UpdatedAt { get; init; }
}

internal sealed class ReplyStreamEvent
{
    public string Type { get; init; } = "";
    public string? Text { get; init; }
    public string? Reply { get; init; }
    public bool Changed { get; init; }
    public string? Expression { get; init; }
    public string? Error { get; init; }
}
