using System.Drawing;
using System.Drawing.Drawing2D;

namespace Mana.NativeLauncher;

// #661: what's waiting on the user -- tool/memory/skill approvals
// (/approvals/pending) and pending edit proposals (#658) -- for the
// avatar's Waiting pose, the tray badge and the "waiting for you" toast.
internal static class WaitingForYou
{
    public static IReadOnlyList<(string Id, string What)> Items(
        IReadOnlyList<ManaPendingApproval> approvals,
        IReadOnlyList<ManaProposalSummary> proposals) =>
        [
            .. approvals.Select(a => ("approval:" + a.Id, Describe(a))),
            .. proposals.Where(p => p.Status == "pending").Select(p => ("edit:" + p.Id, $"an edit to {p.RelativePath}")),
        ];

    // The toast text for items not announced before (null when there are
    // none). announced remembers what's been announced and forgets what's
    // been resolved, so each request is announced once.
    public static string? NewItemsNotice(IReadOnlyList<(string Id, string What)> items, HashSet<string> announced)
    {
        announced.IntersectWith(items.Select(item => item.Id));
        var fresh = items.Where(item => announced.Add(item.Id)).Select(item => item.What).ToList();
        if (fresh.Count == 0)
        {
            return null;
        }
        var first = fresh[0].Length > 160 ? fresh[0][..160] + "…" : fresh[0];
        return fresh.Count == 1
            ? $"Mana needs your OK for {first}."
            : $"Mana needs your OK for {first} and {fresh.Count - 1} more.";
    }

    // The tray icon with an amber dot in the corner.
    // ponytail: the HICON is never destroyed -- it's made once per run.
    public static Icon Badged(Icon icon)
    {
        using var bitmap = icon.ToBitmap();
        using (var graphics = Graphics.FromImage(bitmap))
        using (var brush = new SolidBrush(Color.FromArgb(255, 176, 32)))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var size = bitmap.Width * 0.5f;
            graphics.FillEllipse(brush, bitmap.Width - size, bitmap.Height - size, size, size);
        }
        return Icon.FromHandle(bitmap.GetHicon());
    }

    private static string Describe(ManaPendingApproval approval) =>
        !string.IsNullOrWhiteSpace(approval.Summary) ? approval.Summary
        : approval.ActionType == "memory-write" ? "a memory write"
        : approval.ActionType.StartsWith("tool-", StringComparison.Ordinal) ? "a tool call"
        : string.IsNullOrWhiteSpace(approval.ActionType) ? "a request" : approval.ActionType;
}
