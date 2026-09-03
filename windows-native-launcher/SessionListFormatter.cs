using System;
using System.Globalization;

namespace Mana.NativeLauncher;

// #520: ports session-sidebar.js's formatSessionDate -- pure, so it's
// testable without a Form. Returns "" for anything unparseable, matching
// the reference's own try/catch-and-return-empty-string behavior.
internal static class SessionListFormatter
{
    // Ports session-sidebar.js's renderSessionList: session.name || session.sessionId.
    public static string FormatDisplayName(ManaSession session) =>
        string.IsNullOrEmpty(session.Name) ? session.SessionId : session.Name;

    public static string FormatUpdatedAt(string? iso)
    {
        if (string.IsNullOrEmpty(iso))
        {
            return "";
        }

        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            return "";
        }

        return parsed.ToLocalTime().ToString("MMM d, h:mm tt", CultureInfo.InvariantCulture);
    }
}
