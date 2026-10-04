using System;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

internal sealed class ManaBackendClient
{
    private readonly HttpClient http;

    // handler: null (the default, and every existing call site's
    // behavior) constructs a real HttpClient against the live backend.
    // Tests pass a fake HttpMessageHandler to exercise the request/parse
    // logic without a live server.
    // #565: baseUrl/adminToken default to null so every existing call
    // site (real and test) keeps working unchanged -- null baseUrl means
    // the same hardcoded local address this always used, and a null/empty
    // adminToken means no Authorization header (with no MANA_ADMIN_SECRET,
    // the per-run launcherKey below is what admin routes check, #842). Setting the
    // header once here via DefaultRequestHeaders (rather than adding it to
    // every individual request below) covers every current and future
    // method in this file for free.
    // #670: launcherKey is ManaProcessManager.LauncherKey, sent as
    // x-admin-token -- node-bot's admin routes (restart, accounts, mobile
    // devices, llama.cpp builds, skill import) need it or ADMIN_TOKEN now.
    public ManaBackendClient(HttpMessageHandler? handler = null, string? baseUrl = null, string? adminToken = null, string? launcherKey = null)
    {
        http = handler is null
            ? new HttpClient()
            : new HttpClient(handler);
        http.BaseAddress = new System.Uri(baseUrl ?? "http://127.0.0.1:5005");
        if (!string.IsNullOrEmpty(adminToken))
        {
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        }
        if (!string.IsNullOrEmpty(launcherKey))
        {
            http.DefaultRequestHeaders.Add("X-Admin-Token", launcherKey);
        }
    }

    // Every backend route and WebSocket needs the key now (default deny), so
    // the tray and vision-capture sockets send the same headers as http.
    internal IEnumerable<KeyValuePair<string, string>> AuthHeaders() =>
        http.DefaultRequestHeaders.Select(h => new KeyValuePair<string, string>(h.Key, string.Join(",", h.Value)));

    internal void Authorize(System.Net.WebSockets.ClientWebSocket socket)
    {
        foreach (var (name, value) in AuthHeaders())
        {
            socket.Options.SetRequestHeader(name, value);
        }
    }

    // #575: extended with uptime/config/operations -- operations is a
    // free-form dictionary (server.js's perfMetrics.operations: whatever
    // shape each operation last logged, e.g. reply_token_usage's
    // {lastTokens,session,updatedAt}), so each entry's value is kept as
    // its own compact JSON string rather than modeled per-operation; the
    // Perf tab just displays it, it doesn't need to parse it further.
    // sessionId: optional -- when given, node-bot's /perf/status also
    // returns a "tokenUsage" object (this session's remote-AI prompt/
    // completion/total token counts + warn/stop thresholds), but only when
    // remote AI is actually on (issue #421: a local-only session has no
    // cost to meter, so the backend omits the field entirely rather than
    // sending zeros). ManaPerformanceStatus.TokenUsage is null whenever the
    // backend didn't include it -- callers should treat null as "not
    // applicable right now", not as zero usage.
    public async Task<ManaPerformanceStatus> GetPerformanceStatusAsync(string? sessionId = null)
    {
        var url = string.IsNullOrEmpty(sessionId)
            ? "/perf/status"
            : $"/perf/status?sessionId={Uri.EscapeDataString(sessionId)}";
        using var response = await http.GetAsync(url);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var process = root.GetProperty("process");
        var config = root.GetProperty("config");
        var gaming = root.GetProperty("gaming");

        var operations = new Dictionary<string, string>();
        if (root.TryGetProperty("operations", out var operationsElement) && operationsElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in operationsElement.EnumerateObject())
            {
                operations[property.Name] = property.Value.GetRawText();
            }
        }

        ManaSessionTokenUsage? tokenUsage = null;
        if (root.TryGetProperty("tokenUsage", out var tokenUsageElement) && tokenUsageElement.ValueKind == JsonValueKind.Object)
        {
            tokenUsage = new ManaSessionTokenUsage
            {
                PromptTokens = tokenUsageElement.TryGetProperty("promptTokens", out var pt) ? pt.GetInt64() : 0,
                CompletionTokens = tokenUsageElement.TryGetProperty("completionTokens", out var ct) ? ct.GetInt64() : 0,
                TotalTokens = tokenUsageElement.TryGetProperty("totalTokens", out var tt) ? tt.GetInt64() : 0,
                Calls = tokenUsageElement.TryGetProperty("calls", out var callsEl) ? callsEl.GetInt32() : 0,
                WarnThreshold = tokenUsageElement.TryGetProperty("warnThreshold", out var wt) && wt.ValueKind == JsonValueKind.Number ? wt.GetInt64() : null,
                StopThreshold = tokenUsageElement.TryGetProperty("stopThreshold", out var st) && st.ValueKind == JsonValueKind.Number ? st.GetInt64() : null,
                WarnExceeded = tokenUsageElement.TryGetProperty("warnExceeded", out var we) && we.GetBoolean(),
                StopExceeded = tokenUsageElement.TryGetProperty("stopExceeded", out var se) && se.GetBoolean(),
            };
        }

