using System;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

// #1286 (part of #624): when the ambient glance runs. Instead of a fixed
// timer, a glance follows a foreground-window switch or a meaningful title
// change, once the window has settled for settleMs and at least
// minIntervalMs after the last glance; fallbackMs is the slow timer that
// still glances when nothing changes. Fed by a cheap 1s poll of the
// foreground window and its title.
// ponytail: polling rather than SetWinEventHook -- two Win32 calls a
// second; switch to the hook if the poll ever shows up in a profile.
internal sealed class GlanceTrigger
{
    private readonly long settleMs;
    private readonly long minIntervalMs;
    private readonly long fallbackMs;
    private string lastKey = "";
    private long changedAtMs;
    private bool pending;
    private long lastGlanceMs;

    public GlanceTrigger(long settleMs, long minIntervalMs, long fallbackMs, long nowMs)
    {
        this.settleMs = settleMs;
        this.minIntervalMs = minIntervalMs;
        this.fallbackMs = fallbackMs;
        lastGlanceMs = nowMs;
    }

    // true when a glance should run now (and counts it as run).
    public bool Poll(IntPtr window, string title, long nowMs)
    {
        var key = $"{window}|{MeaningfulTitle(title)}";
        if (key != lastKey)
        {
            (lastKey, changedAtMs, pending) = (key, nowMs, true);
        }
        var due = (pending && nowMs - changedAtMs >= settleMs && nowMs - lastGlanceMs >= minIntervalMs)
            || nowMs - lastGlanceMs >= fallbackMs;
        if (due)
        {
            (pending, lastGlanceMs) = (false, nowMs);
        }
        return due;
    }

    // Unread counters "(3) Inbox", clocks, progress percentages and unsaved
    // markers change a title without changing what's on screen.
    internal static string MeaningfulTitle(string title) =>
        Regex.Replace(Regex.Replace(title.ToLowerInvariant(), @"[\d%●•*]+", ""), @"[\s()\[\]:.,]+", " ").Trim();
}
