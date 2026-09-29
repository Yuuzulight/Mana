using System;

namespace Mana.NativeLauncher;

// Q62: node-bot only saves a turn to memory when it carries a sessionId, so
// VoiceLoop starts a session itself when a turn has none (fresh launch) or
// when the session it started itself has sat idle for 4 hours. A session
// the user picked or created in the session list is never rotated -- it
// stays until they switch.
internal static class AutoSession
{
    public static readonly TimeSpan IdleLimit = TimeSpan.FromHours(4);

    public static bool NeedsNew(string? currentId, bool currentIsAuto, DateTime lastTurnAt, DateTime now) =>
        currentId is null || (currentIsAuto && now - lastTurnAt >= IdleLimit);
}
