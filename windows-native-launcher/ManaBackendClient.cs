using System;
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
    public async IAsyncEnumerable<ReplyStreamEvent> ReplyStreamAsync(string text, string? sessionId = null, string screenText = "", string? image = null)
    {
        var payload = (sessionId, image) switch
        {
            (null, null) => JsonSerializer.Serialize(new { text, screenText }),
            (not null, null) => JsonSerializer.Serialize(new { text, sessionId, screenText }),
            (null, not null) => JsonSerializer.Serialize(new { text, screenText, image }),
            (not null, not null) => JsonSerializer.Serialize(new { text, sessionId, screenText, image }),
        };
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

        return new ManaModelStatus { ActiveProfile = activeProfile, Profiles = profiles };
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

    // #529: requires an admin bearer token only when node-bot has
    // MANA_ADMIN_SECRET configured -- unset (the common local-only case
    // this launcher otherwise assumes throughout) allows every call here
    // through with no auth header, matching checkAdminAuth's own "no
    // secret configured -> allow" rule. No settings UI exists yet to
    // enter a token if one IS configured; that case surfaces as a 401
    // EnsureSuccessStatusCode throws, same as any other unexpected
    // status this client doesn't special-case.
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

// #527: GET /models/status.
internal sealed class ManaModelStatus
{
    public string? ActiveProfile { get; init; }
    public IReadOnlyDictionary<string, ManaModelProfile> Profiles { get; init; } = new Dictionary<string, ManaModelProfile>();
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
    public string? UpdatedAt { get; init; }
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

// #529: GET /approvals/pending.
internal sealed class ManaPendingApproval
{
    public string Id { get; init; } = "";
    public string ActionType { get; init; } = "";
    public string Summary { get; init; } = "";
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
