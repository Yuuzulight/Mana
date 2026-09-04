using System;
using System.Collections.Generic;

namespace Mana.NativeLauncher;

// #524: which tray-notifier payload types should surface as a proactive
// Windows toast, kept separate from TrayNotificationClient's WebSocket/
// toast wiring so it's testable without either -- same pure-logic split
// windows-launcher/proactive-notifications.js already uses. "doctor" is
// deliberately excluded, matching that reference: it's a different,
// non-proactive status surface (this issue's own scope note), not
// something worth re-toasting on every check.
internal static class ProactiveToastFilter
{
    private static readonly HashSet<string> ProactiveTypes = new(StringComparer.Ordinal)
    {
        "dream",
        "cron",
        "research",
    };

    public static bool IsProactiveToast(string? type) => type is not null && ProactiveTypes.Contains(type);
}
