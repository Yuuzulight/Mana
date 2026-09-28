namespace Mana.NativeLauncher.Live2D;

// #683: per-mood motion groups and random ambient motions, ported from
// windows-launcher/avatar/live2d-avatar.js ~447-526 (motionGroupForState,
// the auto-looping "idle" group pointed at the current state's group,
// FORCE priority for non-idle states, randomMotions).
//
// - Each state plays its own motion group (picked by AvatarConfig
//   stateMotions first, then the built-in names); a state with none keeps
//   the idle group going rather than freezing.
// - A clip plays once, then a random clip from the current state's group
//   follows (so an Idle group with 3 variations cycles through them, and
//   an angry reaction keeps looping for as long as she's angry).
// - Entering a non-idle state cuts in right away (Electron's FORCE);
//   returning to idle waits for the current clip to finish (IDLE priority).
// - Every switch crossfades over the incoming clip's FadeInTime (default
//   0.5s), so nothing snaps.
// - randomMotions fire at their random interval while the current state is
//   one of theirs, play once, then hand back to the state's group.
//
// Scheduling is pure (Update/SetState only move clips around); Apply is
// the thin part that writes the clips into the model.
internal sealed class AvatarMotionPlayer
{
    public const float DefaultFadeSeconds = 0.5f;

    // live2d-logic.js's STATE_MOTION_PREFERENCES.
    private static readonly Dictionary<AvatarState, string[]> StatePreferences = new()
    {
        [AvatarState.Idle] = ["Idle", "idle"],
        [AvatarState.Talking] = ["Talk", "Speak", "Speaking", "TapBody", "Tap"],
        [AvatarState.Excited] = ["Happy", "Joy", "Excited", "Tap", "TapBody"],
        [AvatarState.Angry] = ["Angry", "Mad", "Shake", "FlickHead"],
        [AvatarState.Sad] = ["Sad", "Cry", "Down", "Upset"],
        [AvatarState.Disgusted] = ["Disgusted", "Disgust", "Recoil", "Dislike"],
    };

    private sealed record Clip(CubismMotionFile Motion, string Group, double StartSeconds);

    private readonly IReadOnlyDictionary<string, IReadOnlyList<CubismMotionFile>> groups;
    private readonly IReadOnlyDictionary<string, IReadOnlyList<string>> stateOverrides;
    private readonly IReadOnlyList<AvatarConfig.RandomMotion> randomMotions;
    private readonly double[] nextRandomAtSeconds;
    private readonly Random random;

    private AvatarState state = AvatarState.Idle;
    private string? stateGroup;
    private Clip? current;
    private Clip? previous;
    private double fadeStartSeconds;
    private float fadeSeconds;

    public AvatarMotionPlayer(
        IReadOnlyDictionary<string, IReadOnlyList<CubismMotionFile>> groups,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? stateOverrides = null,
        IReadOnlyList<AvatarConfig.RandomMotion>? randomMotions = null,
        int? seed = null)
    {
        this.groups = groups;
        this.stateOverrides = stateOverrides ?? new Dictionary<string, IReadOnlyList<string>>();
        this.randomMotions = randomMotions ?? [];
        nextRandomAtSeconds = Enumerable.Repeat(double.NaN, this.randomMotions.Count).ToArray();
        random = seed is { } s ? new Random(s) : new Random();
        IdleGroup = GroupForState(AvatarState.Idle, groups.Keys, this.stateOverrides);
        stateGroup = IdleGroup;
    }

    // The group Idle resolves to, or null when the model has none (the
    // caller then keeps its procedural idle as the base layer).
    public string? IdleGroup { get; }
    public string? CurrentGroup => current?.Group;
    public CubismMotionFile? CurrentMotion => current?.Motion;
    public CubismMotionFile? PreviousMotion => previous?.Motion;

