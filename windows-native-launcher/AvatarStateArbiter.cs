namespace Mana.NativeLauncher;

// #661: decides which state the avatar shows when several are true at once
// -- she's speaking (Talking or a mood, from VoiceLoop), and/or thinking,
// running a tool, waiting on an approval, just finished, or dreaming.
// Each state has a priority and a minimum display time: a higher-priority
// state shows at once (speech always wins the moment audio starts), while a
// drop to a lower one waits until the current state has been up for its
// minimum. So a burst of quick tool calls reads as one "working" stretch
// instead of flickering between thinking and working.
internal sealed class AvatarStateArbiter
{
    public const double DoneSeconds = 1.2;

    private static readonly Dictionary<AvatarState, (int Priority, double MinSeconds)> Table = new()
    {
        [AvatarState.Idle] = (0, 0),
        // The mic being on is the backdrop: anything else she's doing shows
        // over it, and turning the mic off drops straight back to Idle.
        [AvatarState.Listening] = (1, 0),
        [AvatarState.Dreaming] = (2, 2.0),
        [AvatarState.Done] = (3, DoneSeconds),
        [AvatarState.Waiting] = (4, 1.5),
        [AvatarState.Thinking] = (5, 0.8),
        [AvatarState.Working] = (6, 1.0),
    };
    private const int SpeechPriority = 10;

    private readonly HashSet<AvatarState> active = [];
    private AvatarState speech = AvatarState.Idle;
    private double doneUntil = double.NegativeInfinity;
    private double shownSince;

    public AvatarState Shown { get; private set; } = AvatarState.Idle;

    // Talking and the moods (Excited, Sad, ...) are speech; Idle = not speaking.
    public static bool IsSpeech(AvatarState state) => !Table.ContainsKey(state);

    // VoiceLoop's talking/mood state (Idle once she stops).
    public void SetSpeech(AvatarState state) => speech = IsSpeech(state) ? state : AvatarState.Idle;

    // Thinking/Working/Waiting/Dreaming/Listening on or off (anything else is ignored).
    public void Set(AvatarState activity, bool on)
    {
        if (on && Table.ContainsKey(activity) && activity is not (AvatarState.Idle or AvatarState.Done))
        {
            active.Add(activity);
        }
        else
        {
            active.Remove(activity);
        }
    }

    // A short "done" beat at the end of a turn.
    public void PulseDone(double nowSeconds) => doneUntil = nowSeconds + DoneSeconds;

    // Returns true when Shown changed. Call on every input change and
    // periodically, so held states and the Done beat expire.
    public bool Resolve(double nowSeconds)
    {
        var desired = Desired(nowSeconds);
        if (desired == Shown)
        {
            return false;
        }
        var (shownPriority, shownMin) = PriorityAndMin(Shown);
        if (PriorityAndMin(desired).Priority < shownPriority && nowSeconds - shownSince < shownMin)
        {
            return false;
        }
        Shown = desired;
        shownSince = nowSeconds;
        return true;
    }

    private AvatarState Desired(double nowSeconds)
    {
        if (speech != AvatarState.Idle)
        {
            return speech;
        }
        var best = nowSeconds < doneUntil ? AvatarState.Done : AvatarState.Idle;
        foreach (var activity in active)
        {
            if (Table[activity].Priority > Table[best].Priority)
            {
                best = activity;
            }
        }
        return best;
    }

    private static (int Priority, double MinSeconds) PriorityAndMin(AvatarState state) =>
        Table.TryGetValue(state, out var entry) ? entry : (SpeechPriority, 0);
}
