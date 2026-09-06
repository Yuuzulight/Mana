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
    // adminToken means no Authorization header, matching every admin-gated
    // route's own "no secret configured -> allow" behavior. Setting the
    // header once here via DefaultRequestHeaders (rather than adding it to
    // every individual request below) covers every current and future
    // method in this file for free.
    public ManaBackendClient(HttpMessageHandler? handler = null, string? baseUrl = null, string? adminToken = null)
    {
        http = handler is null
            ? new HttpClient()
            : new HttpClient(handler);
        http.BaseAddress = new System.Uri(baseUrl ?? "http://127.0.0.1:5005");
        if (!string.IsNullOrEmpty(adminToken))
        {
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        }
    }

    // #575: extended with uptime/config/operations -- operations is a
    // free-form dictionary (server.js's perfMetrics.operations: whatever
    // shape each operation last logged, e.g. reply_token_usage's
    // {lastTokens,session,updatedAt}), so each entry's value is kept as
    // its own compact JSON string rather than modeled per-operation; the
    // Perf tab just displays it, it doesn't need to parse it further.
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

        var operations = new Dictionary<string, string>();
        if (root.TryGetProperty("operations", out var operationsElement) && operationsElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in operationsElement.EnumerateObject())
            {
                operations[property.Name] = property.Value.GetRawText();
            }
        }

        return new ManaPerformanceStatus
        {
            TotalMemoryMb = process.GetProperty("totalMemoryMb").GetInt32(),
            TtsProvider = config.GetProperty("ttsProvider").GetString() ?? "unknown",
            GamingAppRunning = gaming.GetProperty("gamingAppRunning").GetBoolean(),
            UptimeSeconds = root.TryGetProperty("uptimeSeconds", out var uptimeEl) ? uptimeEl.GetInt64() : 0,
            WhisperThreads = config.TryGetProperty("whisperThreads", out var whisperEl) ? whisperEl.GetInt32() : 0,
            LlamaThreads = config.TryGetProperty("llamaThreads", out var llamaThreadsEl) ? llamaThreadsEl.GetInt32() : 0,
            LlamaMaxTokens = config.TryGetProperty("llamaMaxTokens", out var llamaMaxEl) ? llamaMaxEl.GetInt32() : 0,
            ScreenContextEnabled = config.TryGetProperty("screenContextEnabled", out var screenEl) && screenEl.GetBoolean(),
            Operations = operations,
        };
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
    public async IAsyncEnumerable<ReplyStreamEvent> ReplyStreamAsync(string text, string? sessionId = null, string screenText = "", string? image = null, IReadOnlyList<string>? images = null)
    {
        var fields = new Dictionary<string, object?> { ["text"] = text, ["screenText"] = screenText };
        if (sessionId is not null)
        {
            fields["sessionId"] = sessionId;
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
        var vision = root.TryGetProperty("vision", out var visionEl) ? visionEl : default;

        return new ManaModelStatus
        {
            ActiveProfile = activeProfile,
            Profiles = profiles,
            SelectedModelPath = root.TryGetProperty("selectedModelPath", out var selectedEl) ? selectedEl.GetString() : null,
            BrainType = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("type", out var typeEl) ? typeEl.GetString() ?? "local" : "local",
            BrainBaseUrl = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("baseUrl", out var baseUrlEl) ? baseUrlEl.GetString() ?? "" : "",
            BrainModel = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("model", out var brainModelEl) ? brainModelEl.GetString() ?? "" : "",
            BrainHasApiKey = brain.ValueKind == JsonValueKind.Object && brain.TryGetProperty("hasApiKey", out var hasKeyEl) && hasKeyEl.GetBoolean(),
            VisionModelPath = vision.ValueKind == JsonValueKind.Object && vision.TryGetProperty("modelPath", out var visionModelEl) ? visionModelEl.GetString() ?? "" : "",
            VisionMmprojPath = vision.ValueKind == JsonValueKind.Object && vision.TryGetProperty("mmprojPath", out var mmprojEl) ? mmprojEl.GetString() ?? "" : "",
        };
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
                    SizeBytes = entry.TryGetProperty("sizeBytes", out var sizeEl) ? sizeEl.GetInt64() : 0,
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
    // exists for ChatLogPanel-style scrollback this modal doesn't need.
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
            foreach (var turnElement in turnsElement.EnumerateArray())
            {
                turns.Add(new ManaSessionTurn
                {
                    At = turnElement.TryGetProperty("at", out var atElement) ? atElement.GetString() : null,
                    User = turnElement.TryGetProperty("user", out var userElement) ? userElement.GetString() : null,
                    Assistant = turnElement.TryGetProperty("assistant", out var assistantElement) ? assistantElement.GetString() : null,
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

    // #529/#565: requires an admin bearer token only when node-bot has
    // MANA_ADMIN_SECRET configured -- unset (the common local-only case
    // this launcher otherwise assumes throughout) allows every call here
    // through with no auth header, matching checkAdminAuth's own "no
    // secret configured -> allow" rule. The Connection settings tab
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

    public async Task SetTtsOverrideAsync(string? provider)
    {
        var payload = JsonSerializer.Serialize(new { provider });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/tts/override", content);
        response.EnsureSuccessStatusCode();
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
    public async Task<bool> CreateSkillAsync(string name, string description, string body, string? category)
    {
        var payload = JsonSerializer.Serialize(new { name, description, body, category });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/skills", content);
        response.EnsureSuccessStatusCode();
        return response.StatusCode == System.Net.HttpStatusCode.Created;
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
    // against a separate ADMIN_TOKEN env var; if that's unset, it falls
    // back to localhost-only, which the common local-backend setup
    // satisfies with no token configured at all). expiresAt is a raw
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
    // requireAdmin) -- for the common local-backend case, requireAdmin's
    // own loopback check passes automatically, so no separate ADMIN_TOKEN
    // is needed on top of that key.
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

    // decision: "allow-once" | "always-allow" | "deny" -- node-bot
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
    // zed-integration.js's own listEditProposals. Admin-gated the same
    // lenient way as the already-shipped Memory Facts/Skills/Approvals
    // tabs (checkAdminAuth allows everything unless MANA_ADMIN_SECRET is
    // actually configured).
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
        };
    }

    // Does NOT call EnsureSuccessStatusCode -- a 400 (unknown hunk id,
    // proposal not pending, workspace file missing, etc.) comes back with
    // a fully-parseable {proposal:null, error} body the caller needs to
    // read, same reasoning as RestoreEditSnapshotAsync's own handling.
    public async Task<ManaProposalApproveResult> ApproveProposalAsync(string id, IReadOnlyList<string> acceptedHunkIds)
    {
        var payload = JsonSerializer.Serialize(new { acceptedHunkIds });
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
    // (checkAdminAuth) the same as the already-shipped Memory Facts/
    // Skills/Approvals tabs -- allowed unconditionally unless
    // MANA_ADMIN_SECRET is actually configured, same as those.
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

        return new ManaBrowserAutomationActivity { Log = log, ScreenshotBase64 = screenshotBase64 };
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
    public long UptimeSeconds { get; init; }
    public int WhisperThreads { get; init; }
    public int LlamaThreads { get; init; }
    public int LlamaMaxTokens { get; init; }
    public bool ScreenContextEnabled { get; init; }
    public IReadOnlyDictionary<string, string> Operations { get; init; } = new Dictionary<string, string>();
}

// #527/#572: GET /models/status.
internal sealed class ManaModelStatus
{
    public string? ActiveProfile { get; init; }
    public IReadOnlyDictionary<string, ManaModelProfile> Profiles { get; init; } = new Dictionary<string, ManaModelProfile>();
    public string? SelectedModelPath { get; init; }
    public string BrainType { get; init; } = "local";
    public string BrainBaseUrl { get; init; } = "";
    public string BrainModel { get; init; } = "";
    public bool BrainHasApiKey { get; init; }
    public string VisionModelPath { get; init; } = "";
    public string VisionMmprojPath { get; init; } = "";
}

// #572: one entry from GET /models/brain-providers.
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
    public string SessionId { get; init; } = "";
    public string? Name { get; init; }
    public string? Goal { get; init; }
    public string? UpdatedAt { get; init; }
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

internal sealed class ManaSessionTurn
{
    public string? At { get; init; }
    public string? User { get; init; }
    public string? Assistant { get; init; }
}

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
internal sealed class ManaPendingApproval
{
    public string Id { get; init; } = "";
    public string ActionType { get; init; } = "";
    public string Summary { get; init; } = "";
}

// #573: GET /presets.
internal sealed class ManaPreset
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Instructions { get; init; } = "";
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
    public string Type { get; init; } = "";
    public string? Text { get; init; }
    public string? Reply { get; init; }
    public bool Changed { get; init; }
    public string? Expression { get; init; }
    public string? Error { get; init; }
}

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
}

internal sealed class ManaBrowserAutomationLogEntry
{
    public string Action { get; init; } = "";
    public string Status { get; init; } = "";
    public string Summary { get; init; } = "";
    public string At { get; init; } = "";
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
