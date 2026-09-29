using System;

namespace Mana.NativeLauncher;

// Q62: node-bot only saves a turn to memory when it carries a sessionId, so
// a turn with none (fresh launch, or after the active session was deleted)
// starts a session here, and so does one whose auto-started session has sat
// idle for 4 hours. A session the user picked or created in the session list
// is never rotated -- it stays until they switch.
internal sealed class AutoSession
{
    public static readonly TimeSpan IdleLimit = TimeSpan.FromHours(4);

    private readonly object gate = new();
    private readonly Func<DateTime> utcNow;
    private volatile string? currentId;
    private string? autoId;
    private DateTime lastTurnAt;

    public AutoSession(Func<DateTime>? utcNow = null) => this.utcNow = utcNow ?? (() => DateTime.UtcNow);

    public string? CurrentId => currentId;

    // True while the current session is one this class started (so it rotates).
    public bool IsAuto
    {
        get
        {
            lock (gate)
            {
                return currentId is not null && currentId == autoId;
            }
        }
    }

    // #687: the session open at the last exit, reopened at launch. An
    // auto-started one still rotates after IdleLimit, counted from its last
    // stored turn. Ignored if a turn or a pick already set a session.
    public void Restore(string sessionId, bool auto, DateTime lastTurnAtUtc)
    {
        lock (gate)
        {
            if (currentId is not null)
            {
                return;
            }
            currentId = sessionId;
            autoId = auto ? sessionId : null;
            lastTurnAt = lastTurnAtUtc;
        }
    }

    // The session list's pick. Null leaves the next turn to auto-start one.
    public void Set(string? sessionId)
    {
        lock (gate)
        {
            autoId = null;
            currentId = sessionId;
        }
    }

    public string EnsureForTurn()
    {
        lock (gate)
        {
            var now = utcNow();
            if (currentId is null || (currentId == autoId && now - lastTurnAt >= IdleLimit))
            {
                autoId = Guid.NewGuid().ToString();
                currentId = autoId;
            }
            lastTurnAt = now;
            return currentId;
        }
    }
}
