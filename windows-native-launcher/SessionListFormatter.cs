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

    // The sidebar's time under each chat, as in the #652 mockup: "just now",
    // "5 min ago", "2 h ago" (today), "yesterday", the weekday within a
    // week ("Sat"), then the date. FormatUpdatedAt's full time is its tooltip.
    public static string FormatRelative(string? iso, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(iso) || !DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            return "";
        }
        var age = now - parsed;
        var day = parsed.ToLocalTime().Date;
        var today = now.ToLocalTime().Date;
        if (age < TimeSpan.FromMinutes(1))
        {
            return "just now"; // also a clock a little ahead of this one
        }
        if (age < TimeSpan.FromHours(1))
        {
            return $"{(int)age.TotalMinutes} min ago";
        }
        if (day == today)
        {
            return $"{(int)age.TotalHours} h ago";
        }
        if (day == today.AddDays(-1))
        {
            return "yesterday";
        }
        if (day > today.AddDays(-7))
        {
            return day.ToString("ddd", CultureInfo.InvariantCulture);
        }
        return day.ToString(day.Year == today.Year ? "MMM d" : "MMM d, yyyy", CultureInfo.InvariantCulture);
    }

    // #687: the sidebar's search box -- a case-insensitive title match, like
    // Electron's sidebar filter. Blank shows everything.
    public static bool MatchesSearch(ManaSession session, string query) =>
        string.IsNullOrWhiteSpace(query) || FormatDisplayName(session).Contains(query.Trim(), StringComparison.OrdinalIgnoreCase);

    // #687: a stored turn's time, for AutoSession.Restore; MinValue when it
    // has none, so a restored auto session rotates on its next turn.
    public static DateTime ParseTurnTime(string? iso) =>
        DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed) ? parsed.UtcDateTime : DateTime.MinValue;
}