        return new ManaPerformanceStatus
        {
            TotalMemoryMb = process.GetProperty("totalMemoryMb").GetInt32(),
            TtsProvider = config.GetProperty("ttsProvider").GetString() ?? "unknown",
            GamingAppRunning = gaming.GetProperty("gamingAppRunning").GetBoolean(),
            MatchedProcesses = gaming.TryGetProperty("matchedProcesses", out var matchedEl) && matchedEl.ValueKind == JsonValueKind.Array
                ? matchedEl.EnumerateArray().Select(p => p.GetString()).OfType<string>().ToList()
                : Array.Empty<string>(),
            UptimeSeconds = root.TryGetProperty("uptimeSeconds", out var uptimeEl) ? uptimeEl.GetInt64() : 0,
            WhisperThreads = config.TryGetProperty("whisperThreads", out var whisperEl) ? whisperEl.GetInt32() : 0,
            LlamaThreads = config.TryGetProperty("llamaThreads", out var llamaThreadsEl) ? llamaThreadsEl.GetInt32() : 0,
            LlamaMaxTokens = config.TryGetProperty("llamaMaxTokens", out var llamaMaxEl) ? llamaMaxEl.GetInt32() : 0,
            ScreenContextEnabled = config.TryGetProperty("screenContextEnabled", out var screenEl) && screenEl.GetBoolean(),
            ChatModel = config.TryGetProperty("chatModel", out var chatModelEl) && chatModelEl.ValueKind == JsonValueKind.String ? chatModelEl.GetString() : null,
            Operations = operations,
            TokenUsage = tokenUsage,
        };
    }

    // #1343: Tri-mode dedicated engineering engine session API
    public record CodingSessionStatus(bool Active, bool IsGaming, string? Game);

    public async Task<CodingSessionStatus> GetCodingSessionStatusAsync(string? sessionId = null)
    {
        try
        {
            var url = string.IsNullOrEmpty(sessionId)
                ? "/coding-session/status"
                : $"/coding-session/status?sessionId={Uri.EscapeDataString(sessionId)}";
            using var response = await http.GetAsync(url);
            if (!response.IsSuccessStatusCode) return new CodingSessionStatus(false, false, null);
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            var root = document.RootElement;
            var active = root.TryGetProperty("active", out var a) && a.GetBoolean();
            var isGaming = root.TryGetProperty("isGaming", out var g) && g.GetBoolean();
            var game = root.TryGetProperty("game", out var gm) && gm.ValueKind == JsonValueKind.String ? gm.GetString() : null;
            return new CodingSessionStatus(active, isGaming, game);
        }
        catch
        {
            return new CodingSessionStatus(false, false, null);
        }
    }

    public async Task<bool> StartCodingSessionAsync(string? sessionId = null)
    {
        try
        {
            var content = new StringContent(
                JsonSerializer.Serialize(new { sessionId }),
                Encoding.UTF8,
                "application/json");
            using var response = await http.PostAsync("/coding-session/start", content);
            if (!response.IsSuccessStatusCode) return false;
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            return document.RootElement.TryGetProperty("ok", out var ok) && ok.GetBoolean();
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> StopCodingSessionAsync(string? sessionId = null, string reason = "user_exit")
    {
        try
        {
            var content = new StringContent(
                JsonSerializer.Serialize(new { sessionId, reason }),
                Encoding.UTF8,
                "application/json");
            using var response = await http.PostAsync("/coding-session/stop", content);
            if (!response.IsSuccessStatusCode) return false;
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            return document.RootElement.TryGetProperty("ok", out var ok) && ok.GetBoolean();
        }
        catch
        {
            return false;
        }
    }

    // #526: unlike GetPerformanceStatusAsync, this does NOT call
    // EnsureSuccessStatusCode unconditionally -- node-bot's own /doctor
    // handler returns 503 (not 200) precisely when it found real
    // problems, still with a fully-shaped, parseable result body. Only a
    // genuinely unexpected status (500: the doctor run itself errored)
    // should throw.
    public async Task<ManaDoctorResult> GetDoctorResultAsync()
    {
        using var response = await http.GetAsync("/doctor");
        if (!response.IsSuccessStatusCode && response.StatusCode != System.Net.HttpStatusCode.ServiceUnavailable)
        {
            response.EnsureSuccessStatusCode();
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        var ok = root.TryGetProperty("ok", out var okElement) && okElement.GetBoolean();

        var pass = 0;
        var warn = 0;
        var fail = 0;
        if (root.TryGetProperty("summary", out var summaryElement))
        {
            pass = summaryElement.TryGetProperty("pass", out var passElement) ? passElement.GetInt32() : 0;
            warn = summaryElement.TryGetProperty("warn", out var warnElement) ? warnElement.GetInt32() : 0;
            fail = summaryElement.TryGetProperty("fail", out var failElement) ? failElement.GetInt32() : 0;
        }

        var checks = new List<ManaDoctorCheck>();
        if (root.TryGetProperty("checks", out var checksElement))
        {
            foreach (var checkElement in checksElement.EnumerateArray())
            {
                checks.Add(new ManaDoctorCheck
                {
                    Id = checkElement.TryGetProperty("id", out var idElement) ? idElement.GetString() ?? "" : "",
                    Label = checkElement.TryGetProperty("label", out var labelElement) ? labelElement.GetString() ?? "" : "",
                    Status = checkElement.TryGetProperty("status", out var statusElement) ? statusElement.GetString() ?? "" : "",
                    Message = checkElement.TryGetProperty("message", out var messageElement) ? messageElement.GetString() ?? "" : "",
                });
            }
        }

        return new ManaDoctorResult
        {
            Ok = ok,
            Pass = pass,
            Warn = warn,
            Fail = fail,
            Checks = checks,
        };
    }

    // #619: VoiceLoop only polls live partial transcripts against a backend
    // on this machine -- over the network the extra Whisper round trips
    // would mostly arrive too late to help and just add load.
    public bool IsLocalBackend => http.BaseAddress?.IsLoopback == true;

    // #925: Heard is what whisper wrote, only when one of my mishearing
    // fixes changed it into Transcript. #1107: Model (the file name) and
    // Language, for a kept voice clip's sidecar.
    public Task<(string Transcript, string? Heard, string? Model, string? Language)> TranscribeAsync(byte[] wavBytes) => TranscribeAsync("/transcribe-only", wavBytes, default);

    // #619: same upload to node-bot's /transcribe-partial (the endpoint
    // windows-launcher's pollPartialTranscript uses) -- async on the server,
    // so a poll never blocks the final /transcribe-only behind it.
    public async Task<string> TranscribePartialAsync(byte[] wavBytes, CancellationToken cancellationToken) =>
        (await TranscribeAsync("/transcribe-partial", wavBytes, cancellationToken)).Transcript;

    private async Task<(string Transcript, string? Heard, string? Model, string? Language)> TranscribeAsync(string route, byte[] wavBytes, CancellationToken cancellationToken)
    {
        using var content = new MultipartFormDataContent();
        using var fileContent = new ByteArrayContent(wavBytes);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        content.Add(fileContent, "file", "clip.wav");

        using var response = await http.PostAsync(route, content, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        string? Optional(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return (root.GetProperty("transcript").GetString() ?? string.Empty, Optional("heard"), Optional("model"), Optional("language"));
    }

    // #681: answers a /ws/vision-capture request (VisionCaptureClient).
    // node-bot wants exactly one of image ("data:image/jpeg;base64,...")
    // or error, so only the non-null one is sent. #911: a desktop action
    // answers with a result object instead of an image.
    public async Task PostVisionCaptureResultAsync(string requestId, string? image, string? error, object? result = null)
    {
        var payload = error is not null
            ? JsonSerializer.Serialize(new { requestId, error })
            : result is not null
                ? JsonSerializer.Serialize(new { requestId, result })
                : JsonSerializer.Serialize(new { requestId, image });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/vision/capture-result", content);
        response.EnsureSuccessStatusCode();
    }

    // #527: modelProfile, when given, routes this one request to that
    // llama-server profile instead of whatever's currently active --
    // compare-mode's only real requirement. cancellationToken lets
    // compare-mode's own Cancel button actually abort an in-flight
    // request rather than just ignoring its eventual result.
    public async Task<string> ReplyAsync(string text, string? modelProfile = null, CancellationToken cancellationToken = default)
    {
        var payload = modelProfile is null
            ? JsonSerializer.Serialize(new { text })
            : JsonSerializer.Serialize(new { text, modelProfile });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/reply", content, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return document.RootElement.GetProperty("reply").GetString() ?? string.Empty;
    }

    // #909: emotion is the sentence's tag, which Qwen3-TTS turns into her
    // speaking rate; null leaves the voice as it is.
    // #914: character (a reply event's) speaks in her own voice; null, the active one's.
    // #1329: spoken replies don't read citation markers aloud.
    public static string StripCitationMarkers(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;
        var stripped = System.Text.RegularExpressions.Regex.Replace(text, @"\[\d+\](?:\([^)]*\))?", "");
        return System.Text.RegularExpressions.Regex.Replace(stripped, @"\s+([.,!?;:])", "$1").Trim();
    }

    public async Task<byte[]> SynthesizeAsync(string text, string? emotion = null, string? character = null)
    {
        var cleanText = StripCitationMarkers(text);
        var payload = JsonSerializer.Serialize(new { text = cleanText, emotion, character });
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
    // ACP memory-store session. Omitted (not sent as null), node-bot saves
    // no turn at all -- why VoiceLoop always sends one (Q62).
    // #522: screenText is always sent (defaulting to "", matching
    // windows-launcher's own requestScreenAwareReply, which always
    // includes the field even when readScreenContext came back empty).
    // #523: image (a "data:image/jpeg;base64,..." string) is, like
    // sessionId, only included in the JSON payload when present -- an
    // absent image key (not an empty one) is what tells node-bot's
    // handler this is a text-only turn.
    // #585: images (plural), when non-empty, takes precedence over the
    // single image field -- matches node-bot's own /reply/stream handler,
    // which accepts either shape and only falls back to wrapping a single
    // image into a 1-item array when images isn't sent. Built as a
    // Dictionary rather than the old fixed (sessionId, image) switch this
    // replaced -- adding a third optional field would have doubled that
    // switch's case count for no benefit.
    // #681: presetId (the active prompt preset, Settings > Presets) is
    // omitted when empty, matching windows-launcher's
    // `presetId: selectedPresetId || undefined`.
    // #675: thinkHarder (the main window's deep-thinking toggle): true asks
    // node-bot to think on this turn, false ends Mana's own deep thinking
    // (Q12b), null sends nothing.
    // #963/#911: source is "voice" (a spoken turn, which may run desktop
    // actions mid-game) or "typed" (gets the longer mid-game wiki wait).
    // Null sends nothing.
    // #1325: documents is a list of local file paths for document attachments (PDF, DOCX, XLSX, PPTX, CSV, TXT, MD).
    public async IAsyncEnumerable<ReplyStreamEvent> ReplyStreamAsync(string text, string? sessionId = null, string screenText = "", string? image = null, IReadOnlyList<string>? images = null, string? presetId = null, bool? thinkHarder = null, string? source = null, IReadOnlyList<string>? documents = null)
    {
        var fields = new Dictionary<string, object?> { ["text"] = text, ["screenText"] = screenText };
        if (sessionId is not null)
        {
            fields["sessionId"] = sessionId;
        }
        if (!string.IsNullOrEmpty(presetId))
        {
            fields["presetId"] = presetId;
        }
        if (thinkHarder is bool think)
        {
            fields["thinkHarder"] = think;
        }
        if (source is not null)
        {
            fields["source"] = source;
        }
        if (documents is { Count: > 0 })
        {
            fields["documents"] = documents;
        }
        if (images is { Count: > 0 })
        {
            fields["images"] = images;
        }
        else if (image is not null)
        {
            fields["image"] = image;
        }
        var payload = JsonSerializer.Serialize(fields);
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

    // #522: OCR fallback for screen context when the UI Automation tree
    // (ScreenContextReader) isn't usable. imageDataUrl is a full
    // "data:image/jpeg;base64,..." string, matching what node-bot's
    // /screen/read already expects from windows-launcher.
    public async Task<string> ReadScreenAsync(string imageDataUrl)
    {
        var payload = JsonSerializer.Serialize(new { image = imageDataUrl });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/screen/read", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("text", out var textElement) ? textElement.GetString() ?? "" : "";
    }

    // #681: POST /internal/idle-report -- same {idleSeconds} body
    // windows-launcher sends; node-bot decides whether that's idle enough.
    // #661: true when this report started Dream Mode's idle consolidation
    // (node-bot's idleTriggered) -- the avatar shows Dreaming from then.
    public async Task<bool> ReportIdleAsync(int idleSeconds)
    {
        var payload = JsonSerializer.Serialize(new { idleSeconds });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/internal/idle-report", content);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.ValueKind == JsonValueKind.Object
            && document.RootElement.TryGetProperty("idleTriggered", out var triggered)
            && triggered.ValueKind == JsonValueKind.True;
    }

    // #680: one text action (Explain, Rewrite...) on selected text --
    // node-bot's OpenAI-compatible /v1/chat/completions, which goes straight
    // to the local model with no persona, session or memory, so the text
    // isn't remembered. Returns the model's reply, trimmed.
    public async Task<string> RunTextActionAsync(string prompt, string text)
    {
        var payload = JsonSerializer.Serialize(new
        {
            messages = new[]
            {
                new { role = "system", content = prompt },
                new { role = "user", content = text },
            },
            stream = false,
        });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/v1/chat/completions", content);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var reply = document.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "";
        // Reasoning models may prefix their answer with a <think> block.
        return System.Text.RegularExpressions.Regex.Replace(reply, @"^\s*<think>[\s\S]*?</think>", "").Trim();
    }

    // #697: what happened to a proactive toast, "engaged" or "dismissed". The
    // backend scores its last remark; kind/id ride along for the log.
    public async Task ReportProactiveReactionAsync(string reaction, string? kind, string? id)
    {
        var payload = JsonSerializer.Serialize(new { reaction, kind, id });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/proactive/settings", content);
        response.EnsureSuccessStatusCode();
    }

    // #697 part 1: which app just came to the front (ForegroundWindowReporter).
    public async Task ReportForegroundAsync(string app, string title)
    {
        var payload = JsonSerializer.Serialize(new { app, title });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/internal/foreground-report", content);
        response.EnsureSuccessStatusCode();
    }

    // #690: POST /screen-sensing/glance (plugins/screen-sensing) -- either
    // the foreground window's text ({text, gamingModeActive}, preferred) or
    // a screenshot ({image, gamingModeActive}, the body windows-launcher
    // sends). Returns the summary when the backend's attention gate says
    // it's worth surfacing, else null.
    public async Task<string?> ScreenSensingGlanceAsync(string? text, string? image, bool gamingModeActive)
    {
        var payload = text is not null
            ? JsonSerializer.Serialize(new { text, gamingModeActive })
            : JsonSerializer.Serialize(new { image, gamingModeActive });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/screen-sensing/glance", content);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        return root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("shouldSurface", out var surface) && surface.ValueKind == JsonValueKind.True
            && root.TryGetProperty("summary", out var summary) && summary.ValueKind == JsonValueKind.String
                ? summary.GetString()
                : null;
    }

    // #527: node-bot's configured llama-server profiles -- see
    // model-management.js's getModelStatus/buildProfileStatus for the
    // full shape; this only carries what compare-mode needs.
    // #572: brain/vision were added to the parsed shape here -- apiKey is
    // never echoed by node-bot (model-management.js's own comment: "same
    // reasoning as auth-store.js never returning a stored keyHash"), only
    // whether one is configured.
    public async Task<ManaModelStatus> GetModelStatusAsync()
    {
        using var response = await http.GetAsync("/models/status");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        var activeProfile = root.TryGetProperty("activeProfile", out var activeElement) ? activeElement.GetString() : null;

        var profiles = new Dictionary<string, ManaModelProfile>();
        if (root.TryGetProperty("profiles", out var profilesElement))
        {
            foreach (var property in profilesElement.EnumerateObject())
            {
                var value = property.Value;
                profiles[property.Name] = new ManaModelProfile
                {
                    Key = property.Name,
                    Label = value.TryGetProperty("label", out var labelElement) ? labelElement.GetString() : null,
                    SelectedModel = value.TryGetProperty("selectedModel", out var modelElement) ? modelElement.GetString() : null,
                    Available = value.TryGetProperty("available", out var availableElement) && availableElement.GetBoolean(),
                };
            }
        }

        var brain = root.TryGetProperty("brain", out var brainEl) ? brainEl : default;
        var fallback = root.TryGetProperty("fallback", out var fallbackEl) ? fallbackEl : default;
        var vision = root.TryGetProperty("vision", out var visionEl) ? visionEl : default;
        var recommendation = root.TryGetProperty("recommendation", out var recommendationEl) ? recommendationEl : default;

        return new ManaModelStatus
        {
            ActiveProfile = activeProfile,
            LocalOnly = root.TryGetProperty("localOnly", out var localOnlyEl) && localOnlyEl.ValueKind == JsonValueKind.True,
            Fallback = fallback.ValueKind == JsonValueKind.Object ? JsonSerializer.Deserialize<ManaCloudFallback>(fallback.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new() : new(),
            Profiles = profiles,
            SelectedModelPath = root.TryGetProperty("selectedModelPath", out var selectedEl) ? selectedEl.GetString() : null,
            BrainType = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("type", out var typeEl) ? typeEl.GetString() ?? "local" : "local",
            BrainBaseUrl = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("baseUrl", out var baseUrlEl) ? baseUrlEl.GetString() ?? "" : "",
            BrainModel = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("model", out var brainModelEl) ? brainModelEl.GetString() ?? "" : "",
            BrainHasApiKey = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("hasApiKey", out var hasKeyEl) && hasKeyEl.GetBoolean(),
            VisionModelPath = vision.ValueKind == JsonValueKind.Object && vision.TryGetProperty("modelPath", out var visionModelEl) ? visionModelEl.GetString() ?? "" : "",
            VisionMmprojPath = vision.ValueKind == JsonValueKind.Object && vision.TryGetProperty("mmprojPath", out var mmprojEl) ? mmprojEl.GetString() ?? "" : "",
            RecommendedProfile = recommendation.ValueKind == JsonValueKind.Object && recommendation.TryGetProperty("profile", out var recProfileEl) ? recProfileEl.GetString() : null,
            LoadIntoVram = root.TryGetProperty("loadIntoVram", out var loadIntoVramEl) && loadIntoVramEl.ValueKind == JsonValueKind.True,
        };
    }

    public async Task<ManaChatModels> GetChatModelsAsync(string? sessionId)
    {
        using var response = await http.GetAsync("/models/chat?sessionId=" + Uri.EscapeDataString(sessionId ?? ""));
        response.EnsureSuccessStatusCode();
        return JsonSerializer.Deserialize<ManaChatModels>(await response.Content.ReadAsStringAsync(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
    }

    public async Task SetChatModelAsync(string sessionId, string model)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { sessionId, model }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/chat", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task SetCloudFallbackAsync(bool enabled, int timeoutSeconds, string baseUrl, string? apiKey, string model)
    {
        var fields = new Dictionary<string, object> { ["enabled"] = enabled, ["timeoutSeconds"] = timeoutSeconds, ["baseUrl"] = baseUrl, ["model"] = model };
        if (apiKey is not null) fields["apiKey"] = apiKey;
        using var content = new StringContent(JsonSerializer.Serialize(fields), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/cloud-fallback", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task SetActiveProfileAsync(string profile)
    {
        var payload = JsonSerializer.Serialize(new { profile });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/active-profile", content);
        response.EnsureSuccessStatusCode();
    }

    // #572: roots lets a caller scope the scan (e.g. one chosen drive)
    // instead of model-management.js's own default (home dir + every
    // drive letter) -- null/omitted uses that default.
    public async Task<ManaGgufScanResult> ScanForModelsAsync(IReadOnlyList<string>? roots = null)
    {
        var payload = roots is null ? "{}" : JsonSerializer.Serialize(new { roots });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/scan", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var files = new List<ManaGgufFile>();
        if (root.TryGetProperty("found", out var foundElement))
        {
            foreach (var entry in foundElement.EnumerateArray())
            {
                files.Add(new ManaGgufFile
                {
                    Path = entry.TryGetProperty("path", out var pathEl) ? pathEl.GetString() ?? "" : "",
                    Name = entry.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
                    // #625: sizeBytes is null when node-bot couldn't stat the
                    // file -- GetInt64 on a JSON null would throw and fail
                    // the whole scan over one unreadable entry.
                    SizeBytes = entry.TryGetProperty("sizeBytes", out var sizeEl) && sizeEl.ValueKind == JsonValueKind.Number ? sizeEl.GetInt64() : 0,
                    Fit = entry.TryGetProperty("fit", out var fitEl) && fitEl.ValueKind == JsonValueKind.String ? fitEl.GetString() : null,
                });
            }
        }
        return new ManaGgufScanResult
        {
            Files = files,
            Truncated = root.TryGetProperty("truncated", out var truncatedEl) && truncatedEl.GetBoolean(),
        };
    }

    // #572: modelPath: null/"" clears the override back to auto-detection
    // (model-management.js's own setModelPath), matching every other
    // clear-by-empty-string convention this route family already uses.
    public async Task SetModelPathAsync(string? modelPath)
    {
        var payload = JsonSerializer.Serialize(new { modelPath });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/path", content);
        response.EnsureSuccessStatusCode();
    }

    // #572: apiKey is write-only -- passing null leaves the currently
    // configured key untouched (setBrainSettings only overwrites a field
    // when the corresponding partial key is actually present), so a
    // caller updating just the baseUrl/model doesn't need to re-enter it.
    public async Task SetBrainSettingsAsync(string type, string? baseUrl, string? apiKey, string? model)
    {
        var payload = JsonSerializer.Serialize(new { type, baseUrl, apiKey, model });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/brain-provider", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task<IReadOnlyList<ManaBrainProviderPreset>> GetBrainProvidersAsync()
    {
        using var response = await http.GetAsync("/models/brain-providers");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var presets = new List<ManaBrainProviderPreset>();
        foreach (var entry in document.RootElement.EnumerateArray())
        {
            presets.Add(new ManaBrainProviderPreset
            {
                Id = entry.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
                Label = entry.TryGetProperty("label", out var labelEl) ? labelEl.GetString() ?? "" : "",
                BaseUrl = entry.TryGetProperty("baseUrl", out var baseUrlEl) ? baseUrlEl.GetString() ?? "" : "",
                NeedsKey = entry.TryGetProperty("needsKey", out var needsKeyEl) && needsKeyEl.GetBoolean(),
            });
        }
        return presets;
    }

    // #572: this is the one /models/* route node-bot restricts to local
    // requests only (SSRF guard -- see server-routes.js's own comment on
    // this route), so a non-local backend URL configured in the Connection
    // tab will make this 403. That's expected, not a bug in this client.
    public async Task<(bool Ok, string? Error)> TestBrainConnectionAsync(string baseUrl, string? apiKey)
    {
        var payload = JsonSerializer.Serialize(new { baseUrl, apiKey });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/brain-provider/test", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        return (root.TryGetProperty("ok", out var okEl) && okEl.GetBoolean(), root.TryGetProperty("error", out var errorEl) ? errorEl.GetString() : null);
    }

    // #572: "" clears either field back to auto-detection, matching
    // setVisionSettings's own convention.
    public async Task SetVisionSettingsAsync(string? modelPath, string? mmprojPath)
    {
        var payload = JsonSerializer.Serialize(new { modelPath, mmprojPath });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/vision-path", content);
        response.EnsureSuccessStatusCode();
    }

    // Saved backend-side; llama-server picks it up on its next start.
    public async Task SetLoadIntoVramAsync(bool loadIntoVram)
    {
        var payload = JsonSerializer.Serialize(new { loadIntoVram });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/models/load-into-vram", content);
        response.EnsureSuccessStatusCode();
    }

    // #693: llama.cpp build updates (node-bot's llama-builds.js).
    public async Task<ManaLlamaBuildStatus> GetLlamaBuildStatusAsync()
    {
        using var response = await http.GetAsync("/models/llama-build");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        static string? Str(JsonElement parent, string name) =>
            parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;
        var current = root.TryGetProperty("current", out var currentEl) ? currentEl : default;
        var job = root.TryGetProperty("job", out var jobEl) ? jobEl : default;
        var lastRollback = root.TryGetProperty("lastRollback", out var rollbackEl) ? rollbackEl : default;
        return new ManaLlamaBuildStatus
        {
            CurrentBuild = current.ValueKind == JsonValueKind.Object && current.TryGetProperty("build", out var buildEl) && buildEl.ValueKind == JsonValueKind.Number ? buildEl.GetInt32() : null,
            CurrentVariant = Str(current, "variant"),
            CurrentError = Str(root, "currentError"),
            Previous = Str(root, "previous"),
            LastRollbackFrom = Str(lastRollback, "from"),
            LastRollbackReason = Str(lastRollback, "reason"),
            JobState = Str(job, "state"),
            JobTag = Str(job, "tag"),
            JobStep = Str(job, "step"),
            JobError = Str(job, "error"),
        };
    }

    // The three actions below don't call EnsureSuccessStatusCode: a 4xx
    // comes back as a parseable {error, code} body the Model tab shows,
    // and code "digest_missing" is what triggers its confirm prompt.
    public async Task<ManaLlamaBuildCheck> CheckLlamaBuildUpdateAsync()
    {
        var (ok, root) = await PostLlamaBuildAsync("/models/llama-build/check", new { });
        if (!ok)
        {
            return new ManaLlamaBuildCheck { Error = LlamaBuildError(root) };
        }
        var latest = root.TryGetProperty("latest", out var latestEl) ? latestEl : default;
        return new ManaLlamaBuildCheck
        {
            LatestTag = latest.ValueKind == JsonValueKind.Object && latest.TryGetProperty("tag", out var tagEl) ? tagEl.GetString() : null,
            DigestAvailable = latest.ValueKind == JsonValueKind.Object && latest.TryGetProperty("digestAvailable", out var digestEl) && digestEl.ValueKind == JsonValueKind.True,
            UpdateAvailable = root.TryGetProperty("updateAvailable", out var updateEl) && updateEl.ValueKind == JsonValueKind.True,
        };
    }

    public async Task<ManaLlamaBuildActionResult> StartLlamaBuildUpdateAsync(bool allowMissingDigest)
    {
        var (ok, root) = await PostLlamaBuildAsync("/models/llama-build/update", new { allowMissingDigest });
        return LlamaBuildActionResult(ok, root);
    }

    public async Task<ManaLlamaBuildActionResult> RollBackLlamaBuildAsync()
    {
        var (ok, root) = await PostLlamaBuildAsync("/models/llama-build/rollback", new { });
        return LlamaBuildActionResult(ok, root);
    }

    private async Task<(bool Ok, JsonElement Root)> PostLlamaBuildAsync(string path, object body)
    {
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync(path, content);
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return (response.IsSuccessStatusCode, document.RootElement.Clone());
    }

    private static string LlamaBuildError(JsonElement root) =>
        root.TryGetProperty("error", out var errorEl) ? errorEl.GetString() ?? "request failed" : "request failed";

    private static ManaLlamaBuildActionResult LlamaBuildActionResult(bool ok, JsonElement root) => ok
        ? new ManaLlamaBuildActionResult { Ok = true }
        : new ManaLlamaBuildActionResult
        {
            Error = LlamaBuildError(root),
            Code = root.TryGetProperty("code", out var codeEl) && codeEl.ValueKind == JsonValueKind.String ? codeEl.GetString() : null,
        };

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
                    Goal = element.TryGetProperty("goal", out var goalElement) ? goalElement.GetString() : null,
                    ProjectId = element.TryGetProperty("projectId", out var projectElement) ? projectElement.GetString() : null,
                    ProjectName = element.TryGetProperty("projectName", out var projectNameElement) ? projectNameElement.GetString() : null,
                    UpdatedAt = element.TryGetProperty("updatedAt", out var updatedElement) ? updatedElement.GetString() : null,
                    ForkedFrom = element.TryGetProperty("forkedFrom", out var forkedElement) ? forkedElement.GetString() : null,
                    BranchTurnIndex = element.TryGetProperty("branchTurnIndex", out var btElement) && btElement.ValueKind == JsonValueKind.Number ? btElement.GetInt32() : null,
                });
            }
        }
        return sessions;
    }

    public async Task<IReadOnlyList<ManaProject>> GetProjectsAsync()
    {
        using var response = await http.GetAsync("/projects");
        using var document = await ReadProjectResponseAsync(response);
        return JsonSerializer.Deserialize<List<ManaProject>>(document.RootElement.GetProperty("projects").GetRawText(), new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? new();
    }

    public async Task<ManaProject> SaveProjectAsync(string? id, string name, string instructions)
    {
        var payload = id is null ? (object)new { name, instructions } : new { id, name, instructions };
        using var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/projects", content);
        using var document = await ReadProjectResponseAsync(response);
        return JsonSerializer.Deserialize<ManaProject>(document.RootElement.GetRawText(), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    }

    public async Task DeleteProjectAsync(string id)
    {
        using var response = await http.DeleteAsync($"/projects/{Uri.EscapeDataString(id)}");
        using var document = await ReadProjectResponseAsync(response);
    }

    public async Task SetSessionProjectAsync(string sessionId, string? projectId)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { projectId }), Encoding.UTF8, "application/json");
        using var response = await http.PutAsync($"/sessions/{Uri.EscapeDataString(sessionId)}/project", content);
        using var document = await ReadProjectResponseAsync(response);
    }

    public async Task<ManaProject> LinkProjectReferenceAsync(string id, string path)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { path }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/projects/{Uri.EscapeDataString(id)}/references/picker", content);
        using var document = await ReadProjectResponseAsync(response);
        return JsonSerializer.Deserialize<ManaProject>(document.RootElement.GetRawText(), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    }

    public async Task<ManaProject> RemoveProjectReferenceAsync(string id, string referenceId)
    {
        using var response = await http.DeleteAsync($"/projects/{Uri.EscapeDataString(id)}/references/{Uri.EscapeDataString(referenceId)}");
        using var document = await ReadProjectResponseAsync(response);
        return JsonSerializer.Deserialize<ManaProject>(document.RootElement.GetRawText(), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    }

    private static async Task<JsonDocument> ReadProjectResponseAsync(HttpResponseMessage response)
    {
        var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (response.IsSuccessStatusCode) return document;
        var error = document.RootElement.TryGetProperty("error", out var message) ? message.GetString() : response.ReasonPhrase;
        document.Dispose();
        throw new InvalidOperationException(error ?? "Project request failed");
    }

    // #687 part 3: ids of the sessions whose stored messages contain every
    // word of query (GET /sessions?q=). Empty unless the backend echoes
    // `query` -- an older one ignores q and would list every session.
    public async Task<HashSet<string>> SearchSessionIdsAsync(string query)
    {
        using var response = await http.GetAsync($"/sessions?q={Uri.EscapeDataString(query)}");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var ids = new HashSet<string>();
        if (document.RootElement.TryGetProperty("query", out _)
            && document.RootElement.TryGetProperty("sessions", out var sessionsElement))
        {
            foreach (var element in sessionsElement.EnumerateArray())
            {
                if (element.TryGetProperty("sessionId", out var idElement) && idElement.GetString() is { } id)
                {
                    ids.Add(id);
                }
            }
        }
        return ids;
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

    // #586: goal is a separate optional field on the same PATCH endpoint
    // RenameSessionAsync already uses -- see sessions-capability.js's own
    // PATCH handler. An empty string clears the goal, same as name's own
    // empty-becomes-null behavior server-side.
    public async Task<bool> SetSessionGoalAsync(string sessionId, string goal)
    {
        var payload = JsonSerializer.Serialize(new { goal });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PatchAsync($"/sessions/{Uri.EscapeDataString(sessionId)}", content);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return false;
        }
        response.EnsureSuccessStatusCode();
        return true;
    }

    // #586: powers the "Open memory" modal -- node-bot's GET /sessions/:id
    // returns the full stored session (summary + every turn), so recent
    // turns are just the tail of that array taken client-side rather than
    // a second call to the separate paginated /turns endpoint, which
    // exists for ChatView-style scrollback this modal doesn't need.
    // Null return means the session has never had a real turn yet --
    // ensureSession only creates the row lazily on the first one (see
    // SessionListForm's own StartNewChat comment) -- not a transport
    // failure.
    public async Task<ManaSessionDetail?> GetSessionDetailAsync(string sessionId, int recentTurnLimit = 20)
    {
        using var response = await http.GetAsync($"/sessions/{Uri.EscapeDataString(sessionId)}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        var turns = new List<ManaSessionTurn>();
        if (root.TryGetProperty("turns", out var turnsElement) && turnsElement.ValueKind == JsonValueKind.Array)
        {
            var turnIndex = 0;
            foreach (var turnElement in turnsElement.EnumerateArray())
            {
                // #1337: a background task of this chat ended.
                if (StepStr(turnElement, "role") == "event")
                {
                    if (StepStr(turnElement, "kind") == "background_task" && StepStr(turnElement, "taskId") is { } taskId)
                    {
                        turns.Add(new ManaSessionTurn
                        {
                            TurnIndex = turnIndex++,
                            At = StepStr(turnElement, "at"),
                            Notice = new ManaTaskNotice(taskId, StepStr(turnElement, "title"), StepStr(turnElement, "status"), StepStr(turnElement, "text")),
                        });
                    }
                    continue;
                }
                var versionsList = new List<string>();
                if (turnElement.TryGetProperty("versions", out var versElement) && versElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var v in versElement.EnumerateArray())
                    {
                        if (v.TryGetProperty("assistant", out var aStr) && aStr.GetString() is { } str)
                        {
                            versionsList.Add(str);
                        }
                    }
                }
                var versionIndex = turnElement.TryGetProperty("versionIndex", out var viElement) && viElement.ValueKind == JsonValueKind.Number
                    ? viElement.GetInt32()
                    : 0;

                turns.Add(new ManaSessionTurn
                {
                    TurnIndex = turnIndex++,
                    At = turnElement.TryGetProperty("at", out var atElement) ? atElement.GetString() : null,
                    User = turnElement.TryGetProperty("user", out var userElement) ? userElement.GetString() : null,
                    Assistant = turnElement.TryGetProperty("assistant", out var assistantElement) ? assistantElement.GetString() : null,
                    Thought = turnElement.TryGetProperty("thought", out var thoughtElement) ? thoughtElement.GetString() : null,
                    AnswerModel = turnElement.TryGetProperty("answerModel", out var answerModelEl) ? answerModelEl.GetString() : null,
                    CloudFallback = turnElement.TryGetProperty("cloudFallback", out var fallbackEl) && fallbackEl.ValueKind == JsonValueKind.True,
                    Steps = ParseAgentSteps(turnElement), // #1337: absent on older turns
                    Versions = versionsList,
                    VersionIndex = versionIndex,
                });
            }
        }
        var recentTurns = turns.Count > recentTurnLimit ? turns.GetRange(turns.Count - recentTurnLimit, recentTurnLimit) : turns;

        return new ManaSessionDetail
        {
            Summary = root.TryGetProperty("summary", out var summaryElement) ? summaryElement.GetString() : null,
            Goal = root.TryGetProperty("goal", out var detailGoalElement) ? detailGoalElement.GetString() : null,
            RecentTurns = recentTurns,
            TotalTurnCount = turns.Count,
        };
    }

    // #1322: branch from an existing session up to an optional turnIndex
    public async Task<ManaSession?> ForkSessionAsync(string sessionId, int? turnIndex = null, string? name = null)
    {
        var body = new Dictionary<string, object?>();
        if (turnIndex.HasValue) body["turnIndex"] = turnIndex.Value;
        if (!string.IsNullOrWhiteSpace(name)) body["name"] = name;
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/sessions/{Uri.EscapeDataString(sessionId)}/fork", content);
        if (!response.IsSuccessStatusCode) return null;
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        var root = doc.RootElement;
        return new ManaSession
        {
            SessionId = root.TryGetProperty("sessionId", out var id) ? id.GetString() ?? "" : "",
            Name = root.TryGetProperty("name", out var n) ? n.GetString() : null,
            Goal = root.TryGetProperty("goal", out var g) ? g.GetString() : null,
            ForkedFrom = root.TryGetProperty("forkedFrom", out var f) ? f.GetString() : null,
            BranchTurnIndex = root.TryGetProperty("branchTurnIndex", out var bt) && bt.ValueKind == JsonValueKind.Number ? bt.GetInt32() : null,
            UpdatedAt = root.TryGetProperty("updatedAt", out var u) ? u.GetString() : null,
        };
    }

    // #1322: truncate session turns when editing a past turn or re-running from a point
    public async Task<bool> TruncateSessionTurnsAsync(string sessionId, int turnIndex)
    {
        var body = new Dictionary<string, object?> { ["turnIndex"] = turnIndex };
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/sessions/{Uri.EscapeDataString(sessionId)}/truncate", content);
        return response.IsSuccessStatusCode;
    }

    // #1322: step between assistant versions for a turn
    public async Task<bool> SetTurnVersionAsync(string sessionId, int turnIndex, int versionIndex)
    {
        var body = new Dictionary<string, object?> { ["versionIndex"] = versionIndex };
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await http.PatchAsync($"/sessions/{Uri.EscapeDataString(sessionId)}/turns/{turnIndex}/version", content);
        return response.IsSuccessStatusCode;
    }

    // #1142: a saved chat's artifacts from turns saved before `before`,
    // without their content (node-bot/artifact-history.js). Empty when the
    // chat isn't stored.
    public async Task<IReadOnlyList<ManaSavedArtifact>> GetSessionArtifactsAsync(string sessionId, DateTime before)
    {
        var since = Uri.EscapeDataString(before.ToUniversalTime().ToString("o"));
        using var response = await http.GetAsync($"/sessions/{Uri.EscapeDataString(sessionId)}/artifacts?before={since}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return Array.Empty<ManaSavedArtifact>();
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        var list = await JsonSerializer.DeserializeAsync<ManaSavedArtifactList>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        return list?.Artifacts ?? new List<ManaSavedArtifact>();
    }

    // #1142: one saved artifact's content; null when it's gone.
    public async Task<string?> GetSessionArtifactContentAsync(string sessionId, int turn)
    {
        using var response = await http.GetAsync($"/sessions/{Uri.EscapeDataString(sessionId)}/artifacts/{turn}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("content", out var content) ? content.GetString() : null;
    }

    // #642: the context meter -- GET /prompt-composition/:sessionId (see
    // node-bot/prompt-composition-report.js). Null on 404: nothing has been
    // assembled for this session yet. A block's Tokens is the tokenizer's
    // count when the backend has it, else its char/4 estimate; CountedWith
    // stays null until the backend's end-of-turn count lands.
    public async Task<ManaPromptComposition?> GetPromptCompositionAsync(string sessionId)
    {
        using var response = await http.GetAsync($"/prompt-composition/{Uri.EscapeDataString(sessionId)}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        static long? Long(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt64() : null;

        var blocks = new List<ManaPromptBlock>();
        if (root.TryGetProperty("blocks", out var blocksElement) && blocksElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in blocksElement.EnumerateArray())
            {
                blocks.Add(new ManaPromptBlock
                {
                    Name = block.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                    Tokens = Long(block, "tokens") ?? Long(block, "estTokens") ?? 0,
                });
            }
        }

        return new ManaPromptComposition
        {
            Blocks = blocks,
            CountedWith = root.TryGetProperty("countedWith", out var countedWith) ? countedWith.GetString() : null,
            TotalTokens = Long(root, "totalTokens"),
            PromptTokens = Long(root, "promptTokens"),
            UnattributedTokens = Long(root, "unattributedTokens"),
            ContextSize = Long(root, "contextSize"),
            PercentUsed = root.TryGetProperty("percentUsed", out var percent) && percent.ValueKind == JsonValueKind.Number ? percent.GetDouble() : null,
        };
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

    // #153: Raw ShareGPT-style JSONL text.
    // #1323: or readable Markdown (?format=markdown), with optional tool calls and reasoning.
    public async Task<string> ExportSessionAsync(string sessionId, string format = "jsonl", bool includeTools = false, bool includeThoughts = false)
    {
        var url = $"/sessions/{Uri.EscapeDataString(sessionId)}/export?format={Uri.EscapeDataString(format)}";
        if (includeTools)
        {
            url += "&tools=1";
        }
        if (includeThoughts)
        {
            url += "&thoughts=1";
        }
        using var response = await http.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    // #1336: Export everything as one zip file with a readme.
    public async Task<byte[]> ExportAllDataAsync(CancellationToken cancellationToken = default)
    {
        using var response = await http.GetAsync("/privacy/export-all", cancellationToken);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsByteArrayAsync(cancellationToken);
    }

    // #1336: Delete all data (typed confirmation "delete-everything").
    public async Task<bool> DeleteAllDataAsync(string confirmation, CancellationToken cancellationToken = default)
    {
        var json = JsonSerializer.Serialize(new { confirmation });
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/privacy/delete-all", content, cancellationToken);
        return response.IsSuccessStatusCode;
    }

    // #1336: Per-category delete (e.g. "voice", "chats", "memory", "vault", "cache-logs").
    public async Task<bool> DeleteDataCategoryAsync(string category, string confirmation, CancellationToken cancellationToken = default)
    {
        var json = JsonSerializer.Serialize(new { confirmation });
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/privacy/delete/{Uri.EscapeDataString(category)}", content, cancellationToken);
        return response.IsSuccessStatusCode;
    }

    // #529: GET /plugins groups capabilities by category -- this
    // flattens that into one list, which is all the settings panel
    // needs (the grouping is a display nicety this lean version skips).
    public async Task<IReadOnlyList<ManaPlugin>> GetPluginsAsync()
    {
        using var response = await http.GetAsync("/plugins");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var plugins = new List<ManaPlugin>();
        if (document.RootElement.TryGetProperty("plugins", out var pluginsElement))
        {
            foreach (var category in pluginsElement.EnumerateObject())
            {
                foreach (var entry in category.Value.EnumerateArray())
                {
                    plugins.Add(new ManaPlugin
                    {
                        Key = entry.TryGetProperty("key", out var keyEl) ? keyEl.GetString() ?? "" : "",
                        Name = entry.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
                        Description = entry.TryGetProperty("description", out var descEl) ? descEl.GetString() : null,
                        Enabled = entry.TryGetProperty("enabled", out var enabledEl) && enabledEl.GetBoolean(),
                    });
                }
            }
        }
        return plugins;
    }

    public async Task SetPluginEnabledAsync(string key, bool enabled)
    {
        var payload = JsonSerializer.Serialize(new { enabled });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/plugins/{Uri.EscapeDataString(key)}/enabled", content);
        response.EnsureSuccessStatusCode();
    }

    // #529/#565: requires an admin bearer token when node-bot has
    // MANA_ADMIN_SECRET configured; unset (the common case), checkAdminAuth
    // takes this launcher's per-run key instead (#842). The Connection settings tab
    // (#565) is where a token gets entered when one IS configured; a
    // wrong/missing token still surfaces as a 401 EnsureSuccessStatusCode
    // throws, same as any other unexpected status this client doesn't
    // special-case.
    public async Task<IReadOnlyList<ManaMemoryFact>> GetMemoryFactsAsync()
    {
        using var response = await http.GetAsync("/admin/memory/facts");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var facts = new List<ManaMemoryFact>();
        if (document.RootElement.TryGetProperty("facts", out var factsElement))
        {
            foreach (var entry in factsElement.EnumerateArray())
            {
                facts.Add(new ManaMemoryFact
                {
                    Key = entry.TryGetProperty("key", out var keyEl) ? keyEl.GetString() ?? "" : "",
                    Text = entry.TryGetProperty("text", out var textEl) ? textEl.GetString() ?? "" : "",
                    Status = entry.TryGetProperty("status", out var statusEl) ? statusEl.GetString() ?? "" : "",
                    Pinned = entry.TryGetProperty("pinned", out var pinnedEl) && pinnedEl.ValueKind == JsonValueKind.True,
                    Trust = entry.TryGetProperty("trust", out var trustEl) ? trustEl.GetString() ?? "" : "",
                    Trigger = entry.TryGetProperty("trigger", out var triggerEl) ? triggerEl.GetString() ?? "" : "",
                    Paused = entry.TryGetProperty("paused", out var pausedEl) && pausedEl.ValueKind == JsonValueKind.True,
                });
            }
        }
        return facts;
    }

    public async Task ArchiveMemoryFactAsync(string key)
    {
        using var response = await http.PostAsync($"/admin/memory/facts/{Uri.EscapeDataString(key)}/archive", null);
        response.EnsureSuccessStatusCode();
    }

    // #1331: Settings' "+ Add" -- a fact (or, with a trigger, a standing
    // reminder) in the user's own words.
    public async Task CreateMemoryFactAsync(string key, string text, string? trigger = null)
    {
        var payload = JsonSerializer.Serialize(string.IsNullOrWhiteSpace(trigger) ? (object)new { key, text } : new { key, text, trigger });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/admin/memory/facts", content);
        response.EnsureSuccessStatusCode();
    }

    // #1331: really removes the fact (not an archive); its vault note goes too.
    public async Task DeleteMemoryFactAsync(string key)
    {
        using var response = await http.DeleteAsync($"/admin/memory/facts/{Uri.EscapeDataString(key)}");
        response.EnsureSuccessStatusCode();
    }

    // #663: makes a pending (auto-picked-up) fact active.
    public async Task ConfirmMemoryFactAsync(string key)
    {
        using var response = await http.PostAsync($"/admin/memory/facts/{Uri.EscapeDataString(key)}/confirm", null);
        response.EnsureSuccessStatusCode();
    }

    // #674: a pinned fact is injected into every reply's prompt.
    public async Task SetMemoryFactPinnedAsync(string key, bool pinned)
    {
        var payload = JsonSerializer.Serialize(new { pinned });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/admin/memory/facts/{Uri.EscapeDataString(key)}/pin", content);
        response.EnsureSuccessStatusCode();
    }

    // Q29 (#698): Settings' Edit -- the fact's text, and a standing intent's
    // trigger (null leaves it). node-bot records the old value in history.
    public async Task UpdateMemoryFactAsync(string key, string text, string? trigger = null)
    {
        var payload = JsonSerializer.Serialize(trigger is null ? (object)new { text } : new { text, trigger });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"/admin/memory/facts/{Uri.EscapeDataString(key)}") { Content = content };
        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    // #698: a paused standing intent never fires.
    public async Task SetMemoryFactPausedAsync(string key, bool paused)
    {
        var payload = JsonSerializer.Serialize(new { paused });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/admin/memory/facts/{Uri.EscapeDataString(key)}/pause", content);
        response.EnsureSuccessStatusCode();
    }

    // #935: the Obsidian vault sync's status; VaultDir is null when it's off.
    public async Task<ManaVaultStatus> GetMemoryVaultStatusAsync()
    {
        using var response = await http.GetAsync("/admin/memory/vault");
        return await ReadVaultStatusAsync(response);
    }

    // #935: "Sync now" -- syncs at once and returns the new status.
    public async Task<ManaVaultStatus> SyncMemoryVaultAsync()
    {
        using var response = await http.PostAsync("/admin/memory/vault/sync", null);
        return await ReadVaultStatusAsync(response);
    }

    private static async Task<ManaVaultStatus> ReadVaultStatusAsync(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync<ManaVaultStatus>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaVaultStatus();
    }

    // #529: index-only listing (GET /skills), not full skill bodies --
    // matches skills-capability.js's own "cheap call" framing. Editing a
    // skill's full content is a much bigger form than a lean settings
    // panel warrants; this supports viewing and deleting only.
    public async Task<IReadOnlyList<ManaSkill>> GetSkillsAsync()
    {
        using var response = await http.GetAsync("/skills");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var skills = new List<ManaSkill>();
        if (document.RootElement.TryGetProperty("skills", out var skillsElement))
        {
            foreach (var entry in skillsElement.EnumerateArray())
            {
                skills.Add(new ManaSkill
                {
                    Name = entry.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
                    Description = entry.TryGetProperty("description", out var descEl) ? descEl.GetString() : null,
                    Status = entry.TryGetProperty("status", out var statusEl) ? statusEl.GetString() : null,
                });
            }
        }
        return skills;
    }

    // #664: queue a SKILL.md folder, or a .zip of one (Q21), for import.
    // node-bot reads it now and always asks in Approvals before writing
    // anything. Returns null when queued, else node-bot's error (no
    // SKILL.md, not local, ...).
    // An http(s) link goes as {url}: node-bot downloads it from an allowed
    // site (github.com, codeload.github.com, clawhub.ai) and checks it first.
    public async Task<string?> ImportSkillAsync(string path)
    {
        var isLink = path.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || path.StartsWith("http://", StringComparison.OrdinalIgnoreCase);
        var payload = isLink ? JsonSerializer.Serialize(new { url = path }) : JsonSerializer.Serialize(new { path });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/skills/import", content);
        if (response.IsSuccessStatusCode)
        {
            return null;
        }
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("error", out var errorEl) ? errorEl.GetString() ?? "import failed" : "import failed";
    }

    // Q20: "free", "each" or "first" -- how Mana may use imported skills.
    public async Task<string> GetImportedSkillUseAsync()
    {
        using var response = await http.GetAsync("/skill-settings");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("importedSkillUse", out var modeEl) ? modeEl.GetString() ?? "first" : "first";
    }

    public async Task SetImportedSkillUseAsync(string mode)
    {
        var payload = JsonSerializer.Serialize(new { importedSkillUse = mode });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PutAsync("/skill-settings", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task DeleteSkillAsync(string name)
    {
        using var response = await http.DeleteAsync($"/skills/{Uri.EscapeDataString(name)}");
        response.EnsureSuccessStatusCode();
    }

    // #583: null override means "no manual override -- automatic gaming-
    // based provider switching applies" (server.js's TTS_OVERRIDE_PROVIDERS
    // gate: provider must be one of "fish"/"kokoro"/"gpt_sovits"/"cli", or
    // null to clear).
    public async Task<string?> GetTtsOverrideAsync()
    {
        using var response = await http.GetAsync("/tts/override");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("override", out var overrideEl) ? overrideEl.GetString() : null;
    }

    // Part of #700: her mood in words ("tired, chatty") and the emotion tag
    // it leans toward (null: none). The numbers stay in node-bot.
    public async Task<(string Summary, string? Emotion)> GetMoodAsync()
    {
        using var response = await http.GetAsync("/mood");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        return (root.GetProperty("summary").GetString() ?? "okay",
            root.TryGetProperty("emotion", out var emotion) && emotion.ValueKind == JsonValueKind.String ? emotion.GetString() : null);
    }

    // #914: node-bot's characters (id, name), the active one's id, and
    // whether group mode is on.
    public async Task<(string Active, IReadOnlyList<(string Id, string Name)> Characters, bool GroupOn)> GetCharactersAsync()
    {
        using var response = await http.GetAsync("/characters");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var characters = root.GetProperty("characters").EnumerateArray()
            .Select(c => (c.GetProperty("id").GetString() ?? "", c.GetProperty("name").GetString() ?? ""))
            .ToList();
        var groupOn = root.TryGetProperty("group", out var group) && group.ValueKind == JsonValueKind.Object
            && group.TryGetProperty("on", out var on) && on.ValueKind == JsonValueKind.True;
        return (root.GetProperty("active").GetString() ?? "", characters, groupOn);
    }

    // #914: each character's relationship notes and milestones, for
    // Settings > Characters.
    public async Task<IReadOnlyList<ManaCharacterRelationship>> GetRelationshipsAsync()
    {
        using var response = await http.GetAsync("/characters/relationships");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        static IReadOnlyList<ManaRelationshipItem> Items(JsonElement character, string name, string kind) =>
            character.TryGetProperty(name, out var items) && items.ValueKind == JsonValueKind.Array
                ? items.EnumerateArray().Select(i => new ManaRelationshipItem(
                    kind,
                    i.GetProperty("id").GetString() ?? "",
                    i.GetProperty("text").GetString() ?? "",
                    i.TryGetProperty("date", out var date) && date.ValueKind == JsonValueKind.String ? date.GetString() : null)).ToList()
                : [];
        return document.RootElement.GetProperty("characters").EnumerateArray()
            .Select(c => new ManaCharacterRelationship(
                c.GetProperty("id").GetString() ?? "",
                c.GetProperty("name").GetString() ?? "",
                Items(c, "notes", "notes"),
                Items(c, "milestones", "milestones")))
            .ToList();
    }

    // #914: edits one note or milestone (kind "notes"/"milestones"); a
    // milestone's date (YYYY-MM-DD) too.
    public async Task UpdateRelationshipItemAsync(string characterId, string kind, string itemId, string text, string? date = null)
    {
        var payload = date is null ? JsonSerializer.Serialize(new { text }) : JsonSerializer.Serialize(new { text, date });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PutAsync(RelationshipItemPath(characterId, kind, itemId), content);
        response.EnsureSuccessStatusCode();
    }

    public async Task RemoveRelationshipItemAsync(string characterId, string kind, string itemId)
    {
        using var response = await http.DeleteAsync(RelationshipItemPath(characterId, kind, itemId));
        response.EnsureSuccessStatusCode();
    }

    private static string RelationshipItemPath(string characterId, string kind, string itemId) =>
        $"/characters/{Uri.EscapeDataString(characterId)}/relationship/{(kind == "milestones" ? "milestones" : "notes")}/{Uri.EscapeDataString(itemId)}";

    // #914: group mode on (with the last partner, else the first other
    // character) or off.
    public async Task SetGroupAsync(bool on)
    {
        var payload = JsonSerializer.Serialize(new { on });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/characters/group", content);
        response.EnsureSuccessStatusCode();
    }

    // #914: switches character; her handoff line, or null if she already was.
    public async Task<string?> SetCharacterAsync(string id)
    {
        var payload = JsonSerializer.Serialize(new { id });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/characters/active", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("handoff", out var handoff) && handoff.ValueKind == JsonValueKind.String
            ? handoff.GetString()
            : null;
    }

    public async Task SetTtsOverrideAsync(string? provider)
    {
        var payload = JsonSerializer.Serialize(new { provider });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/tts/override", content);
        response.EnsureSuccessStatusCode();
    }

    // #923/#925/#926: my speech words, mishearing fixes and whisper language
    // (node-bot's GET/POST /speech).
    public async Task<ManaSpeechVocabulary> GetSpeechAsync()
    {
        using var response = await http.GetAsync("/speech");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync<ManaSpeechVocabulary>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaSpeechVocabulary();
    }

    // change: one POST /speech body -- new { addWord }, { removeWord },
    // { heard, term, confirm }, { removeCorrection } or { language }. A
    // refused change throws with node-bot's error; StatusCode Conflict means
    // heard may be an ordinary word and needs confirm = true.
    public async Task<ManaSpeechVocabulary> UpdateSpeechAsync(object change)
    {
        using var content = new StringContent(JsonSerializer.Serialize(change), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/speech", content);
        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            string? error = null;
            try
            {
                using var document = JsonDocument.Parse(body);
                error = document.RootElement.TryGetProperty("error", out var errorElement) ? errorElement.GetString() : null;
            }
            catch (JsonException)
            {
            }
            throw new HttpRequestException(error ?? $"HTTP {(int)response.StatusCode}", null, response.StatusCode);
        }
        return JsonSerializer.Deserialize<ManaSpeechVocabulary>(body, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaSpeechVocabulary();
    }

    // #950 (#906): Settings > Calendar & Email, node-bot's /mail-calendar.
    // Passwords and feed URLs go in and never come back out.
    public async Task<ManaMailCalendar> GetMailCalendarAsync()
    {
        using var response = await http.GetAsync("/mail-calendar");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync<ManaMailCalendar>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaMailCalendar();
    }

    // change: new { kind = "email", host, port, user, password, mailbox },
    // new { kind = "calendar", url, user, password }, or new { kind, clear =
    // true }. A null or blank password/url keeps the saved one. A refused
    // change throws with node-bot's error.
    public async Task<ManaMailCalendar> UpdateMailCalendarAsync(object change)
    {
        using var content = new StringContent(JsonSerializer.Serialize(change), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/mail-calendar", content);
        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            string? error = null;
            try
            {
                using var document = JsonDocument.Parse(body);
                error = document.RootElement.TryGetProperty("error", out var errorElement) ? errorElement.GetString() : null;
            }
            catch (JsonException)
            {
            }
            throw new HttpRequestException(error ?? $"HTTP {(int)response.StatusCode}", null, response.StatusCode);
        }
        return JsonSerializer.Deserialize<ManaMailCalendar>(body, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaMailCalendar();
    }

    // Logs in to the saved "email" or "calendar" account.
    public async Task<(bool Ok, string? Error)> TestMailCalendarAsync(string kind)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { kind }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/mail-calendar/test", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        return (root.TryGetProperty("ok", out var okEl) && okEl.GetBoolean(), root.TryGetProperty("error", out var errorEl) ? errorEl.GetString() : null);
    }

    // #907: the daily briefing's settings (node-bot's GET/POST /briefing).
    public async Task<ManaBriefingSettings> GetBriefingAsync()
    {
        using var response = await http.GetAsync("/briefing");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync<ManaBriefingSettings>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaBriefingSettings();
    }

    // A refused change (a bad time) throws with node-bot's error.
    public async Task<ManaBriefingSettings> UpdateBriefingAsync(ManaBriefingSettings settings)
    {
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        using var content = new StringContent(JsonSerializer.Serialize(settings, web), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/briefing", content);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(document.RootElement.TryGetProperty("error", out var error) ? error.GetString() : $"HTTP {(int)response.StatusCode}");
        }
        return document.RootElement.Deserialize<ManaBriefingSettings>(web) ?? new ManaBriefingSettings();
    }

    // #699: Settings > Heartbeat -- heartbeat.md's checks.
    public async Task<IReadOnlyList<ManaHeartbeatItem>> GetHeartbeatItemsAsync()
    {
        using var response = await http.GetAsync("/heartbeat/items");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return (await JsonSerializer.DeserializeAsync<ManaHeartbeatItems>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web)))?.Items ?? new();
    }

    // Saves the whole list. A refused one (a bad schedule, say) throws with
    // node-bot's error and nothing is written.
    public async Task<IReadOnlyList<ManaHeartbeatItem>> SaveHeartbeatItemsAsync(IEnumerable<ManaHeartbeatItem> items)
    {
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        using var content = new StringContent(JsonSerializer.Serialize(new ManaHeartbeatItems { Items = items.ToList() }, web), Encoding.UTF8, "application/json");
        using var response = await http.PutAsync("/heartbeat/items", content);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(document.RootElement.TryGetProperty("error", out var error) ? error.GetString() : $"HTTP {(int)response.StatusCode}");
        }
        return document.RootElement.Deserialize<ManaHeartbeatItems>(web)?.Items ?? new();
    }

    // #581: touch=false matches the editor's own "opening to browse/edit
    // isn't the same as Mana actually reaching for it" contract
    // (skills-capability.js's own comment) -- without it, opening a skill
    // just to look at it would bump its lastUsed/un-stale it.
    public async Task<ManaSkillDetail> GetSkillDetailAsync(string name)
    {
        using var response = await http.GetAsync($"/skills/{Uri.EscapeDataString(name)}?touch=false");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        return new ManaSkillDetail
        {
            Name = root.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
            Description = root.TryGetProperty("description", out var descEl) ? descEl.GetString() ?? "" : "",
            Body = root.TryGetProperty("body", out var bodyEl) ? bodyEl.GetString() ?? "" : "",
            Category = root.TryGetProperty("category", out var categoryEl) ? categoryEl.GetString() : null,
        };
    }

    // #581: POST /skills is approval-gated (skills-capability.js: "a skill
    // write is agent-authored content... pauses for approval"), unlike
    // PATCH below -- a 201 means it was auto-approved and created
    // immediately, a 202 means it's queued and needs a decision from the
    // existing Approvals tab. The two response bodies differ in shape
    // (201's is the created skill itself; 202's is the full approval-gate
    // outcome), so this returns which case happened by status code rather
    // than trying to parse a "status" field that only one of them has.
    // #688: a 202 also carries the pending request's id and the content
    // scan's flags, so a clean one can be approved straight away.
    public async Task<ManaSkillCreateResult> CreateSkillAsync(string name, string description, string body, string? category)
    {
        var payload = JsonSerializer.Serialize(new { name, description, body, category });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/skills", content);
        response.EnsureSuccessStatusCode();
        if (response.StatusCode == System.Net.HttpStatusCode.Created)
        {
            return new ManaSkillCreateResult(true, null, Array.Empty<string>());
        }
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var id = root.TryGetProperty("requestId", out var idEl) ? idEl.GetString() : null;
        var flags = root.TryGetProperty("flags", out var flagsEl) && flagsEl.ValueKind == JsonValueKind.Array
            ? flagsEl.EnumerateArray().Select(f => f.ValueKind == JsonValueKind.String ? f.GetString()! : f.GetRawText()).ToList()
            : new List<string>();
        // Guardian judged it and didn't clear it: as good as flagged.
        if (root.TryGetProperty("guardian", out var guardianEl) && guardianEl.ValueKind == JsonValueKind.Object)
        {
            var reason = guardianEl.TryGetProperty("reason", out var reasonEl) ? reasonEl.GetString() : null;
            flags.Add(string.IsNullOrWhiteSpace(reason) ? "Guardian judged it risky" : $"Guardian judged it risky ({reason})");
        }
        return new ManaSkillCreateResult(false, id, flags);
    }

    // #581: unlike POST /skills above, this is a direct human edit, not
    // approval-gated (skills-capability.js's own comment: "a Settings form
    // submission already is the human decision the gate exists to
    // require") -- takes effect immediately. Renaming isn't supported --
    // node-bot's PATCH only accepts description/body/category.
    public async Task UpdateSkillAsync(string name, string description, string body, string? category)
    {
        var payload = JsonSerializer.Serialize(new { description, body, category });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PatchAsync($"/skills/{Uri.EscapeDataString(name)}", content);
        response.EnsureSuccessStatusCode();
    }

    // #573: GET /presets -- see presets-store.js for the full stored
    // shape; this only carries what the settings tab shows/edits.
    public async Task<IReadOnlyList<ManaPreset>> GetPresetsAsync()
    {
        using var response = await http.GetAsync("/presets");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var presets = new List<ManaPreset>();
        if (document.RootElement.TryGetProperty("presets", out var presetsElement))
        {
            foreach (var entry in presetsElement.EnumerateArray())
            {
                presets.Add(new ManaPreset
                {
                    Id = entry.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
                    Name = entry.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
                    Instructions = entry.TryGetProperty("instructions", out var instrEl) ? instrEl.GetString() ?? "" : "",
                });
            }
        }
        return presets;
    }

    public async Task CreatePresetAsync(string name, string instructions)
    {
        var payload = JsonSerializer.Serialize(new { name, instructions });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/presets", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task UpdatePresetAsync(string id, string name, string instructions)
    {
        var payload = JsonSerializer.Serialize(new { name, instructions });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PatchAsync($"/presets/{Uri.EscapeDataString(id)}", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task DeletePresetAsync(string id)
    {
        using var response = await http.DeleteAsync($"/presets/{Uri.EscapeDataString(id)}");
        response.EnsureSuccessStatusCode();
    }

    // #570: like GetDoctorResultAsync, this does NOT call
    // EnsureSuccessStatusCode unconditionally -- vtube-routes.js returns
    // 503 (not 200) specifically when VTube Studio is enabled but
    // unreachable, still with a fully-shaped, parseable body (connected:
    // false, error). Only a genuinely unexpected status should throw.
    public async Task<ManaVTubeStatus> GetVTubeStatusAsync()
    {
        using var response = await http.GetAsync("/vtube/status");
        if (!response.IsSuccessStatusCode && response.StatusCode != System.Net.HttpStatusCode.ServiceUnavailable)
        {
            response.EnsureSuccessStatusCode();
        }
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        return new ManaVTubeStatus
        {
            Enabled = root.TryGetProperty("enabled", out var enabledEl) && enabledEl.GetBoolean(),
            Connected = root.TryGetProperty("connected", out var connectedEl) && connectedEl.GetBoolean(),
            Authenticated = root.TryGetProperty("authenticated", out var authEl) && authEl.GetBoolean(),
            Url = root.TryGetProperty("url", out var urlEl) ? urlEl.GetString() : null,
            Error = root.TryGetProperty("error", out var errorEl) ? errorEl.GetString() : null,
        };
    }

    public async Task<bool> AuthenticateVTubeStudioAsync()
    {
        using var response = await http.PostAsync("/vtube/auth", null);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("authenticated", out var authEl) && authEl.GetBoolean();
    }

    // #570: hotkeys is VTube Studio's own API response shape
    // (availableHotkeys, per vtube-studio-client.js's listHotkeys), not
    // something node-bot defines -- hotkeyID/name are its two well-known
    // fields, and unrelated ones are ignored.
    public async Task<IReadOnlyList<ManaVTubeHotkey>> GetVTubeHotkeysAsync()
    {
        using var response = await http.GetAsync("/vtube/hotkeys");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var hotkeys = new List<ManaVTubeHotkey>();
        if (document.RootElement.TryGetProperty("hotkeys", out var hotkeysElement))
        {
            foreach (var entry in hotkeysElement.EnumerateArray())
            {
                hotkeys.Add(new ManaVTubeHotkey
                {
                    Id = entry.TryGetProperty("hotkeyID", out var idEl) ? idEl.GetString() ?? "" : "",
                    Name = entry.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
                });
            }
        }
        return hotkeys;
    }

    public async Task TriggerVTubeHotkeyAsync(string hotkeyId)
    {
        var payload = JsonSerializer.Serialize(new { hotkeyID = hotkeyId });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/vtube/hotkey", content);
        response.EnsureSuccessStatusCode();
    }

    // #569: POST /mobile/pair/request -- admin-gated by mobile-routes.js's
    // own adminAuthMiddleware (a THIRD distinct mechanism from both
    // MANA_ADMIN_SECRET's checkAdminAuth and /admin/accounts's
    // authMiddleware+requireAdmin: it checks the same "Authorization:
    // Bearer <token>"/"x-admin-token" header shape, but validates it
    // against a separate ADMIN_TOKEN env var, or #670's per-run launcher
    // key, which this client sends as x-admin-token). expiresAt is a raw
    // Unix-epoch-milliseconds number (deviceStore's own Date.now()-based
    // TTL), not an ISO string like every other timestamp this client
    // parses elsewhere.
    public async Task<(string Code, long ExpiresAtMs)> RequestPairingCodeAsync()
    {
        using var response = await http.PostAsync("/mobile/pair/request", null);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        return (root.GetProperty("code").GetString() ?? "", root.GetProperty("expiresAt").GetInt64());
    }

    // #569: GET /mobile/devices -- mobile-device-store.js's own
    // listDevices() also returns each device's tokenHash (a SHA-256 hash,
    // not the raw token) in the same response; this deliberately doesn't
    // carry it into ManaMobileDevice since nothing in this tab needs it.
    public async Task<IReadOnlyList<ManaMobileDevice>> GetMobileDevicesAsync()
    {
        using var response = await http.GetAsync("/mobile/devices");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var devices = new List<ManaMobileDevice>();
        if (document.RootElement.TryGetProperty("devices", out var devicesElement))
        {
            foreach (var entry in devicesElement.EnumerateArray())
            {
                devices.Add(new ManaMobileDevice
                {
                    Id = entry.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
                    Name = entry.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
                    CreatedAt = entry.TryGetProperty("createdAt", out var createdEl) ? createdEl.GetString() : null,
                    LastSeenAt = entry.TryGetProperty("lastSeenAt", out var lastSeenEl) ? lastSeenEl.GetString() : null,
                    Revoked = entry.TryGetProperty("revoked", out var revokedEl) && revokedEl.GetBoolean(),
                });
            }
        }
        return devices;
    }

    public async Task<bool> RevokeMobileDeviceAsync(string id)
    {
        using var response = await http.PostAsync($"/mobile/devices/{Uri.EscapeDataString(id)}/revoke", null);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return false;
        }
        response.EnsureSuccessStatusCode();
        return true;
    }

    // #569: like CreateAccountAsync's apiKey, the returned token is shown
    // exactly once -- mobile-device-store.js only ever persists a hash of
    // it, never the raw value.
    public async Task<string?> RotateMobileDeviceTokenAsync(string id)
    {
        using var response = await http.PostAsync($"/mobile/devices/{Uri.EscapeDataString(id)}/rotate", null);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.GetProperty("token").GetString();
    }

    // #568: GET /admin/accounts responds with a bare JSON array (unlike
    // every other list route in this file, which wraps its array under a
    // named key) -- see auth-store.js's listAccounts, which returns
    // res.json(accounts) directly. Requires an admin-role API key sent as
    // the Connection tab's admin token (server.js's authMiddleware +
    // requireAdmin) -- requireAdmin's second check is met by #670's per-run
    // launcher key (x-admin-token), so no separate ADMIN_TOKEN is needed
    // for a backend this launcher started.
    public async Task<IReadOnlyList<ManaAccount>> GetAccountsAsync()
    {
        using var response = await http.GetAsync("/admin/accounts");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var accounts = new List<ManaAccount>();
        foreach (var entry in document.RootElement.EnumerateArray())
        {
            accounts.Add(new ManaAccount
            {
                UserId = entry.TryGetProperty("userId", out var idEl) ? idEl.GetString() ?? "" : "",
                Email = entry.TryGetProperty("email", out var emailEl) ? emailEl.GetString() ?? "" : "",
                Role = entry.TryGetProperty("role", out var roleEl) ? roleEl.GetString() ?? "" : "",
            });
        }
        return accounts;
    }

    // #568: the returned apiKey is shown exactly once -- node-bot never
    // stores or re-serves it (auth-store.js only persists a hash), matching
    // the same one-time-reveal behavior windows-launcher's admin_accounts_ui
    // page has. Losing this return value loses the key permanently; the
    // caller is responsible for actually showing it to the user.
    public async Task<string> CreateAccountAsync(string email, string role)
    {
        var payload = JsonSerializer.Serialize(new { email, role });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/admin/accounts", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.GetProperty("apiKey").GetString() ?? "";
    }

    public async Task DeleteAccountAsync(string userId)
    {
        using var response = await http.DeleteAsync($"/admin/accounts/{Uri.EscapeDataString(userId)}");
        response.EnsureSuccessStatusCode();
    }

    // #567: GET /mcp-clients/servers -- see mcp-client-registry.js's
    // createMcpClientRegistry for the full stored shape; TransportSummary
    // collapses the transport union (stdio command/args/envAllowlist, or
    // an http url) into one display string since this tab never needs to
    // re-edit an existing registration, only show/remove it.
    public async Task<IReadOnlyList<ManaMcpServer>> GetMcpServersAsync()
    {
        using var response = await http.GetAsync("/mcp-clients/servers");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var servers = new List<ManaMcpServer>();
        if (document.RootElement.TryGetProperty("servers", out var serversElement))
        {
            foreach (var entry in serversElement.EnumerateArray())
            {
                var allowedTools = entry.TryGetProperty("allowedTools", out var toolsEl)
                    ? string.Join(", ", toolsEl.EnumerateArray().Select(t => t.GetString() ?? ""))
                    : "";
                servers.Add(new ManaMcpServer
                {
                    Id = entry.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
                    Name = entry.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? "" : "",
                    TransportSummary = SummarizeTransport(entry.TryGetProperty("transport", out var transportEl) ? transportEl : default),
                    AllowedTools = allowedTools,
                });
            }
        }
        return servers;
    }

    private static string SummarizeTransport(JsonElement transport)
    {
        if (transport.ValueKind != JsonValueKind.Object)
        {
            return "";
        }
        var kind = transport.TryGetProperty("kind", out var kindEl) ? kindEl.GetString() : null;
        if (kind == "http")
        {
            return transport.TryGetProperty("url", out var urlEl) ? $"http: {urlEl.GetString()}" : "http";
        }
        if (kind == "stdio")
        {
            var command = transport.TryGetProperty("command", out var commandEl) ? commandEl.GetString() : "";
            return $"stdio: {command}";
        }
        return kind ?? "";
    }

    // #567: registration doesn't take effect immediately -- it's routed
    // through the approval gate server-side (mcp-client-registry.js's own
    // comment: "the actual result is usually {status: 'pending',
    // requestId}"), decided later via the existing Approvals tab. This
    // just returns whatever status string node-bot sends back so the
    // caller can tell the user what actually happened.
    public async Task<string> RegisterMcpServerAsync(string name, string transportKind, string? command, IReadOnlyList<string>? args, IReadOnlyList<string>? envAllowlist, string? url, IReadOnlyList<string> allowedTools)
    {
        object transport = transportKind == "http"
            ? new { kind = "http", url }
            : new { kind = "stdio", command, args, envAllowlist };
        var payload = JsonSerializer.Serialize(new { name, transport, allowedTools });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/mcp-clients/servers", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("status", out var statusEl) ? statusEl.GetString() ?? "unknown" : "registered";
    }

    public async Task DeleteMcpServerAsync(string id)
    {
        using var response = await http.DeleteAsync($"/mcp-clients/servers/{Uri.EscapeDataString(id)}");
        response.EnsureSuccessStatusCode();
    }

    // #566: GET /hooks -- see hooks-store.js's createHooksStore for the
    // full stored shape; this only carries what the settings tab shows.
    public async Task<IReadOnlyList<ManaHookRule>> GetHooksAsync()
    {
        using var response = await http.GetAsync("/hooks");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var rules = new List<ManaHookRule>();
        if (document.RootElement.TryGetProperty("rules", out var rulesElement))
        {
            foreach (var entry in rulesElement.EnumerateArray())
            {
                var lastRunOk = entry.TryGetProperty("lastRun", out var lastRunEl) && lastRunEl.TryGetProperty("ok", out var okEl)
                    ? okEl.GetBoolean()
                    : (bool?)null;
                rules.Add(new ManaHookRule
                {
                    Id = entry.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
                    Phase = entry.TryGetProperty("phase", out var phaseEl) ? phaseEl.GetString() ?? "" : "",
                    Action = entry.TryGetProperty("action", out var actionEl) ? actionEl.GetString() ?? "" : "",
                    ToolName = entry.TryGetProperty("toolName", out var toolEl) ? toolEl.GetString() ?? "" : "",
                    PathContains = entry.TryGetProperty("pathContains", out var pathEl) ? pathEl.GetString() : null,
                    Reason = entry.TryGetProperty("reason", out var reasonEl) ? reasonEl.GetString() : null,
                    Enabled = !entry.TryGetProperty("enabled", out var enabledEl) || enabledEl.GetBoolean(),
                    LastRunOk = lastRunOk,
                });
            }
        }
        return rules;
    }

    // #566: node-bot validates phase/action/toolName itself (400 on a bad
    // combination) -- this client doesn't duplicate that. args, when given,
    // is one argv entry per element (never a shell-joined string); command
    // and args are only required by node-bot for run-command/rollback-on-failure.
    public async Task CreateHookAsync(string phase, string action, string toolName, string? pathContains = null, string? command = null, IReadOnlyList<string>? args = null, string? reason = null)
    {
        var payload = JsonSerializer.Serialize(new { phase, action, toolName, pathContains, command, args, reason });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/hooks", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task SetHookEnabledAsync(string id, bool enabled)
    {
        var payload = JsonSerializer.Serialize(new { enabled });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PatchAsync($"/hooks/{Uri.EscapeDataString(id)}", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task DeleteHookAsync(string id)
    {
        using var response = await http.DeleteAsync($"/hooks/{Uri.EscapeDataString(id)}");
        response.EnsureSuccessStatusCode();
    }

    public async Task<IReadOnlyList<ManaPendingApproval>> GetPendingApprovalsAsync()
    {
        using var response = await http.GetAsync("/approvals/pending");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var pending = new List<ManaPendingApproval>();
        if (document.RootElement.TryGetProperty("pending", out var pendingElement))
        {
            foreach (var entry in pendingElement.EnumerateArray())
            {
                pending.Add(new ManaPendingApproval
                {
                    Id = entry.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
                    ActionType = entry.TryGetProperty("actionType", out var typeEl) ? typeEl.GetString() ?? "" : "",
                    Summary = entry.TryGetProperty("summary", out var summaryEl) ? summaryEl.GetString() ?? "" : "",
                });
            }
        }
        return pending;
    }

    // #838: the ACP agent's (Pipeline B) file-based approvals -- file_write,
    // snapshot_restore and hook-ask requests -- from GET /admin/pending-writes.
    // Only undecided ones: a decided marker waits for the agent to read it.
    public async Task<IReadOnlyList<ManaPendingWrite>> GetPendingWritesAsync()
    {
        using var response = await http.GetAsync("/admin/pending-writes");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var pending = new List<ManaPendingWrite>();
        if (document.RootElement.TryGetProperty("pending", out var pendingElement))
        {
            foreach (var entry in pendingElement.EnumerateArray())
            {
                var decided = (entry.TryGetProperty("approved", out var a) && a.ValueKind == JsonValueKind.True)
                    || (entry.TryGetProperty("rejected", out var r) && r.ValueKind == JsonValueKind.True);
                if (decided || !entry.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }
                var (kind, summary) = DescribePendingWrite(payload);
                pending.Add(new ManaPendingWrite
                {
                    Id = entry.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
                    Kind = kind,
                    Summary = summary,
                });
            }
        }
        return pending;
    }

    private static (string Kind, string Summary) DescribePendingWrite(JsonElement payload)
    {
        string? Text(string name) => payload.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;
        if (Text("kind") == "hook-ask")
        {
            return ("hook ask", $"{Text("reason") ?? "A hook rule asks"} ({Text("tool")})");
        }
        if (Text("snapshotId") is { } snapshotId)
        {
            return ("agent restore", Text("summary") ?? $"restore snapshot {snapshotId}");
        }
        var write = $"{Text("mode") ?? "write"} {Text("path")}".Trim();
        // #838 step 4: a write the adversarial review refuted says how it breaks.
        var failingCase = payload.TryGetProperty("adversarialReview", out var review) && review.ValueKind == JsonValueKind.Object
            && review.TryGetProperty("failingCase", out var failEl) && failEl.ValueKind == JsonValueKind.String ? failEl.GetString() : null;
        return ("agent write", failingCase is null ? write : $"{write} -- Mana's review found a way this breaks: {failingCase}");
    }

    public async Task DecidePendingWriteAsync(string id, bool approve)
    {
        using var content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/admin/pending-writes/{Uri.EscapeDataString(id)}/{(approve ? "approve" : "reject")}", content);
        response.EnsureSuccessStatusCode();
    }

    // #669: "smart" | "ask" | "off" -- which tool calls ask first.
    public async Task<string?> GetToolApprovalModeAsync()
    {
        using var response = await http.GetAsync("/approvals/tool-mode");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("mode", out var modeEl) ? modeEl.GetString() : null;
    }

    public async Task SetToolApprovalModeAsync(string mode)
    {
        var payload = JsonSerializer.Serialize(new { mode });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/approvals/tool-mode", content);
        response.EnsureSuccessStatusCode();
    }

    // #1191: the "Git and GitHub" approval per tier ("local", "github",
    // "danger") -> "ask" | "once" | "off".
    public async Task<IReadOnlyDictionary<string, string>> GetGitApprovalModesAsync()
    {
        using var response = await http.GetAsync("/approvals/git-mode");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var modes = new Dictionary<string, string>();
        if (document.RootElement.TryGetProperty("modes", out var map) && map.ValueKind == JsonValueKind.Object)
        {
            foreach (var entry in map.EnumerateObject())
            {
                modes[entry.Name] = entry.Value.GetString() ?? "";
            }
        }
        return modes;
    }

    public async Task SetGitApprovalModeAsync(string tier, string mode)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { tier, mode }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/approvals/git-mode", content);
        response.EnsureSuccessStatusCode();
    }

    // #1265: "Keep Folio up to date" (node-bot/folio-update.js), on unless saved off.
    public async Task<bool> GetKeepFolioUpdatedAsync()
    {
        using var response = await http.GetAsync("/folio-update");
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return !(document.RootElement.TryGetProperty("enabled", out var enabled) && enabled.ValueKind == JsonValueKind.False);
    }

    public async Task SetKeepFolioUpdatedAsync(bool enabled)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { enabled }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/folio-update", content);
        response.EnsureSuccessStatusCode();
    }

    // "Check now": what the check did, as a sentence.
    public async Task<string> CheckFolioNowAsync()
    {
        using var content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/folio-update/run", content);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        string? Text(string name) => root.TryGetProperty(name, out var v) ? v.ToString() : null;
        return Text("status") switch
        {
            "current" => "Folio is up to date.",
            "opened" => Text("text") ?? "Opened a Folio update PR.",
            "pending" => "Waiting for your OK in Approvals.",
            "waiting" => $"Folio update #{Text("pr")} is still open.",
            "tried" => $"The newest Folio was already tried (#{Text("pr")}).",
            "off" => "Keep Folio up to date is off.",
            "gaming" => "Not while a game is running.",
            "busy" => "Already checking.",
            var other => $"Couldn't check: {Text("error") ?? Text("reason") ?? other}",
        };
    }

    // #1154: the remembered always/never answers, for Settings > Approvals.
    public async Task<IReadOnlyList<ManaRememberedApproval>> GetRememberedApprovalsAsync()
    {
        using var response = await http.GetAsync("/approvals/remembered");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var remembered = new List<ManaRememberedApproval>();
        if (document.RootElement.TryGetProperty("remembered", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in list.EnumerateArray())
            {
                remembered.Add(new ManaRememberedApproval
                {
                    Key = entry.TryGetProperty("key", out var key) ? key.GetString() ?? "" : "",
                    Answer = entry.TryGetProperty("answer", out var answer) ? answer.GetString() ?? "" : "",
                });
            }
        }
        return remembered;
    }

    public async Task ForgetApprovalAsync(string key)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { key }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/approvals/remembered/forget", content);
        response.EnsureSuccessStatusCode();
    }

    // decision: "allow-once" | "allow-session" | "always-allow" | "deny" | "never" -- node-bot
    // validates this itself and 400s on anything else, so this client
    // doesn't duplicate that validation.
    public async Task DecideApprovalAsync(string id, string decision)
    {
        var payload = JsonSerializer.Serialize(new { decision });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/approvals/{Uri.EscapeDataString(id)}/decide", content);
        response.EnsureSuccessStatusCode();
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

    // #580: node-bot's in-memory edit-proposal store -- see
    // zed-integration.js's own listEditProposals. Admin-gated
    // (checkAdminAuth) like the Memory Facts/Skills/Approvals tabs.
    public async Task<IReadOnlyList<ManaProposalSummary>> GetProposalsAsync()
    {
        using var response = await http.GetAsync("/editors/workspace/proposals");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var proposals = new List<ManaProposalSummary>();
        if (document.RootElement.TryGetProperty("proposals", out var proposalsElement))
        {
            foreach (var element in proposalsElement.EnumerateArray())
            {
                proposals.Add(new ManaProposalSummary
                {
                    Id = element.TryGetProperty("id", out var idElement) ? idElement.GetString() ?? "" : "",
                    Status = element.TryGetProperty("status", out var statusElement) ? statusElement.GetString() ?? "" : "",
                    RelativePath = element.TryGetProperty("relativePath", out var pathElement) ? pathElement.GetString() ?? "" : "",
                    Summary = element.TryGetProperty("summary", out var summaryElement) ? summaryElement.GetString() : null,
                    HunkCount = element.TryGetProperty("hunkCount", out var hunkCountElement) ? hunkCountElement.GetInt32() : 0,
                    CreatedAt = element.TryGetProperty("createdAt", out var createdAtElement) ? createdAtElement.GetString() : null,
                });
            }
        }
        return proposals;
    }

    // Returns null on 404 ("edit proposal not found" -- e.g. deleted/
    // applied elsewhere between listing and opening it), same
    // NotFound-tolerant shape as GetSessionDetailAsync.
    public async Task<ManaProposalDetail?> GetProposalDetailAsync(string id)
    {
        using var response = await http.GetAsync($"/editors/workspace/proposals/{Uri.EscapeDataString(id)}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        if (!document.RootElement.TryGetProperty("proposal", out var proposalElement) || proposalElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var hunks = new List<ManaProposalHunk>();
        if (proposalElement.TryGetProperty("hunks", out var hunksElement) && hunksElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var hunkElement in hunksElement.EnumerateArray())
            {
                var lines = new List<string>();
                if (hunkElement.TryGetProperty("lines", out var linesElement) && linesElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var lineElement in linesElement.EnumerateArray())
                    {
                        var line = lineElement.GetString();
                        if (line is not null)
                        {
                            lines.Add(line);
                        }
                    }
                }
                hunks.Add(new ManaProposalHunk
                {
                    Id = hunkElement.TryGetProperty("id", out var hunkIdElement) ? hunkIdElement.GetString() ?? "" : "",
                    OldStart = hunkElement.TryGetProperty("oldStart", out var oldStartElement) ? oldStartElement.GetInt32() : 0,
                    OldLines = hunkElement.TryGetProperty("oldLines", out var oldLinesElement) ? oldLinesElement.GetInt32() : 0,
                    NewStart = hunkElement.TryGetProperty("newStart", out var newStartElement) ? newStartElement.GetInt32() : 0,
                    NewLines = hunkElement.TryGetProperty("newLines", out var newLinesElement) ? newLinesElement.GetInt32() : 0,
                    Lines = lines,
                });
            }
        }

        return new ManaProposalDetail
        {
            Id = proposalElement.TryGetProperty("id", out var idElement) ? idElement.GetString() ?? "" : "",
            Status = proposalElement.TryGetProperty("status", out var statusElement) ? statusElement.GetString() ?? "" : "",
            RelativePath = proposalElement.TryGetProperty("relativePath", out var pathElement) ? pathElement.GetString() ?? "" : "",
            Summary = proposalElement.TryGetProperty("summary", out var summaryElement) ? summaryElement.GetString() : null,
            Hunks = hunks,
            RefutedCase = proposalElement.TryGetProperty("adversarialReview", out var reviewElement)
                && reviewElement.ValueKind == JsonValueKind.Object
                && reviewElement.TryGetProperty("verdict", out var verdictElement)
                && verdictElement.GetString() == "refuted"
                    ? (reviewElement.TryGetProperty("failingCase", out var caseElement) ? caseElement.GetString() : null) ?? "(no case given)"
                    : null,
        };
    }

    // Does NOT call EnsureSuccessStatusCode -- a 400 (unknown hunk id,
    // proposal not pending, workspace file missing, etc.) comes back with
    // a fully-parseable {proposal:null, error} body the caller needs to
    // read, same reasoning as RestoreEditSnapshotAsync's own handling.
    // Q16 (#622): confirmRefuted is the user's explicit go-ahead on an edit
    // Mana's adversarial review refuted; node-bot refuses one without it.
    public async Task<ManaProposalApproveResult> ApproveProposalAsync(string id, IReadOnlyList<string> acceptedHunkIds, bool confirmRefuted = false)
    {
        var payload = confirmRefuted
            ? JsonSerializer.Serialize(new { acceptedHunkIds, confirmRefuted })
            : JsonSerializer.Serialize(new { acceptedHunkIds });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/editors/workspace/proposals/{Uri.EscapeDataString(id)}/approve", content);
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        if (!response.IsSuccessStatusCode)
        {
            return new ManaProposalApproveResult
            {
                Error = root.TryGetProperty("error", out var errorElement) ? errorElement.GetString() ?? "approve failed" : "approve failed",
            };
        }

        return new ManaProposalApproveResult { Approved = true };
    }

    // #579: node-bot's recorded per-file edit snapshots -- see
    // zed-integration.js's own listEditSnapshots. Admin-gated
    // (checkAdminAuth) the same as the Memory Facts/Skills/Approvals tabs.
    public async Task<IReadOnlyList<ManaEditSnapshot>> GetEditSnapshotsAsync()
    {
        using var response = await http.GetAsync("/editors/workspace/snapshots");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var snapshots = new List<ManaEditSnapshot>();
        if (document.RootElement.TryGetProperty("snapshots", out var snapshotsElement))
        {
            foreach (var element in snapshotsElement.EnumerateArray())
            {
                snapshots.Add(new ManaEditSnapshot
                {
                    Id = element.TryGetProperty("id", out var idElement) ? idElement.GetString() ?? "" : "",
                    RelativePath = element.TryGetProperty("relativePath", out var pathElement) ? pathElement.GetString() ?? "" : "",
                    Summary = element.TryGetProperty("summary", out var summaryElement) ? summaryElement.GetString() : null,
                    AppliedAt = element.TryGetProperty("appliedAt", out var appliedAtElement) ? appliedAtElement.GetString() : null,
                });
            }
        }
        return snapshots;
    }

    // #579: does NOT call EnsureSuccessStatusCode -- 409 (a stale
    // snapshot, restore rejected without confirmStale) and 400 (any other
    // restore failure) both come back with a fully-parseable JSON error
    // body the caller needs to read, same reasoning as GetDoctorResultAsync's
    // own non-200-but-still-parseable handling.
    public async Task<ManaSnapshotRestoreResult> RestoreEditSnapshotAsync(string id, bool confirmStale = false)
    {
        var payload = JsonSerializer.Serialize(new { confirmStale });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/editors/workspace/snapshots/{Uri.EscapeDataString(id)}/restore", content);
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
        {
            string? newerAppliedAt = null;
            if (root.TryGetProperty("stale", out var staleElement) && staleElement.ValueKind == JsonValueKind.Object
                && staleElement.TryGetProperty("newerAppliedAt", out var newerAppliedAtElement))
            {
                newerAppliedAt = newerAppliedAtElement.GetString();
            }
            return new ManaSnapshotRestoreResult
            {
                Stale = true,
                NewerAppliedAt = newerAppliedAt,
                Error = root.TryGetProperty("error", out var conflictErrorElement) ? conflictErrorElement.GetString() : null,
            };
        }

        if (!response.IsSuccessStatusCode)
        {
            return new ManaSnapshotRestoreResult
            {
                Error = root.TryGetProperty("error", out var errorElement) ? errorElement.GetString() ?? "restore failed" : "restore failed",
            };
        }

        return new ManaSnapshotRestoreResult { Restored = true };
    }

    // #578: node-bot's transient, human-facing browser-automation activity
    // feed (plugins/browser-automation/browser-automation-activity.js) --
    // no auth needed, same as /models/status (a read-only status readout).
    public async Task<ManaBrowserAutomationActivity> GetBrowserAutomationActivityAsync()
    {
        using var response = await http.GetAsync("/browser-automation/activity");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        var log = new List<ManaBrowserAutomationLogEntry>();
        if (root.TryGetProperty("log", out var logElement) && logElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var entryElement in logElement.EnumerateArray())
            {
                log.Add(new ManaBrowserAutomationLogEntry
                {
                    Action = entryElement.TryGetProperty("action", out var actionElement) ? actionElement.GetString() ?? "" : "",
                    Status = entryElement.TryGetProperty("status", out var statusElement) ? statusElement.GetString() ?? "" : "",
                    Summary = entryElement.TryGetProperty("summary", out var summaryElement) ? summaryElement.GetString() ?? "" : "",
                    At = entryElement.TryGetProperty("at", out var atElement) ? atElement.GetString() ?? "" : "",
                });
            }
        }

        // The screenshot's own "at" isn't read here -- staleness is judged
        // from the log's last entry timestamp, matching windows-launcher's
        // own refreshBrowserAutomationActivity exactly.
        string? screenshotBase64 = null;
        if (root.TryGetProperty("screenshot", out var screenshotElement) && screenshotElement.ValueKind == JsonValueKind.Object
            && screenshotElement.TryGetProperty("base64", out var base64Element))
        {
            screenshotBase64 = base64Element.GetString();
        }

        // #1122: the page she's on, and the web pages this turn took in.
        string? Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var page = root.TryGetProperty("page", out var pageElement) && pageElement.ValueKind == JsonValueKind.Object ? pageElement : (JsonElement?)null;
        var turnPages = new List<ManaWebPageRef>();
        if (root.TryGetProperty("turnPages", out var pagesElement) && pagesElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in pagesElement.EnumerateArray())
            {
                turnPages.Add(new ManaWebPageRef { Source = Text(entry, "source") ?? "", Url = Text(entry, "url") ?? "" });
            }
        }

        // #1168: the page that may need the ads/trackers her browser blocked.
        var blocked = root.TryGetProperty("blocked", out var blockedElement) && blockedElement.ValueKind == JsonValueKind.Object ? blockedElement : (JsonElement?)null;

        // #1139: whether I've taken over her browser, or she's asking me to.
        var takeOver = root.TryGetProperty("takeOver", out var takeOverElement) && takeOverElement.ValueKind == JsonValueKind.Object ? takeOverElement : (JsonElement?)null;

        return new ManaBrowserAutomationActivity
        {
            Log = log,
            ScreenshotBase64 = screenshotBase64,
            PageUrl = page is { } p ? Text(p, "url") : null,
            PageTitle = page is { } t ? Text(t, "title") : null,
            TurnPages = turnPages,
            TakenOver = takeOver is { } o && o.TryGetProperty("active", out var active) && active.ValueKind == JsonValueKind.True,
            NeedsYou = takeOver is { } n ? Text(n, "needsYou") : null,
            SiteTestTitle = root.TryGetProperty("siteTest", out var siteTest) && siteTest.ValueKind == JsonValueKind.Object ? Text(siteTest, "title") : null,
            BlockedUrl = blocked is { } b ? Text(b, "url") : null,
            BlockedCount = blocked is { } c && c.TryGetProperty("count", out var count) && count.TryGetInt32(out var n2) ? n2 : 0,
        };
    }

    // #1122: Stop in the Browser tool -- ends her browser session
    // (plugins/browser-automation's POST /browser/close).
    public async Task CloseBrowserSessionAsync()
    {
        using var content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/browser/close", content);
        response.EnsureSuccessStatusCode();
    }

    // #1139: Take over opens her Edge profile as a visible window at her page
    // (or pageUrl, the one the Browser tool shows); Done closes it and hands
    // the browser back to her.
    public async Task TakeOverBrowserAsync(string? pageUrl)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { url = pageUrl }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/browser/take-over", content);
        response.EnsureSuccessStatusCode();
    }

    // #1158: files I give her to upload (the Browser tool's picker); the
    // backend answers with the ones that exist.
    public async Task<IReadOnlyList<string>> OfferBrowserFilesAsync(IReadOnlyList<string> paths)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { paths }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/browser/offer-files", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.TryGetProperty("offered", out var offered) && offered.ValueKind == JsonValueKind.Array
            ? offered.EnumerateArray().Select(e => e.GetString() ?? "").Where(p => p.Length > 0).ToList()
            : [];
    }

    public async Task HandBackBrowserAsync()
    {
        using var content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/browser/hand-back", content);
        response.EnsureSuccessStatusCode();
    }

    // #1140: the Browser tool's reader view -- POST /web/read fetches the
    // page behind the backend's SSRF guard and returns its readable part as
    // Markdown (tools/html-extract.js), with its images as data: URLs.
    public async Task<ManaReaderPage> ReadPageAsync(string url)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { url, reader = true }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/web/read", content);
        return await ParseReaderPageAsync(response, url);
    }

    // #1161: her latest "Test this site" report, in the reader's shape.
    public async Task<ManaReaderPage> GetSiteTestReportAsync()
    {
        using var response = await http.GetAsync("/browser-automation/site-test");
        return await ParseReaderPageAsync(response, "");
    }

    private static async Task<ManaReaderPage> ParseReaderPageAsync(HttpResponseMessage response, string url)
    {
        var body = await response.Content.ReadAsStringAsync();
        JsonElement root = default;
        try
        {
            root = JsonSerializer.Deserialize<JsonElement>(body);
        }
        catch (JsonException) when (!response.IsSuccessStatusCode)
        {
        }
        string? Text(string name) => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        if (!response.IsSuccessStatusCode)
        {
            // The backend's own reason (a refused private address, a failed fetch) when it gave one.
            throw new InvalidOperationException(Text("error") ?? $"HTTP {(int)response.StatusCode}");
        }
        var images = new Dictionary<string, string>();
        if (root.TryGetProperty("images", out var imagesElement) && imagesElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var image in imagesElement.EnumerateObject())
            {
                if (image.Value.ValueKind == JsonValueKind.String)
                {
                    images[image.Name] = image.Value.GetString()!;
                }
            }
        }
        return new ManaReaderPage
        {
            Url = Text("url") ?? url,
            Title = Text("title") ?? "",
            Text = Text("text") ?? "",
            Truncated = root.TryGetProperty("truncated", out var truncated) && truncated.ValueKind == JsonValueKind.True,
            NeedsBrowser = Text("needsBrowser"),
            Images = images,
        };
    }

    // #646: the chat tool loop's live runs -- no auth, a read-only status
    // readout like /browser-automation/activity above.
    public async Task<IReadOnlyList<ManaAgentRun>> GetAgentActivityAsync()
    {
        using var response = await http.GetAsync("/agent/activity");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var runs = new List<ManaAgentRun>();
        if (document.RootElement.TryGetProperty("runs", out var runsElement) && runsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in runsElement.EnumerateArray())
            {
                runs.Add(new ManaAgentRun
                {
                    Id = element.TryGetProperty("id", out var idElement) ? idElement.GetString() ?? "" : "",
                    ElapsedMs = element.TryGetProperty("elapsedMs", out var elapsedElement) ? elapsedElement.GetInt64() : 0,
                    Tool = element.TryGetProperty("tool", out var toolElement) ? toolElement.GetString() : null,
                    ToolElapsedMs = element.TryGetProperty("toolElapsedMs", out var toolElapsedElement) && toolElapsedElement.ValueKind == JsonValueKind.Number
                        ? toolElapsedElement.GetInt64()
                        : null,
                    ToolCount = element.TryGetProperty("toolCount", out var countElement) ? countElement.GetInt32() : 0,
                    LastTool = element.TryGetProperty("lastTool", out var lastToolElement) ? lastToolElement.GetString() : null,
                    Stopping = element.TryGetProperty("stopping", out var stoppingElement) && stoppingElement.ValueKind == JsonValueKind.True,
                });
            }
        }
        return runs;
    }

    // #1318: the same endpoint's steps of the current/last chat reply, for
    // the chat's step lines. Every field but the step id may be missing.
    public async Task<AgentSteps> GetAgentStepsAsync()
    {
        using var response = await http.GetAsync("/agent/activity");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var running = root.TryGetProperty("running", out var r) && r.ValueKind == JsonValueKind.True;
        return new AgentSteps(StepStr(root, "runId"), running, ParseAgentSteps(root));
    }

    private static string? StepStr(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // #1318/#1337: an object's "steps" array (the activity, a saved reply).
    internal static List<AgentStep> ParseAgentSteps(JsonElement parent)
    {
        var steps = new List<AgentStep>();
        if (parent.TryGetProperty("steps", out var stepsElement) && stepsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var s in stepsElement.EnumerateArray().Where(s => s.ValueKind == JsonValueKind.Object))
            {
                steps.Add(ParseAgentStep(s, steps.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            }
        }
        return steps;
    }

    // The contract's Step; every field but the id may be missing.
    internal static AgentStep ParseAgentStep(JsonElement s, string fallbackId)
    {
        static int? Int(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;
        static DateTimeOffset? Time(JsonElement e, string name) =>
            DateTimeOffset.TryParse(StepStr(e, name), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var t) ? t : null;
        var hasDetail = s.TryGetProperty("detail", out var detail) && detail.ValueKind == JsonValueKind.Object;
        return new AgentStep(
            StepStr(s, "id") ?? fallbackId,
            StepStr(s, "kind") ?? "tool",
            StepStr(s, "description"),
            StepStr(s, "status") ?? "",
            Time(s, "startedAt"),
            Time(s, "endedAt"),
            StepStr(s, "file"),
            Int(s, "added"),
            Int(s, "removed"),
            hasDetail ? StepStr(detail, "command") : null,
            hasDetail ? StepStr(detail, "resultPreview") : null,
            StepStr(s, "tool"),
            Int(s, "segment"),
            Int(s, "textOffset"),
            StepStr(s, "taskId"),
            StepStr(s, "title"));
    }

    // #646: admin-gated (checkAdminAuth) like the proposal approve route.
    // #1011: node-bot opens an issue and a revert PR for a merged PR
    // (admin-gated). MergeCommit is what the rollback checks against.
    public async Task<ManaRevertResult> RevertPrAsync(int pr)
    {
        using var content = new StringContent(JsonSerializer.Serialize(new { pr }), Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/updates/revert", content);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        string? Text(string name) => root.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        return new ManaRevertResult { PrUrl = Text("prUrl"), MergeCommit = Text("mergeCommit"), Error = Text("error") };
    }

    // #1008: Mana's work on her own code. All three are admin-gated.
    public async Task<ManaSelfWorkStatus> GetSelfWorkAsync()
    {
        using var response = await http.GetAsync("/self-work");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        string? Text(string name) => root.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        var log = new List<string>();
        if (root.TryGetProperty("log", out var logElement) && logElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in logElement.EnumerateArray())
            {
                if (entry.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
                {
                    log.Add(text.GetString()!);
                }
            }
        }
        return new ManaSelfWorkStatus
        {
            State = Text("state") ?? "idle",
            Issue = root.TryGetProperty("issue", out var issue) && issue.ValueKind == JsonValueKind.Number ? issue.GetInt32() : null,
            Title = Text("title"),
            Branch = Text("branch"),
            Worktree = Text("worktree"),
            Step = Text("step"),
            PrUrl = Text("prUrl"),
            Log = log,
            // #1269: her Gemini fallback, on or why not, as one line.
            Gemini = root.TryGetProperty("gemini", out var gemini) && gemini.ValueKind == JsonValueKind.Object &&
                gemini.TryGetProperty("text", out var geminiText) && geminiText.ValueKind == JsonValueKind.String
                    ? geminiText.GetString()
                    : null,
        };
    }

    // Null when she started, else why not (a PR limit, a game, RAM...).
    // #1009: allowGuardrails flags the run: she may change her guardrails,
    // and the PR opens as a labelled draft.
    public async Task<string?> StartSelfWorkAsync(int issue, bool allowGuardrails = false)
    {
        var payload = allowGuardrails ? JsonSerializer.Serialize(new { issue, allowGuardrails }) : JsonSerializer.Serialize(new { issue });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/self-work/start", content);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        return root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True
            ? null
            : root.TryGetProperty("error", out var error) ? error.GetString() : "She didn't start.";
    }

    public async Task StopSelfWorkAsync()
    {
        using var content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/self-work/stop", content);
        response.EnsureSuccessStatusCode();
    }

    public async Task StopAgentRunAsync(string id)
    {
        var payload = JsonSerializer.Serialize(new { id });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/agent/stop", content);
        response.EnsureSuccessStatusCode();
    }

    // #1121: the commands Mana runs (node-bot/terminal-feed.js), newest
    // first and without their output. Admin-gated.
    public async Task<IReadOnlyList<ManaTerminalRun>> GetTerminalRunsAsync()
    {
        using var response = await http.GetAsync("/terminal/runs");
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var runs = new List<ManaTerminalRun>();
        if (document.RootElement.TryGetProperty("runs", out var runsElement) && runsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in runsElement.EnumerateArray())
            {
                runs.Add(ReadTerminalRun(element));
            }
        }
        return runs;
    }

    // One run with its output; null once it has dropped off the feed.
    public async Task<ManaTerminalRun?> GetTerminalRunAsync(string id)
    {
        using var response = await http.GetAsync($"/terminal/runs/{Uri.EscapeDataString(id)}");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return ReadTerminalRun(document.RootElement);
    }

    // Through the stop path of whatever ran it; false when nothing could.
    public async Task<bool> StopTerminalRunAsync(string id)
    {
        using var content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/terminal/runs/{Uri.EscapeDataString(id)}/stop", content);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.TryGetProperty("stopped", out var stopped) && stopped.ValueKind == JsonValueKind.True;
    }

    private static ManaTerminalRun ReadTerminalRun(JsonElement e)
    {
        string Text(string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        long? Number(string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : null;
        bool Flag(string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
        return new ManaTerminalRun
        {
            Id = Text("id"),
            Source = Text("source"),
            Command = Text("command"),
            Cwd = Text("cwd"),
            StartedAt = Number("startedAt") ?? 0,
            Output = Text("output"),
            DroppedChars = Number("droppedChars") ?? 0,
            ExitCode = (int?)Number("exitCode"),
            DurationMs = Number("durationMs"),
            Running = Flag("running"),
            Stoppable = Flag("stoppable"),
            Stopped = Flag("stopped"),
        };
    }

    // #1125: everything Mana is doing or has scheduled (node-bot's
    // capabilities/background-tasks-capability.js, #1124). Admin-gated.
    public async Task<IReadOnlyList<ManaBackgroundTask>> GetBackgroundTasksAsync()
    {
        using var response = await http.GetAsync("/background-tasks");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var tasks = new List<ManaBackgroundTask>();
        if (!document.RootElement.TryGetProperty("tasks", out var list) || list.ValueKind != JsonValueKind.Array)
        {
            return tasks;
        }
        foreach (var e in list.EnumerateArray())
        {
            string? Text(string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            DateTimeOffset? Time(string name) => DateTimeOffset.TryParse(Text(name), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var t) ? t : null;
            ManaTaskProgress? progress = null;
            if (e.TryGetProperty("progress", out var p) && p.ValueKind == JsonValueKind.Object
                && p.TryGetProperty("done", out var done) && done.ValueKind == JsonValueKind.Number
                && p.TryGetProperty("total", out var total) && total.ValueKind == JsonValueKind.Number && total.GetDouble() > 0)
            {
                progress = new ManaTaskProgress(done.GetDouble(), total.GetDouble(), p.TryGetProperty("unit", out var unit) && unit.ValueKind == JsonValueKind.String ? unit.GetString() : null);
            }
            tasks.Add(new ManaBackgroundTask
            {
                Id = Text("id") ?? "",
                Kind = Text("kind") ?? "",
                Title = Text("title") ?? "",
                Status = Text("status") ?? "",
                StartedAt = Time("startedAt"),
                NextRunAt = Time("nextRunAt"),
                Progress = progress,
                EtaSeconds = e.TryGetProperty("etaSeconds", out var eta) && eta.ValueKind == JsonValueKind.Number ? eta.GetDouble() : null,
                Detail = Text("detail"),
                CanCancel = e.TryGetProperty("canCancel", out var cancel) && cancel.ValueKind == JsonValueKind.True,
                EndedAt = Time("endedAt"),
                Model = Text("model"),
                Tokens = e.TryGetProperty("tokens", out var tokens) && tokens.ValueKind == JsonValueKind.Number ? tokens.GetDouble() : null,
                ToolUses = e.TryGetProperty("toolUses", out var uses) && uses.ValueKind == JsonValueKind.Number ? (int)uses.GetDouble() : null,
                CurrentAction = Text("currentAction"),
                CanStop = e.TryGetProperty("canStop", out var stop) && stop.ValueKind is JsonValueKind.True or JsonValueKind.False ? stop.GetBoolean() : null,
                TranscriptUrl = Text("transcriptUrl"),
            });
        }
        return tasks;
    }

    // #1318: one task's step log. Null when the backend has none for it
    // (404: unknown id, or a backend from before #1318).
    public async Task<ManaTaskTranscript?> GetBackgroundTaskTranscriptAsync(string id)
    {
        using var response = await http.GetAsync($"/background-tasks/{Uri.EscapeDataString(id)}/transcript");
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var steps = new List<ManaTaskStep>();
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("steps", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            steps.AddRange(list.EnumerateArray().Where(s => s.ValueKind == JsonValueKind.Object).Select(ParseTaskStep));
        }
        string? Text(string name) => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return new ManaTaskTranscript { Id = Text("id") ?? id, Title = Text("title") ?? "", Steps = steps };
    }

    // #1318's shared Step shape; every field optional.
    internal static ManaTaskStep ParseTaskStep(JsonElement e)
    {
        static string? Text(JsonElement o, string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        static int? Int(JsonElement o, string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (int)v.GetDouble() : null;
        DateTimeOffset? Time(string name) => DateTimeOffset.TryParse(Text(e, name), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var t) ? t : null;
        var hasDetail = e.TryGetProperty("detail", out var detail) && detail.ValueKind == JsonValueKind.Object;
        return new ManaTaskStep
        {
            Id = Text(e, "id") ?? "",
            Kind = Text(e, "kind") ?? "",
            Tool = Text(e, "tool"),
            Description = Text(e, "description") ?? "",
            Status = Text(e, "status") ?? "",
            StartedAt = Time("startedAt"),
            EndedAt = Time("endedAt"),
            File = Text(e, "file"),
            Added = Int(e, "added"),
            Removed = Int(e, "removed"),
            Command = hasDetail ? Text(detail, "command") : null,
            ResultPreview = hasDetail ? Text(detail, "resultPreview") : null,
        };
    }

    // False when the task already ended or can't be stopped now (404/409).
    public async Task<bool> CancelBackgroundTaskAsync(string id)
    {
        using var content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/background-tasks/{Uri.EscapeDataString(id)}/cancel", content);
        if (response.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Conflict)
        {
            return false;
        }
        response.EnsureSuccessStatusCode();
        return true;
    }

    // #577: node-bot's deep-research job store (capabilities/deep-research-
    // capability.js) -- 202-Accepted with a jobId, polled via
    // GetResearchJobAsync. sessionId, when given, is what lets the
    // finished report get recorded into that session's memory server-side
    // (recordResearchTurn); omitted (not sent as null) matches every other
    // optional-sessionId call in this file.
    public async Task<string> StartResearchAsync(string question, string? sessionId = null)
    {
        var payload = sessionId is null
            ? JsonSerializer.Serialize(new { question })
            : JsonSerializer.Serialize(new { question, sessionId });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/research/start", content);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync();
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(detail) ? $"Failed to start research ({(int)response.StatusCode})" : detail);
        }
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.GetProperty("jobId").GetString() ?? "";
    }

    public async Task<ManaResearchJob> GetResearchJobAsync(string jobId)
    {
        using var response = await http.GetAsync($"/research/{Uri.EscapeDataString(jobId)}");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;

        string? progressLabel = null;
        if (root.TryGetProperty("progress", out var progressElement) && progressElement.ValueKind == JsonValueKind.Object
            && progressElement.TryGetProperty("label", out var labelElement))
        {
            progressLabel = labelElement.GetString();
        }

        ManaResearchResult? result = null;
        if (root.TryGetProperty("result", out var resultElement) && resultElement.ValueKind == JsonValueKind.Object)
        {
            result = ParseResearchResult(resultElement);
        }

        return new ManaResearchJob
        {
            Status = root.TryGetProperty("status", out var statusElement) ? statusElement.GetString() ?? "" : "",
            ProgressLabel = progressLabel,
            Result = result,
            Error = root.TryGetProperty("error", out var errorElement) ? errorElement.GetString() : null,
        };
    }

    private static ManaResearchResult ParseResearchResult(JsonElement element)
    {
        var sources = new List<ManaResearchSource>();
        if (element.TryGetProperty("sources", out var sourcesElement) && sourcesElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var sourceElement in sourcesElement.EnumerateArray())
            {
                sources.Add(new ManaResearchSource
                {
                    Index = sourceElement.TryGetProperty("index", out var indexElement) ? indexElement.GetInt32() : 0,
                    Title = sourceElement.TryGetProperty("title", out var titleElement) ? titleElement.GetString() : null,
                    Url = sourceElement.TryGetProperty("url", out var urlElement) ? urlElement.GetString() ?? "" : "",
                    ReadFailed = sourceElement.TryGetProperty("readFailed", out var readFailedElement) && readFailedElement.GetBoolean(),
                });
            }
        }

        var subQueries = new List<string>();
        if (element.TryGetProperty("subQueries", out var subQueriesElement) && subQueriesElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var subQueryElement in subQueriesElement.EnumerateArray())
            {
                var text = subQueryElement.GetString();
                if (text is not null)
                {
                    subQueries.Add(text);
                }
            }
        }

        ManaResearchBounds? bounds = null;
        if (element.TryGetProperty("bounds", out var boundsElement) && boundsElement.ValueKind == JsonValueKind.Object)
        {
            bounds = new ManaResearchBounds
            {
                HitTimeLimit = boundsElement.TryGetProperty("hitTimeLimit", out var hitTimeLimitElement) && hitTimeLimitElement.GetBoolean(),
                HitSourceLimit = boundsElement.TryGetProperty("hitSourceLimit", out var hitSourceLimitElement) && hitSourceLimitElement.GetBoolean(),
                SourcesUsed = boundsElement.TryGetProperty("sourcesUsed", out var sourcesUsedElement) ? sourcesUsedElement.GetInt32() : 0,
                MaxSources = boundsElement.TryGetProperty("maxSources", out var maxSourcesElement) ? maxSourcesElement.GetInt32() : 0,
                ElapsedMs = boundsElement.TryGetProperty("elapsedMs", out var elapsedMsElement) ? elapsedMsElement.GetInt64() : 0,
            };
        }

        return new ManaResearchResult
        {
            Report = element.TryGetProperty("report", out var reportElement) ? reportElement.GetString() ?? "" : "",
            Sources = sources,
            SubQueries = subQueries,
            Bounds = bounds,
        };
    }

    // Cancellation is checked between research steps server-side and is
    // idempotent (cancelling a finished job just reports its current
    // state) -- matches windows-launcher's own researchCancelBtn handler,
    // which doesn't even check response.ok, just fires the request.
    public async Task CancelResearchJobAsync(string jobId)
    {
        using var content = new StringContent("", Encoding.UTF8, "application/json");
        using var response = await http.PostAsync($"/research/{Uri.EscapeDataString(jobId)}/cancel", content);
        response.EnsureSuccessStatusCode();
    }

    // #641: read-only data for MemoryGraphForm. Same admin-auth note as
    // GetMemoryFactsAsync.
    public async Task<ManaMemoryGraph> GetMemoryGraphAsync()
    {
        using var response = await http.GetAsync("/admin/memory/graph");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync<ManaMemoryGraph>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaMemoryGraph();
    }

    // #697 / #1282: proactive settings and learned reactions (GET/POST /proactive/settings).
    public async Task<ManaProactiveSettings> GetProactiveSettingsAsync()
    {
        using var response = await http.GetAsync("/proactive/settings");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync<ManaProactiveSettings>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaProactiveSettings();
    }

    public async Task<ManaProactiveSettings> UpdateProactiveSettingsAsync(object patch)
    {
        var json = JsonSerializer.Serialize(patch, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/proactive/settings", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        return await JsonSerializer.DeserializeAsync<ManaProactiveSettings>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? new ManaProactiveSettings();
    }

    private static ReplyStreamEvent ParseReplyStreamEvent(JsonElement root)
    {
        return new ReplyStreamEvent
        {
            Type = root.GetProperty("type").GetString() ?? "",
            Text = root.TryGetProperty("text", out var textProp) ? textProp.GetString() : null,
            Reply = root.TryGetProperty("reply", out var replyProp) ? replyProp.GetString() : null,
            AnswerModel = root.TryGetProperty("answerModel", out var answerModelProp) ? answerModelProp.GetString() : null,
            CloudFallback = root.TryGetProperty("cloudFallback", out var fallbackProp) && fallbackProp.ValueKind == JsonValueKind.True,
            Changed = root.TryGetProperty("changed", out var changedProp) && changedProp.GetBoolean(),
            Expression = root.TryGetProperty("expression", out var exprProp) ? exprProp.GetString() : null,
            Emotion = root.TryGetProperty("emotion", out var emotionProp) && emotionProp.ValueKind == JsonValueKind.String ? emotionProp.GetString() : null,
            Error = root.TryGetProperty("error", out var errProp) ? errProp.GetString() : null,
            Name = root.TryGetProperty("name", out var nameProp) && nameProp.ValueKind == JsonValueKind.String ? nameProp.GetString() : null,
            Phase = root.TryGetProperty("phase", out var phaseProp) && phaseProp.ValueKind == JsonValueKind.String ? phaseProp.GetString() : null,
            DeepThinking = root.TryGetProperty("deepThinking", out var deepProp) && deepProp.ValueKind == JsonValueKind.True,
            Character = root.TryGetProperty("character", out var characterProp) && characterProp.ValueKind == JsonValueKind.String ? characterProp.GetString() : null,
            CharacterName = root.TryGetProperty("characterName", out var characterNameProp) && characterNameProp.ValueKind == JsonValueKind.String ? characterNameProp.GetString() : null,
            Kind = root.TryGetProperty("kind", out var kindProp) && kindProp.ValueKind == JsonValueKind.String ? kindProp.GetString() : null,
            Id = root.TryGetProperty("id", out var idProp) && idProp.ValueKind == JsonValueKind.String ? idProp.GetString() : null,
            Date = root.TryGetProperty("date", out var dateProp) && dateProp.ValueKind == JsonValueKind.String ? dateProp.GetString() : null,
            // #1354: reasoning tokens / thought deliberation.
            Thought = root.TryGetProperty("thought", out var thProp) && thProp.ValueKind == JsonValueKind.String ? thProp.GetString() : null,
            // #1337: a "tool" event carries the whole step (none before #1318).
            Step = root.GetProperty("type").GetString() == "tool" && StepStr(root, "id") is { } stepId ? ParseAgentStep(root, stepId) : null,
            // #1329: on "final", verified web sources cited in the reply.
            Sources = root.TryGetProperty("sources", out var sourcesProp) && sourcesProp.ValueKind == JsonValueKind.Array
                ? sourcesProp.EnumerateArray()
                    .Select(s => new WebSourceCitation(
                        s.TryGetProperty("index", out var idx) ? idx.GetInt32() : 0,
                        s.TryGetProperty("title", out var title) ? title.GetString() ?? "" : "",
                        s.TryGetProperty("url", out var url) ? url.GetString() ?? "" : ""))
                    .ToList()
                : null,
        };
    }
}

// #688: POST /skills -- created now, or waiting for approval (PendingId)
// with what the content scan or Guardian flagged (only an empty Flags may
// be auto-approved).
internal sealed record ManaSkillCreateResult(bool Created, string? PendingId, IReadOnlyList<string> Flags);

internal sealed class ManaPerformanceStatus
{
    public int TotalMemoryMb { get; init; }
    public string TtsProvider { get; init; } = "unknown";
    public bool GamingAppRunning { get; init; }
    // #688: the watched game processes found running (empty when none).
    public IReadOnlyList<string> MatchedProcesses { get; init; } = Array.Empty<string>();
    public long UptimeSeconds { get; init; }
    public int WhisperThreads { get; init; }
    public int LlamaThreads { get; init; }
    public int LlamaMaxTokens { get; init; }
    public bool ScreenContextEnabled { get; init; }
    // #889: the running chat model, "(gaming model)" appended while gaming; null when none is loaded.
    public string? ChatModel { get; init; }
    public IReadOnlyDictionary<string, string> Operations { get; init; } = new Dictionary<string, string>();
    // Issue #421 (backend), null whenever the backend omitted "tokenUsage"
    // -- see GetPerformanceStatusAsync's own comment for when that happens.
    public ManaSessionTokenUsage? TokenUsage { get; init; }
}

internal sealed class ManaSessionTokenUsage
{
    public long PromptTokens { get; init; }
    public long CompletionTokens { get; init; }
    public long TotalTokens { get; init; }
    public int Calls { get; init; }
    public long? WarnThreshold { get; init; }
    public long? StopThreshold { get; init; }
    public bool WarnExceeded { get; init; }
    public bool StopExceeded { get; init; }
}

// #527/#572: GET /models/status.
internal sealed class ManaModelStatus
{
    public bool LocalOnly { get; init; }
    public ManaCloudFallback Fallback { get; init; } = new();
    public string? ActiveProfile { get; init; }
    public IReadOnlyDictionary<string, ManaModelProfile> Profiles { get; init; } = new Dictionary<string, ManaModelProfile>();
    public string? SelectedModelPath { get; init; }
    public string BrainType { get; init; } = "local";
    public string BrainBaseUrl { get; init; } = "";
    public string BrainModel { get; init; } = "";
    public bool BrainHasApiKey { get; init; }
    public string VisionModelPath { get; init; } = "";
    public string VisionMmprojPath { get; init; } = "";
    // #625: model-management.js's hardware-based profile suggestion key.
    public string? RecommendedProfile { get; init; }
    // Whether llama-server loads the model straight into VRAM (effective value).
    public bool LoadIntoVram { get; init; }
}

// #572: one entry from GET /models/brain-providers.
internal sealed class ManaCloudFallback
{
    public bool Enabled { get; init; }
    public bool Active { get; init; }
    public int TimeoutSeconds { get; init; }
    public string BaseUrl { get; init; } = "";
    public string Model { get; init; } = "";
    public bool HasApiKey { get; init; }
}

internal sealed class ManaChatModels
{
    public List<ManaChatModel> Models { get; init; } = new();
    public string Selected { get; init; } = "automatic";
}

internal sealed record ManaChatModel(string Id, string Label)
{
    public override string ToString() => Label;
}

internal sealed class ManaBrainProviderPreset
{
    public string Id { get; init; } = "";
    public string Label { get; init; } = "";
    public string BaseUrl { get; init; } = "";
    public bool NeedsKey { get; init; }
}

// #572: POST /models/scan's response.
internal sealed class ManaGgufScanResult
{
    public IReadOnlyList<ManaGgufFile> Files { get; init; } = System.Array.Empty<ManaGgufFile>();
    public bool Truncated { get; init; }
}

internal sealed class ManaGgufFile
{
    public string Path { get; init; } = "";
    public string Name { get; init; } = "";
    public long SizeBytes { get; init; }
    // #625: "fits" / "slow" / "wont_fit", or null when node-bot couldn't tell.
    public string? Fit { get; init; }
}

internal sealed class ManaModelProfile
{
    public string Key { get; init; } = "";
    public string? Label { get; init; }

    // Full local file path, or null if no matching GGUF was found --
    // profiles silently fall back to a smaller model when the preferred
    // file isn't downloaded, which is exactly what CompareModeFormatter
    // surfaces to the user.
    public string? SelectedModel { get; init; }
    public bool Available { get; init; }
}

// #526: node-bot's GET /doctor result -- see doctor.js's buildDoctorResult.
internal sealed class ManaDoctorResult
{
    public bool Ok { get; init; }
    public int Pass { get; init; }
    public int Warn { get; init; }
    public int Fail { get; init; }
    public IReadOnlyList<ManaDoctorCheck> Checks { get; init; } = System.Array.Empty<ManaDoctorCheck>();
}

internal sealed class ManaDoctorCheck
{
    public string Id { get; init; } = "";
    public string Label { get; init; } = "";
    public string Status { get; init; } = "";
    public string Message { get; init; } = "";
}

// #520: a row from GET /sessions -- see acp-memory-store.js's
// listSessions for the full stored shape; this only carries what the
// session list UI needs.
internal sealed class ManaSession
{
    public string? ProjectId { get; init; }
    public string? ProjectName { get; init; }
    public string SessionId { get; init; } = "";
    public string? Name { get; init; }
    public string? Goal { get; init; }
    public string? UpdatedAt { get; init; }
    // #1322: branched session metadata
    public string? ForkedFrom { get; init; }
    public int? BranchTurnIndex { get; init; }
}

internal sealed class ManaProject
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Instructions { get; set; } = "";
    public List<ManaProjectReference> References { get; set; } = new();
    public override string ToString() => Name;
}

internal sealed class ManaProjectReference
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Path { get; set; } = "";
    public string Kind { get; set; } = "file";
    public bool Authorized { get; set; }
    public override string ToString() => $"{Label} ({Path})";
}

// #586: GET /sessions/:id's full stored shape, trimmed to what the
// "Open memory" modal needs -- see acp-memory-store.js's own getSession.
internal sealed class ManaSessionDetail
{
    public string? Summary { get; init; }
    public string? Goal { get; init; }
    public IReadOnlyList<ManaSessionTurn> RecentTurns { get; init; } = Array.Empty<ManaSessionTurn>();
    public int TotalTurnCount { get; init; }
}

// #642: GET /prompt-composition/:sessionId, trimmed to what the context
// meter shows.
internal sealed class ManaPromptComposition
{
    public IReadOnlyList<ManaPromptBlock> Blocks { get; init; } = Array.Empty<ManaPromptBlock>();
    public string? CountedWith { get; init; }
    public long? TotalTokens { get; init; }
    public long? PromptTokens { get; init; }
    public long? UnattributedTokens { get; init; }
    public long? ContextSize { get; init; }
    public double? PercentUsed { get; init; }
}

internal sealed class ManaPromptBlock
{
    public string Name { get; init; } = "";
    public long Tokens { get; init; }
}

// #1142: GET /sessions/:id/artifacts.
internal sealed record ManaSavedArtifact(int Turn, string? At, string Language, string Title, string ThreadId, int VersionIndex);

internal sealed record ManaSavedArtifactList(List<ManaSavedArtifact>? Artifacts);

internal sealed class ManaSessionTurn
{
    public string? AnswerModel { get; init; }
    public bool CloudFallback { get; init; }
    public int TurnIndex { get; init; }
    public string? At { get; init; }
    public string? User { get; init; }
    public string? Assistant { get; init; }
    // #1354: reasoning tokens / thought deliberation.
    public string? Thought { get; init; }
    // #1337: the reply's steps, placed at their textOffsets.
    public IReadOnlyList<AgentStep> Steps { get; init; } = [];
    // #1337: set instead of User/Assistant on a "background task ended" event.
    public ManaTaskNotice? Notice { get; init; }
    // #1322: versions of assistant reply
    public IReadOnlyList<string> Versions { get; init; } = Array.Empty<string>();
    public int VersionIndex { get; init; }
}

// #1337: a background task started from a chat ended (its history's event,
// or the tray socket's background_task_done).
internal sealed record ManaTaskNotice(string TaskId, string? Title, string? Status, string? Text);

// #529: GET /plugins (one entry per capability, flattened out of its
// category grouping).
internal sealed class ManaPlugin
{
    public string Key { get; init; } = "";
    public string Name { get; init; } = "";
    public string? Description { get; init; }
    public bool Enabled { get; init; }
}

// #529: GET /admin/memory/facts.
internal sealed class ManaMemoryFact
{
    public string Key { get; init; } = "";
    public string Text { get; init; } = "";
    public string Status { get; init; } = "";
    public bool Pinned { get; init; }
    // #673: "trusted" / "tentative" / "untrusted", derived server-side.
    public string Trust { get; init; } = "";
    // #698: set on a standing intent ("when Trigger comes up, mention Text").
    public string Trigger { get; init; } = "";
    public bool Paused { get; init; }
}

// #529: GET /skills (index only -- see GetSkillsAsync's own comment).
internal sealed class ManaSkill
{
    public string Name { get; init; } = "";
    public string? Description { get; init; }
    public string? Status { get; init; }
}

// #581: GET /skills/:name -- the full skill, unlike ManaSkill's index-only
// listing shape above.
internal sealed class ManaSkillDetail
{
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public string Body { get; init; } = "";
    public string? Category { get; init; }
}

// #529: GET /approvals/pending.
// #1154: an always/never answer node-bot remembers. Key is the action type
// or grant key ("browser-site:shop.test").
internal sealed class ManaRememberedApproval
{
    public string Key { get; init; } = "";
    public string Answer { get; init; } = "";

    // What Settings shows: a browser site or a git repo (#1182) by name,
    // anything else by its key.
    public string Label
    {
        get
        {
            var colon = Key.IndexOf(':');
            var what = colon < 0 ? null : Key[..colon] switch
            {
                "browser-site" => "Browser",
                "git-repo" => "Git repo",
                "git-local" => "Git local changes",
                "git-github" => "GitHub writes",
                "git-danger" => "Git merges, force-pushes and deletes",
                _ => null,
            };
            return what is null ? Key : $"{what}: {Key[(colon + 1)..]}";
        }
    }
}

internal sealed class ManaPendingApproval
{
    public string Id { get; init; } = "";
    public string ActionType { get; init; } = "";
    public string Summary { get; init; } = "";
}

// #838: one undecided GET /admin/pending-writes entry.
internal sealed class ManaPendingWrite
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "";
    public string Summary { get; init; } = "";
}

// #573: GET /presets.
internal sealed class ManaPreset
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Instructions { get; init; } = "";

    public override string ToString() => Name; // #681: Settings > Presets' active-preset combo
}

// #570: GET /vtube/status.
internal sealed class ManaVTubeStatus
{
    public bool Enabled { get; init; }
    public bool Connected { get; init; }
    public bool Authenticated { get; init; }
    public string? Url { get; init; }
    public string? Error { get; init; }
}

// #570: one entry from GET /vtube/hotkeys (VTube Studio's own
// availableHotkeys shape -- see GetVTubeHotkeysAsync's own comment).
internal sealed class ManaVTubeHotkey
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
}

// #569: one entry from GET /mobile/devices (tokenHash deliberately not
// carried -- see GetMobileDevicesAsync's own comment).
internal sealed class ManaMobileDevice
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string? CreatedAt { get; init; }
    public string? LastSeenAt { get; init; }
    public bool Revoked { get; init; }
}

// #568: one entry from GET /admin/accounts (keyHash never included --
// see auth-store.js's listAccounts).
internal sealed class ManaAccount
{
    public string UserId { get; init; } = "";
    public string Email { get; init; } = "";
    public string Role { get; init; } = "";
}

// #567: GET /mcp-clients/servers (display-only summary -- see
// GetMcpServersAsync's own comment for why the transport union is
// collapsed to one string here).
internal sealed class ManaMcpServer
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string TransportSummary { get; init; } = "";
    public string AllowedTools { get; init; } = "";
}

// #566: GET /hooks (index only -- see GetHooksAsync's own comment).
internal sealed class ManaHookRule
{
    public string Id { get; init; } = "";
    public string Phase { get; init; } = "";
    public string Action { get; init; } = "";
    public string ToolName { get; init; } = "";
    public string? PathContains { get; init; }
    public string? Reason { get; init; }
    public bool Enabled { get; init; }
    public bool? LastRunOk { get; init; }
}

internal sealed class ReplyStreamEvent
{
    public string? AnswerModel { get; init; }
    public bool CloudFallback { get; init; }
    public string Type { get; init; } = "";
    public string? Text { get; init; }
    public string? Reply { get; init; }
    // #1354: reasoning tokens / thought deliberation.
    public string? Thought { get; init; }
    public bool Changed { get; init; }
    public string? Expression { get; init; }
    // #623: node-bot's emotion tag -- a "sentence" event's face, or on
    // "final" the whole reply's (for speaking it as one clip).
    public string? Emotion { get; init; }
    public string? Error { get; init; }
    // #661: type "tool" -- the tool's name and "start"/"end".
    public string? Name { get; init; }
    public string? Phase { get; init; }
    // #675 Q12b: on "final", whether Mana's own deep thinking is on.
    public bool DeepThinking { get; init; }
    // #914: on "sentence"/"final", the character speaking (id and name) --
    // in group mode a second final follows with her sister's reaction.
    public string? Character { get; init; }
    public string? CharacterName { get; init; }
    // #914: type "noted" -- a relationship "note" or "milestone" she just
    // made (Text; a milestone's Date), and its Id for undoing it.
    public string? Kind { get; init; }
    public string? Id { get; init; }
    public string? Date { get; init; }
    // #1337: on "tool", the step it started or updated.
    public AgentStep? Step { get; init; }
    // #1329: on "final", verified web sources cited in the reply.
    public IReadOnlyList<WebSourceCitation>? Sources { get; init; }
}

// #1329: a verified web source citation cited in chat answers.
internal sealed record WebSourceCitation(int Index, string Title, string Url);

// #914: GET /characters/relationships -- one character's notes and milestones.
internal sealed record ManaCharacterRelationship(string Id, string Name, IReadOnlyList<ManaRelationshipItem> Notes, IReadOnlyList<ManaRelationshipItem> Milestones);

// Kind: "notes" or "milestones" (its route); Date only on a milestone.
internal sealed record ManaRelationshipItem(string Kind, string Id, string Text, string? Date);

// #580: a row from GET /editors/workspace/proposals -- see
// zed-integration.js's own listProposals.
internal sealed class ManaProposalSummary
{
    public string Id { get; init; } = "";
    public string Status { get; init; } = "";
    public string RelativePath { get; init; } = "";
    public string? Summary { get; init; }
    public int HunkCount { get; init; }
    public string? CreatedAt { get; init; }
}

// #580: GET /editors/workspace/proposals/:id's full shape, including
// every hunk for the review UI's checkboxes.
internal sealed class ManaProposalDetail
{
    public string Id { get; init; } = "";
    public string Status { get; init; } = "";
    public string RelativePath { get; init; } = "";
    public string? Summary { get; init; }
    public IReadOnlyList<ManaProposalHunk> Hunks { get; init; } = Array.Empty<ManaProposalHunk>();
    // Q16 (#622): the failing case when Mana's adversarial review refuted
    // this edit (approving it then needs the user's explicit confirmation).
    public string? RefutedCase { get; init; }
}

// #580: one jsdiff structuredPatch hunk (computeProposalHunks) -- Lines
// is unified-diff text, each entry already prefixed with ' '/'+'/'-'.
internal sealed class ManaProposalHunk
{
    public string Id { get; init; } = "";
    public int OldStart { get; init; }
    public int OldLines { get; init; }
    public int NewStart { get; init; }
    public int NewLines { get; init; }
    public IReadOnlyList<string> Lines { get; init; } = Array.Empty<string>();
}

internal sealed class ManaProposalApproveResult
{
    public bool Approved { get; init; }
    public string? Error { get; init; }
}
// #579: a row from GET /editors/workspace/snapshots -- see
// zed-integration.js's own listEditSnapshots.
internal sealed class ManaEditSnapshot
{
    public string Id { get; init; } = "";
    public string RelativePath { get; init; } = "";
    public string? Summary { get; init; }
    public string? AppliedAt { get; init; }
}

// #579: the outcome of POST /editors/workspace/snapshots/:id/restore.
// Restored is the only true-on-success case; Stale means the target file
// was written to again since the snapshot was recorded (a second restore
// with confirmStale:true overrides this), and a non-null Error with
// Stale false is any other restore failure (e.g. the workspace file no
// longer exists).
internal sealed class ManaSnapshotRestoreResult
{
    public bool Restored { get; init; }
    public bool Stale { get; init; }
    public string? NewerAppliedAt { get; init; }
    public string? Error { get; init; }
}
// #578: GET /browser-automation/activity's shape -- see
// browser-automation-activity.js's own getActivity.
internal sealed class ManaBrowserAutomationActivity
{
    public IReadOnlyList<ManaBrowserAutomationLogEntry> Log { get; init; } = Array.Empty<ManaBrowserAutomationLogEntry>();
    public string? ScreenshotBase64 { get; init; }
    public string? PageUrl { get; init; }
    public string? PageTitle { get; init; }
    public IReadOnlyList<ManaWebPageRef> TurnPages { get; init; } = Array.Empty<ManaWebPageRef>();
    public bool TakenOver { get; init; }
    public string? NeedsYou { get; init; }
    // #1161: the latest site test's title, when there is one.
    public string? SiteTestTitle { get; init; }
    public string? BlockedUrl { get; init; }
    public int BlockedCount { get; init; }
}

// #1122: a web page this turn took in (framed as untrusted); Source is the
// frame's label ("web page", "web search", ...).
internal sealed class ManaWebPageRef
{
    public string Source { get; init; } = "";
    public string Url { get; init; } = "";
}

// #1140: POST /web/read's reader-view answer. Images: the Markdown's image
// srcs, as written, to data: URLs.
internal sealed class ManaReaderPage
{
    public string Url { get; init; } = "";
    public string Title { get; init; } = "";
    public string Text { get; init; } = "";
    public bool Truncated { get; init; }
    public string? NeedsBrowser { get; init; }
    public IReadOnlyDictionary<string, string> Images { get; init; } = new Dictionary<string, string>();
}

internal sealed class ManaBrowserAutomationLogEntry
{
    public string Action { get; init; } = "";
    public string Status { get; init; } = "";
    public string Summary { get; init; } = "";
    public string At { get; init; } = "";
}

// #1011: POST /updates/revert's answer.
internal sealed class ManaRevertResult
{
    public string? PrUrl { get; init; }
    public string? MergeCommit { get; init; }
    public string? Error { get; init; }
}

// #1008: GET /self-work (node-bot/self-work.js). State is "idle" when she
// hasn't worked on her own code since the backend started.
internal sealed class ManaSelfWorkStatus
{
    public string State { get; init; } = "idle";
    public int? Issue { get; init; }
    public string? Title { get; init; }
    public string? Branch { get; init; }
    public string? Worktree { get; init; }
    public string? Step { get; init; }
    public string? PrUrl { get; init; }
    public IReadOnlyList<string> Log { get; init; } = [];
    public string? Gemini { get; init; }
}

// #1125: one entry from GET /background-tasks. Status is running,
// scheduled, waiting, paused, done or failed. No Progress on a running task
// means the backend can't measure it (an indeterminate bar); EtaSeconds is
// only there when it can be estimated from the rate so far.
internal sealed class ManaBackgroundTask
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "";
    public string Title { get; init; } = "";
    public string Status { get; init; } = "";
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset? NextRunAt { get; init; }
    public ManaTaskProgress? Progress { get; init; }
    public double? EtaSeconds { get; init; }
    public string? Detail { get; init; }
    public bool CanCancel { get; init; }
    // #1318 (each null when the backend doesn't know it): the card's
    // model, token and tool-use counts and what it's doing now; CanStop
    // falls back to CanCancel on a backend from before #1318.
    public DateTimeOffset? EndedAt { get; init; }
    public string? Model { get; init; }
    public double? Tokens { get; init; }
    public int? ToolUses { get; init; }
    public string? CurrentAction { get; init; }
    public bool? CanStop { get; init; }
    public string? TranscriptUrl { get; init; }
    public bool Stoppable => CanStop ?? CanCancel;
}

// #1318: GET /background-tasks/:id/transcript.
internal sealed class ManaTaskTranscript
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public IReadOnlyList<ManaTaskStep> Steps { get; init; } = [];
}

// #1318: one step of a task. Status is running, done, failed or
// awaiting_approval; Command and ResultPreview come from its detail
// (sanitized server-side).
internal sealed class ManaTaskStep
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "";
    public string? Tool { get; init; }
    public string Description { get; init; } = "";
    public string Status { get; init; } = "";
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset? EndedAt { get; init; }
    public string? File { get; init; }
    public int? Added { get; init; }
    public int? Removed { get; init; }
    public string? Command { get; init; }
    public string? ResultPreview { get; init; }
}

// Unit: "files", "bytes", "sources", "rounds", or "ms" for a countdown.
internal sealed record ManaTaskProgress(double Done, double Total, string? Unit)
{
    public double Fraction => Math.Clamp(Done / Total, 0, 1);
}

// #646: one entry from GET /agent/activity (node-bot/agent-activity.js).
// #1121: one entry of GET /terminal/runs (node-bot/terminal-feed.js).
// Output is only filled by GetTerminalRunAsync.
internal sealed class ManaTerminalRun
{
    public string Id { get; init; } = "";
    public string Source { get; init; } = "";
    public string Command { get; init; } = "";
    public string Cwd { get; init; } = "";
    public long StartedAt { get; init; }
    public string Output { get; init; } = "";
    public long DroppedChars { get; init; }
    public int? ExitCode { get; init; }
    public long? DurationMs { get; init; }
    public bool Running { get; init; }
    public bool Stoppable { get; init; }
    // Ended by Stop (its process tree killed).
    public bool Stopped { get; init; }
}

internal sealed class ManaAgentRun
{
    public string Id { get; init; } = "";
    public long ElapsedMs { get; init; }
    public string? Tool { get; init; }
    public long? ToolElapsedMs { get; init; }
    public int ToolCount { get; init; }
    public string? LastTool { get; init; }
    public bool Stopping { get; init; }
}

// #577: GET /research/:jobId's shape -- see deep-research-capability.js's
// own job object. Status is one of "running"/"done"/"cancelled"/"error".
internal sealed class ManaResearchJob
{
    public string Status { get; init; } = "";
    public string? ProgressLabel { get; init; }
    public ManaResearchResult? Result { get; init; }
    public string? Error { get; init; }
}

// #577: the shape tools/deep-research.js's runDeepResearch resolves with
// -- see windows-launcher/renderer.js's own formatResearchReply for the
// exact fields this port's ResearchFormatter reads.
internal sealed class ManaResearchResult
{
    public string Report { get; init; } = "";
    public IReadOnlyList<ManaResearchSource> Sources { get; init; } = Array.Empty<ManaResearchSource>();
    public IReadOnlyList<string> SubQueries { get; init; } = Array.Empty<string>();
    public ManaResearchBounds? Bounds { get; init; }
}

internal sealed class ManaResearchSource
{
    public int Index { get; init; }
    public string? Title { get; init; }
    public string Url { get; init; } = "";
    public bool ReadFailed { get; init; }
}

internal sealed class ManaResearchBounds
{
    public bool HitTimeLimit { get; init; }
    public bool HitSourceLimit { get; init; }
    public int SourcesUsed { get; init; }
    public int MaxSources { get; init; }
    public long ElapsedMs { get; init; }
}

// #693: GET /models/llama-build.
internal sealed class ManaLlamaBuildStatus
{
    public int? CurrentBuild { get; init; }
    public string? CurrentVariant { get; init; }
    public string? CurrentError { get; init; }
    public string? Previous { get; init; }
    public string? LastRollbackFrom { get; init; }
    public string? LastRollbackReason { get; init; }
    // "running" / "done" / "failed", or null when no update ran this session.
    public string? JobState { get; init; }
    public string? JobTag { get; init; }
    public string? JobStep { get; init; }
    public string? JobError { get; init; }
}

// #693: POST /models/llama-build/check.
internal sealed class ManaLlamaBuildCheck
{
    public string? LatestTag { get; init; }
    public bool UpdateAvailable { get; init; }
    public bool DigestAvailable { get; init; }
    public string? Error { get; init; }
}

// #693: POST /models/llama-build/update and /rollback.
internal sealed class ManaLlamaBuildActionResult
{
    public bool Ok { get; init; }
    public string? Code { get; init; }
    public string? Error { get; init; }
}

// #641: GET /admin/memory/graph.
internal sealed class ManaMemoryGraph
{
    public List<ManaMemoryGraphNode> Nodes { get; init; } = new();
    public List<ManaMemoryGraphEdge> Edges { get; init; } = new();
    // Newest validFrom first; InvalidatedAt set = superseded.
    public List<ManaMemoryFactWindow> Facts { get; init; } = new();
}

internal sealed class ManaMemoryGraphNode
{
    public string Key { get; init; } = "";
    public string Display { get; init; } = "";
    // entity-ontology.js's category; null while not yet typed.
    public string? Type { get; init; }
}

internal sealed class ManaMemoryGraphEdge
{
    public string A { get; init; } = "";
    public string B { get; init; } = "";
    public double Weight { get; init; }
    public string? LastReinforcedAt { get; init; }
}

internal sealed class ManaMemoryFactWindow
{
    public string Key { get; init; } = "";
    public string Text { get; init; } = "";
    public string? ValidFrom { get; init; }
    public string? InvalidatedAt { get; init; }
}

internal sealed class ManaBriefingSettings
{
    public bool Enabled { get; set; } = true;
    // HH:MM; it goes out the first time I'm at the PC at or after this.
    public string Time { get; set; } = "08:00";
    // Of "memory", "reminders", "news", "games", "calendar".
    public List<string> Sections { get; set; } = new();
    // Comma-separated news topics, and games for patch/maintenance notices.
    public string Topics { get; set; } = "";
    public string Games { get; set; } = "";
}

// #699: one heartbeat.md check as Settings > Heartbeat edits it.
internal sealed class ManaHeartbeatItem
{
    public string Id { get; set; } = "";
    public string Text { get; set; } = "";
    // "every 30m", "every 2h" or "daily 09:00"; empty is every 30m.
    public string Schedule { get; set; } = "";
    // Of "write" and "network"; read is always allowed.
    public List<string> Permissions { get; set; } = new();
    public bool Urgent { get; set; }
    public bool Enabled { get; set; } = true;
}

internal sealed class ManaHeartbeatItems
{
    public List<ManaHeartbeatItem> Items { get; set; } = new();
}

internal sealed class ManaSpeechVocabulary
{
    public List<string> Words { get; init; } = new();
    // What whisper wrote -> what I said.
    public Dictionary<string, string> Corrections { get; init; } = new();
    // "en" or "auto"; EnvLanguage (WHISPER_LANGUAGE) wins when set.
    public string Language { get; init; } = "en";
    public string? EnvLanguage { get; init; }
}

// #935: GET /admin/memory/vault (memory-vault.js getStatus()).
internal sealed class ManaVaultStatus
{
    public string? VaultDir { get; init; }
    // "watching", "polling" (the file watcher is down) or "stopped".
    public string? Mode { get; init; }
    public int Notes { get; init; }
    public DateTimeOffset? LastSyncAt { get; init; }
    public string? Error { get; init; }
    public List<ManaVaultSkippedNote> Skipped { get; init; } = new();
}

internal sealed class ManaVaultSkippedNote
{
    public string File { get; init; } = "";
    public string Reason { get; init; } = "";
}

// #950: GET /mail-calendar. Null when that account isn't set up;
// Unreadable when its saved settings can't be decrypted on this PC.
internal sealed class ManaMailCalendar
{
    public ManaMailAccount? Email { get; init; }
    public ManaCalendarAccount? Calendar { get; init; }
}

internal sealed class ManaMailAccount
{
    public string? Host { get; init; }
    public int Port { get; init; }
    public string? User { get; init; }
    public string? Mailbox { get; init; }
    public bool PasswordSet { get; init; }
    public bool Unreadable { get; init; }
}

internal sealed class ManaCalendarAccount
{
    public string? Host { get; init; }
    public string? User { get; init; }
    // An iCal feed (no username): read-only.
    public bool ReadOnly { get; init; }
    public bool PasswordSet { get; init; }
    public bool Unreadable { get; init; }
}

// #697: GET/POST /proactive/settings response and models.
internal sealed class ManaProactiveSettings
{
    public bool Ok { get; init; }
    public ManaQuietHoursSettings QuietHours { get; init; } = new();
    public bool InQuietHours { get; init; }
    public long? SnoozedUntil { get; init; }
    public IReadOnlyList<string> Muted { get; init; } = Array.Empty<string>();
    public bool Away { get; init; }
    public ManaLastRemark? LastRemark { get; init; }
    public Dictionary<string, ManaLearnedReason> Learned { get; init; } = new();
}

internal sealed class ManaQuietHoursSettings
{
    public bool Enabled { get; init; }
    public string Start { get; init; } = "01:00";
    public string End { get; init; } = "09:00";
}

internal sealed class ManaLastRemark
{
    public string? Reason { get; init; }
    public string? Title { get; init; }
    public string? Text { get; init; }
    public long? At { get; init; }
}

internal sealed class ManaLearnedReason
{
    public double Score { get; init; }
    public double Multiplier { get; init; }
}

