using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace Mana.NativeLauncher;

// #1286 (part of #624): windows Mana never looks at. Checked before any
// UI-tree read, OCR or capture of the foreground window -- the ambient
// glance, a conversational screen read and the clip buffer all skip while
// one of these is in front. Fails closed: a title word that's only a
// false positive ("Bankai") just costs a glance.
internal static class ScreenPrivacyGuard
{
    // Process names without ".exe", matched whole. Password managers, the
    // lock screen, sign-in and UAC/credential prompts.
    private static readonly string[] BlockedProcesses =
    {
        "keepass", "keepassxc", "1password", "bitwarden", "dashlane", "lastpass", "enpass",
        "nordpass", "roboform", "keeper", "protonpass",
        "lockapp", "logonui", "consent", "credentialuibroker",
    };

    // Title fragments: private browser windows (Edge "[InPrivate]", Chrome
    // "(Incognito)", Firefox "Private Browsing"), banking and password pages.
    private static readonly string[] BlockedTitleWords =
    {
        "inprivate", "incognito", "private browsing", "private window",
        "bank", "paypal", "password", "passkey",
    };

    // null when the window may be read; otherwise why not, for the log.
    // userBlocklist entries match a process name exactly or any part of
    // the title.
    internal static string? BlockReason(IntPtr window, string processName, string title, IReadOnlyCollection<string> userBlocklist)
    {
        if (window == IntPtr.Zero)
        {
            return "no foreground window (lock screen or a secure desktop)";
        }
        if (BlockedProcesses.Contains(processName, StringComparer.OrdinalIgnoreCase))
        {
            return $"{processName} is a private app";
        }
        var word = BlockedTitleWords.FirstOrDefault(w => title.Contains(w, StringComparison.OrdinalIgnoreCase));
        if (word is not null)
        {
            return $"window title mentions \"{word}\"";
        }
        var entry = userBlocklist.FirstOrDefault(e =>
            e.Equals(processName, StringComparison.OrdinalIgnoreCase) || title.Contains(e, StringComparison.OrdinalIgnoreCase));
        return entry is null ? null : $"\"{entry}\" is on the screen privacy blocklist";
    }

    // MANA_SCREEN_PRIVACY_BLOCKLIST: comma- or semicolon-separated process
    // names or title words, added to the built-in ones above.
    internal static IReadOnlyCollection<string> UserBlocklist() =>
        ParseList(Environment.GetEnvironmentVariable("MANA_SCREEN_PRIVACY_BLOCKLIST"));

    internal static string[] ParseList(string? value) =>
        (value ?? "").Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public static string? BlockReasonFor(IntPtr window, int processId) =>
        BlockReason(window, ScreenContextReader.ProcessNameOf(processId), TitleOf(window), UserBlocklist());

    public static string? CurrentBlockReason()
    {
        var window = GetForegroundWindow();
        GetWindowThreadProcessId(window, out var pid);
        return BlockReasonFor(window, pid);
    }

    // "HH:mm-HH:mm" (MANA_SCREEN_SENSING_QUIET_HOURS), wrapping past
    // midnight when the end is earlier than the start. Empty or malformed
    // means no quiet hours.
    internal static bool InQuietHours(string? spec, TimeSpan now)
    {
        var parts = (spec ?? "").Split('-', StringSplitOptions.TrimEntries);
        if (parts.Length != 2 || !TimeSpan.TryParse(parts[0], out var start) || !TimeSpan.TryParse(parts[1], out var end) || start == end)
        {
            return false;
        }
        return start < end ? now >= start && now < end : now >= start || now < end;
    }

    // Everything that stops an ambient glance before it reads anything.
    public static string? GlanceBlockReason() =>
        InQuietHours(Environment.GetEnvironmentVariable("MANA_SCREEN_SENSING_QUIET_HOURS"), DateTime.Now.TimeOfDay)
            ? "quiet hours"
            : CurrentBlockReason();

    public static (IntPtr Window, string Title) Foreground()
    {
        var window = GetForegroundWindow();
        return (window, TitleOf(window));
    }

    internal static string TitleOf(IntPtr window)
    {
        var buffer = new StringBuilder(512);
        return GetWindowText(window, buffer, buffer.Capacity) > 0 ? buffer.ToString() : "";
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
}