    // Exact, case-insensitive match against the model's own group names:
    // overrides for this state first, then the built-in preferences.
    public static string? GroupForState(
        AvatarState state,
        IEnumerable<string> availableGroups,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? overrides = null)
    {
        var names = availableGroups as IReadOnlyCollection<string> ?? [.. availableGroups];
        IEnumerable<string> preferences = StatePreferences.TryGetValue(state, out var builtIn) ? builtIn : [];
        if (overrides is not null && overrides.TryGetValue(state.ToString().ToLowerInvariant(), out var custom))
        {
            preferences = custom.Concat(preferences);
        }
        foreach (var preference in preferences)
        {
            foreach (var name in names)
            {
                if (string.Equals(name, preference, StringComparison.OrdinalIgnoreCase))
                {
                    return name;
                }
            }
        }
        return null;
    }

    public void SetState(AvatarState newState, double nowSeconds)
    {
        state = newState;
        var group = GroupForState(newState, groups.Keys, stateOverrides) ?? IdleGroup;
        if (group == stateGroup)
        {
            return; // same loop -- don't restart it
        }
        stateGroup = group;
        if (newState != AvatarState.Idle)
        {
            Play(group, nowSeconds);
        }
    }

    public void Update(double nowSeconds)
    {
        for (var i = 0; i < randomMotions.Count; i++)
        {
            var entry = randomMotions[i];
            if (double.IsNaN(nextRandomAtSeconds[i]))
            {
                nextRandomAtSeconds[i] = nowSeconds + NextRandomDelaySeconds(entry);
                continue;
            }
            if (nowSeconds < nextRandomAtSeconds[i])
            {
                continue;
            }
            nextRandomAtSeconds[i] = nowSeconds + NextRandomDelaySeconds(entry);
            if (entry.States.Contains(StateName(state)) && FindGroup(entry.Group) is { } randomGroup)
            {
                Play(randomGroup, nowSeconds);
            }
        }

        if (current is null ? stateGroup is not null : nowSeconds - current.StartSeconds >= current.Motion.Duration)
        {
            Play(stateGroup, nowSeconds);
        }
        if (previous is not null && nowSeconds - fadeStartSeconds >= fadeSeconds)
        {
            previous = null;
        }
    }

    // Crossfade weight of the incoming clip, eased like Cubism's own fade.
    public float FadeWeight(double nowSeconds)
    {
        if (fadeSeconds <= 0)
        {
            return 1f;
        }
        var linear = (float)Math.Clamp((nowSeconds - fadeStartSeconds) / fadeSeconds, 0, 1);
        return 0.5f - (0.5f * MathF.Cos(linear * MathF.PI));
    }

    public void Apply(CubismModel model, double nowSeconds)
    {
        var weight = FadeWeight(nowSeconds);
        if (previous is not null)
        {
            // Fading out to nothing (the procedural base): its own weight
            // drops; fading into another clip: that clip blends over it.
            previous.Motion.ApplyTo(model, (float)(nowSeconds - previous.StartSeconds), current is null ? 1f - weight : 1f);
        }
        current?.Motion.ApplyTo(model, (float)(nowSeconds - current.StartSeconds), weight);
    }

    // group null = fade out to the procedural base (no idle group).
    private void Play(string? group, double nowSeconds)
    {
        CubismMotionFile? motion = null;
        if (group is not null)
        {
            if (!groups.TryGetValue(group, out var clips) || clips.Count == 0)
            {
                return;
            }
            motion = clips[random.Next(clips.Count)];
            if (motion.Duration <= 0)
            {
                return; // unplayable clip -- keep whatever is playing
            }
        }
        else if (current is null)
        {
            return;
        }
        previous = current;
        current = motion is null ? null : new Clip(motion, group!, nowSeconds);
        fadeStartSeconds = nowSeconds;
        fadeSeconds = motion?.FadeInTime ?? DefaultFadeSeconds;
    }

    private string? FindGroup(string name) =>
        groups.Keys.FirstOrDefault(key => string.Equals(key, name, StringComparison.OrdinalIgnoreCase));

    private double NextRandomDelaySeconds(AvatarConfig.RandomMotion entry) =>
        (entry.MinIntervalMs + ((entry.MaxIntervalMs - entry.MinIntervalMs) * random.NextDouble())) / 1000.0;

    private static string StateName(AvatarState state) => state.ToString().ToLowerInvariant();
}
