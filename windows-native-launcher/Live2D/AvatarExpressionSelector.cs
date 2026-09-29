namespace Mana.NativeLauncher.Live2D;

// #514: picks which of a model's own declared expression names best
// matches a mood state, via keyword substring matching -- ported from
// windows-launcher/avatar/live2d-logic.js's STATE_EXPRESSION_PREFERENCES.
// Models name their expressions freely (an artist's own choice, not a
// fixed vocabulary Cubism defines), so this can only ever be a best-effort
// match against whatever a given model actually ships, falling back to
// "no match" (no expression change) rather than guessing wrong.
internal static class AvatarExpressionSelector
{
    private static readonly Dictionary<AvatarState, string[]> StateKeywords = new()
    {
        [AvatarState.Excited] = ["happy", "joy", "smile", "excited", "fun"],
        [AvatarState.Angry] = ["angry", "mad", "grumpy", "annoyed"],
        [AvatarState.Sad] = ["sad", "cry", "sniff", "tears", "upset"],
        [AvatarState.Disgusted] = ["disgusted", "disgust", "white-eyes", "dead-eyes", "blank"],
        // #661: activity states.
        [AvatarState.Thinking] = ["think", "ponder", "hmm", "curious"],
        [AvatarState.Working] = ["focus", "serious", "determined"],
        [AvatarState.Waiting] = ["question", "curious", "wonder"],
        [AvatarState.Done] = ["smile", "happy"],
        [AvatarState.Dreaming] = ["sleep", "dream", "doze"],
        // Idle/Talking intentionally have no entry -- matches live2d-logic.js's
        // own idle:[]/talking:[] (no preference, no expression change).
    };

    // Returns the first available expression name whose own name contains
    // one of state's keywords (case-insensitive, first-keyword-then-
    // first-match order), or null if state has no keyword table entry or
    // none of the available names match any keyword.
    // #681: preferredName is the model's own expression__set choice for
    // this reply (the reply's `expression` field). Tried first, as an exact
    // case-insensitive name match like live2d-logic.js's expressionForState/
    // pickByPreference; no match falls through to the state keywords.
    // #683: overrides is mana-avatar.json stateExpressions /
    // MANA_LIVE2D_STATE_EXPRESSIONS (lower-case state name -> exact names),
    // tried after the preferred name and before the keywords.
    // #623: emotion is the sentence's emotion tag (node-bot/utils/
    // emotion-tags.js). The same stateExpressions map takes tags as keys
    // ("wink": "f05"), so a new avatar maps its faces in mana-avatar.json
    // alone; an unmapped tag tries the model's names containing the tag
    // itself, then falls back to the state as before.
    public static string? SelectExpressionName(
        AvatarState state,
        IEnumerable<string> availableExpressionNames,
        string? preferredName = null,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? overrides = null,
        string? emotion = null)
    {
        var names = availableExpressionNames as IReadOnlyList<string> ?? [.. availableExpressionNames];
        IReadOnlyList<string> Custom(string? key) =>
            key is not null && overrides is not null && overrides.TryGetValue(key, out var custom) ? custom : [];
        string? Exact(IEnumerable<string> wanted) =>
            wanted.SelectMany(w => names.Where(name => string.Equals(name, w, StringComparison.OrdinalIgnoreCase))).FirstOrDefault();
        string? Containing(IEnumerable<string> keywords) =>
            keywords.SelectMany(k => names.Where(name => name.Contains(k, StringComparison.OrdinalIgnoreCase))).FirstOrDefault();

        var tag = string.IsNullOrWhiteSpace(emotion) ? null : emotion.Trim().ToLowerInvariant();
        IEnumerable<string> preferred = string.IsNullOrWhiteSpace(preferredName) ? [] : [preferredName.Trim()];
        return Exact(preferred.Concat(Custom(tag)))
            ?? (tag is null ? null : Containing([tag]))
            ?? Exact(Custom(state.ToString().ToLowerInvariant()))
            ?? (StateKeywords.TryGetValue(state, out var keywords) ? Containing(keywords) : null);
    }
}
