namespace Mana.NativeLauncher.Live2D;

// #342 follow-up: fills a real gap confirmed in AvatarOverlayForm -- when
// no authored .motion3.json idle clip is configured (or fails to load),
// `idleMotion` is null and RenderFrame's `idleMotion?.ApplyTo(...)` is a
// no-op, so the avatar has zero idle movement at all. Rather than
// requiring an artist-authored clip, this drives every one of the
// model's own parameters toward a new randomized target on its own
// independent timer, easing between them so the avatar reads as
// continuously, subtly alive instead of frozen. Same `ApplyTo(model,
// timeSeconds)` shape as CubismMotionFile, so it's a drop-in alternative
// base layer at the exact same call site -- expression/lip-sync still
// override it afterward exactly as they already override an authored
// idle clip (see AvatarOverlayForm.RenderFrame's layering comment).
internal sealed class ProceduralIdleMotion
{
    // How far each parameter is allowed to wander from its own default
    // value, as a fraction of its [min, max] range. Deliberately subtle --
    // this is meant to read as "breathing/alive," not as an exaggerated
    // expression. An authored .motion3.json idle clip (still preferred
    // when one exists -- see the call site) can be far more deliberate
    // than this ever tries to be.
    private const float AmplitudeFraction = 0.12f;
    private const float MinSegmentSeconds = 2.5f;
    private const float MaxSegmentSeconds = 5.5f;

    private sealed class ParameterState
    {
        public required float Center { get; init; }
        public required float Amplitude { get; init; }
        public required float Min { get; init; }
        public required float Max { get; init; }
        public float FromValue;
        public float ToValue;
        public float SegmentStartSeconds;
        public float SegmentDurationSeconds;
    }

    private readonly Dictionary<string, ParameterState> states = [];
    private readonly Random random;

    // seed: null (every real call site) uses genuine randomness. Tests
    // pass a fixed seed so retarget timing/values are reproducible.
    public ProceduralIdleMotion(int? seed = null)
    {
        random = seed is { } s ? new Random(s) : new Random();
    }

    public void ApplyTo(CubismModel model, float timeSeconds)
    {
        foreach (var id in model.ParameterIds)
        {
            if (!states.TryGetValue(id, out var state))
            {
                var min = model.GetParameterMinValue(id);
                var max = model.GetParameterMaxValue(id);
                var range = max - min;
                if (range <= 0)
                {
                    continue; // fixed/degenerate parameter -- nothing to animate
                }
                state = new ParameterState
                {
                    Center = model.GetParameterDefaultValue(id),
                    Amplitude = range * AmplitudeFraction,
                    Min = min,
                    Max = max,
                };
                state.FromValue = state.Center;
                state.ToValue = NextTarget(state);
                state.SegmentStartSeconds = timeSeconds;
                state.SegmentDurationSeconds = NextSegmentDuration();
                states[id] = state;
            }

            var elapsed = timeSeconds - state.SegmentStartSeconds;
            if (elapsed >= state.SegmentDurationSeconds)
            {
                state.FromValue = state.ToValue;
                state.ToValue = NextTarget(state);
                state.SegmentStartSeconds = timeSeconds;
                state.SegmentDurationSeconds = NextSegmentDuration();
                elapsed = 0f;
            }

            var ratio = state.SegmentDurationSeconds > 0 ? elapsed / state.SegmentDurationSeconds : 1f;
            // A half sine-wave from 0 to 1, i.e. ease-in-ease-out --
            // segments chain together with no velocity discontinuity at
            // each retarget, unlike a linear ramp.
            var eased = (1f - MathF.Cos(ratio * MathF.PI)) / 2f;
            model.SetParameterValue(id, state.FromValue + ((state.ToValue - state.FromValue) * eased));
        }
    }

    private float NextTarget(ParameterState state)
    {
        // Center +/- Amplitude alone can overshoot [Min, Max] whenever a
        // parameter's default sits near (or at) one edge of its range --
        // e.g. an eye-smile parameter that defaults to 0 (not smiling) in
        // a [0, 1] range: unclamped, roughly half of all random targets
        // would land below 0. Confirmed as a real failure, not a
        // hypothetical one, via ApplyTo_NeverExceedsTheParametersOwnDeclaredRange
        // against this project's own test model before this clamp existed.
        var target = state.Center + (((float)random.NextDouble() * 2f) - 1f) * state.Amplitude;
        return Math.Clamp(target, state.Min, state.Max);
    }

    private float NextSegmentDuration() =>
        MinSegmentSeconds + ((float)random.NextDouble() * (MaxSegmentSeconds - MinSegmentSeconds));
}
