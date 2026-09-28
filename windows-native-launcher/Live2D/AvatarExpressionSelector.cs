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
    public static string? SelectExpressionName(
        AvatarState state,
        IEnumerable<string> availableExpressionNames,
        string? preferredName = null,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? overrides = null)
    {
        var names = availableExpressionNames as IReadOnlyList<string> ?? [.. availableExpressionNames];
        IEnumerable<string> exact = overrides is not null && overrides.TryGetValue(state.ToString().ToLowerInvariant(), out var custom) ? custom : [];
        if (!string.IsNullOrWhiteSpace(preferredName))
        {
            exact = exact.Prepend(preferredName.Trim());
        }
        foreach (var wanted in exact)
        {
            foreach (var name in names)
            {
                if (string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase))
                {
                    return name;
                }
            }
        }

        if (!StateKeywords.TryGetValue(state, out var keywords))
        {
            return null;
        }

        foreach (var keyword in keywords)
        {
            foreach (var name in names)
            {
                if (name.Contains(keyword, StringComparison.OrdinalIgnoreCase))
                {
                    return name;
                }
            }
        }
        return null;
    }
}
