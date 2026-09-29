using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// #683: per-model avatar tuning -- the same mana-avatar.json (next to the
// .model3.json, then in the model directory) and MANA_LIVE2D_* env vars the
// Electron launcher reads (windows-launcher/avatar/live2d-avatar.js ~51-124
// and live2d-logic.js normalizeAvatarConfig/mergeStateMappings). Priority is
// env var > mana-avatar.json > default, and every field is optional.
//
// Only the knobs the native renderer has a use for are read: the fixed-iris
// ones (eyeOpenScale/smileParams/browParams) would override expressions the
// native avatar honours (#681), mouthForm* has no native counterpart
// (native drives mouth form from visemes), and zoomFractions isn't read
// (the chat window's framing, #685, uses Electron's default fractions).
internal sealed class AvatarConfig
{
    public const string FileName = "mana-avatar.json";

    public sealed record RandomMotion(string Group, int MinIntervalMs, int MaxIntervalMs, IReadOnlyList<string> States);

    // State name (lower-case AvatarState name) -> candidate names, tried
    // before the built-in preferences. Env candidates come first.
    // StateExpressions also takes #623 emotion tags as keys ("wink").
    public IReadOnlyDictionary<string, IReadOnlyList<string>> StateMotions { get; private init; } = new Dictionary<string, IReadOnlyList<string>>();
    public IReadOnlyDictionary<string, IReadOnlyList<string>> StateExpressions { get; private init; } = new Dictionary<string, IReadOnlyList<string>>();
    public IReadOnlyList<RandomMotion> RandomMotions { get; private init; } = [];
    public string MouthParam { get; private init; } = "ParamMouthOpenY";
    public float MouthGain { get; private init; } = 18f;
    // Q6: gain 18 opens wide on loud syllables; this caps it (0..1).
    public float MouthMaxOpen { get; private init; } = 0.8f;
    // Backfill for a model3.json with no EyeBlink group; [] disables it.
    public IReadOnlyList<string> EyeBlinkParams { get; private init; } = ["ParamEyeLOpen", "ParamEyeROpen"];
    // Q6: the head roll sway's peak -- normally, and while she's animated
    // (an excited/happy sentence).
    public float IdleTiltDeg { get; private init; } = AvatarGaze.DefaultTiltDegrees;
    public float AnimatedTiltDeg { get; private init; } = AvatarGaze.DefaultAnimatedTiltDegrees;
    public float IdleMaxPitchDeg { get; private init; } = AvatarGaze.DefaultMaxPitchDegrees;
    public float IdleGazeDeg { get; private init; } = AvatarGaze.DefaultGazeDegrees;
    public float IdleGazePeriodMs { get; private init; } = AvatarGaze.DefaultGazePeriodMs;

    // Never throws: an unreadable/invalid file is skipped (next candidate,
    // then defaults), like Electron's loadAvatarConfig.
    public static AvatarConfig Load(string model3JsonPath, string modelDirectory, Func<string, string?> env)
    {
        foreach (var candidate in new[] { Path.Combine(Path.GetDirectoryName(model3JsonPath) ?? "", FileName), Path.Combine(modelDirectory, FileName) })
        {
            try
            {
                if (File.Exists(candidate))
                {
                    var config = Parse(File.ReadAllText(candidate), env);
                    Console.WriteLine($"AvatarConfig: loaded {candidate}");
                    return config;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                Console.WriteLine($"AvatarConfig: ignoring invalid {candidate}: {ex.Message}");
            }
        }
        return Parse(null, env);
    }

    // json: the mana-avatar.json text, or null for none. Throws JsonException
    // on malformed JSON (Load skips that file); wrong-typed fields just fall
    // back to their default.
    public static AvatarConfig Parse(string? json, Func<string, string?> env)
    {
        using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        var root = document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement : default;
        JsonElement Field(string name) =>
            root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value) ? value : default;

        var defaults = new AvatarConfig();
        return new AvatarConfig
        {
            StateMotions = MergeStateMappings(ParseStateMappingEnv(env("MANA_LIVE2D_STATE_MOTIONS")), NormalizeStateMapping(Field("stateMotions"))),
            StateExpressions = MergeStateMappings(ParseStateMappingEnv(env("MANA_LIVE2D_STATE_EXPRESSIONS")), NormalizeStateMapping(Field("stateExpressions"))),
            RandomMotions = ParseRandomMotions(Field("randomMotions")),
            MouthParam = NonEmpty(env("MANA_LIVE2D_MOUTH_PARAM"))
                ?? (Field("mouthParam") is { ValueKind: JsonValueKind.String } mouth && NonEmpty(mouth.GetString()) is { } id ? id : defaults.MouthParam),
            MouthGain = Number(env("MANA_LIVE2D_MOUTH_GAIN"), Field("mouthGain"), defaults.MouthGain),
            MouthMaxOpen = Number(env("MANA_LIVE2D_MOUTH_MAX_OPEN"), Field("mouthMaxOpen"), defaults.MouthMaxOpen),
            EyeBlinkParams = env("MANA_LIVE2D_EYE_BLINK_PARAMS") is { } blinkEnv
                ? blinkEnv.Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).ToArray()
                : Field("eyeBlinkParams") is { ValueKind: JsonValueKind.Array } blinkList
                    ? blinkList.EnumerateArray().Select(Text).Where(p => p.Length > 0).ToArray()
                    : defaults.EyeBlinkParams,
            IdleTiltDeg = Number(env("MANA_LIVE2D_IDLE_TILT_DEG"), Field("idleTiltDeg"), defaults.IdleTiltDeg),
            AnimatedTiltDeg = Number(env("MANA_LIVE2D_ANIMATED_TILT_DEG"), Field("animatedTiltDeg"), defaults.AnimatedTiltDeg),
            IdleMaxPitchDeg = Number(env("MANA_LIVE2D_IDLE_MAX_PITCH_DEG"), Field("idleMaxPitchDeg"), defaults.IdleMaxPitchDeg),
            IdleGazeDeg = Number(env("MANA_LIVE2D_IDLE_GAZE_DEG"), Field("idleGazeDeg"), defaults.IdleGazeDeg),
            IdleGazePeriodMs = Number(env("MANA_LIVE2D_IDLE_GAZE_PERIOD_MS"), Field("idleGazePeriodMs"), defaults.IdleGazePeriodMs),
        };
    }

    // {"talking":"Scene1","excited":["a","b"]} -> {talking:[Scene1], ...};
    // anything else -> empty. Keys are lower-cased.
    internal static Dictionary<string, IReadOnlyList<string>> NormalizeStateMapping(JsonElement mapping)
    {
        var result = new Dictionary<string, IReadOnlyList<string>>();
        if (mapping.ValueKind != JsonValueKind.Object)
        {
            return result;
        }
        foreach (var property in mapping.EnumerateObject())
        {
            var names = (property.Value.ValueKind == JsonValueKind.Array ? property.Value.EnumerateArray().ToArray() : [property.Value])
                .Select(Text)
                .Where(name => name.Length > 0)
                .ToArray();
            if (names.Length > 0)
            {
                result[property.Name.ToLowerInvariant()] = names;
            }
        }
        return result;
    }

    private static Dictionary<string, IReadOnlyList<string>> ParseStateMappingEnv(string? json)
    {
        try
        {
            using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            return NormalizeStateMapping(document.RootElement);
        }
        catch (JsonException)
        {
            return [];
        }
    }

    // Env candidates first, then the file's for the same state.
    private static Dictionary<string, IReadOnlyList<string>> MergeStateMappings(
        Dictionary<string, IReadOnlyList<string>> envOverrides,
        Dictionary<string, IReadOnlyList<string>> configMapping)
    {
        foreach (var (state, names) in envOverrides)
        {
            configMapping[state] = configMapping.TryGetValue(state, out var existing) ? [.. names, .. existing] : names;
        }
        return configMapping;
    }

    // normalizeAvatarConfig's randomMotions: min interval >= 5s (default
    // 2min), max >= min (default 4x min), states default to ["idle"].
    private static RandomMotion[] ParseRandomMotions(JsonElement entries)
    {
        if (entries.ValueKind != JsonValueKind.Array)
        {
            return [];
        }
        var result = new List<RandomMotion>();
        foreach (var entry in entries.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object || !entry.TryGetProperty("group", out var groupElement) || Text(groupElement) is not { Length: > 0 } group)
            {
                continue;
            }
            var min = (int)Math.Clamp(NonZeroOr(entry, "minIntervalMs", 120000), 5000, int.MaxValue);
            var max = (int)Math.Clamp(NonZeroOr(entry, "maxIntervalMs", min * 4.0), min, int.MaxValue);
            var states = entry.TryGetProperty("states", out var statesElement) && statesElement.ValueKind == JsonValueKind.Array
                ? statesElement.EnumerateArray().Select(Text).Where(s => s.Length > 0).Select(s => s.ToLowerInvariant()).ToArray()
                : [];
            result.Add(new RandomMotion(group, min, max, states.Length > 0 ? states : ["idle"]));
        }
        return [.. result];
    }

    // JS `Number(x) || fallback`: a missing, non-numeric or zero value
    // falls back.
    private static double NonZeroOr(JsonElement entry, string name, double fallback) =>
        entry.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.GetDouble() != 0
            ? value.GetDouble()
            : fallback;

    // numberOrDefault: env wins when it parses; an explicit 0 is kept.
    private static float Number(string? envValue, JsonElement field, float fallback)
    {
        if (envValue is not null && float.TryParse(envValue, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var fromEnv) && float.IsFinite(fromEnv))
        {
            return fromEnv;
        }
        return field.ValueKind == JsonValueKind.Number && field.TryGetSingle(out var fromFile) && float.IsFinite(fromFile)
            ? fromFile
            : fallback;
    }

    private static string Text(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString() ?? "",
        JsonValueKind.Number => element.GetRawText(),
        _ => "",
    };

    private static string? NonEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;
}
