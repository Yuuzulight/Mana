using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1426 stage 3: the chat window's "Waiting for you" rail tool -- every
// request waiting on my OK, from any chat, and her edits to files. Pick one
// for its answers. One from the chat on screen also shows as a card there;
// answering either clears both (the next WaitingSnapshot). Settings keeps
// only the rules and the remembered answers, a button away.
internal sealed class WaitingPanel : Panel
{
    private readonly RowList list = new() { Dock = DockStyle.Fill, NameWidth = 110, AccessibleName = "Waiting for you" };
    private readonly Label status = new() { Dock = DockStyle.Bottom, AutoSize = false, Height = 22, ForeColor = DarkTheme.Muted, BackColor = Color.Transparent, UseMnemonic = false, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };

    private static readonly IReadOnlyList<(string Id, string Label)> Groups = [("ask", "Asking now"), ("edit", "Edits to files")];

    // answer: an approval or agent write and a decision, giving back what
    // happened; review: an edit to open; rules: Settings > Permissions.
    public WaitingPanel(Func<object, string, Task<string?>> answer, Action<ManaProposalSummary> review, Action rules)
    {
        Dock = DockStyle.Fill;
        BackColor = DarkTheme.Background;
        Padding = new Padding(10, 8, 10, 8);
        list.ActionsFor = value => ActionsFor(value, answer, review);

        var round = SettingsRows.RoundPanel(list);
        round.Dock = DockStyle.Fill;
        var note = new Label
        {
            Dock = DockStyle.Top,
            AutoSize = false,
            Height = 36,
            Text = "What she needs your OK for, from every chat. Pick one for its answers.",
            ForeColor = DarkTheme.Muted,
            BackColor = Color.Transparent,
            UseMnemonic = false,
        };
        var rulesButton = SettingsRows.Action("Rules and remembered answers…", rules);
        rulesButton.Dock = DockStyle.Bottom;
        rulesButton.Margin = Padding.Empty;
        var gap = new Panel { Dock = DockStyle.Bottom, Height = 6, BackColor = Color.Transparent };
        Controls.Add(round);
        Controls.Add(note);
        Controls.Add(status);
        Controls.Add(gap);
        Controls.Add(rulesButton);
        Show(WaitingSnapshot.Empty, null);
    }

    internal RowList List => list; // tests
    internal string StatusText => status.Text; // tests

    // What's waiting now; sessionId: the chat on screen, marked "This chat".
    internal void Show(WaitingSnapshot waiting, string? sessionId)
    {
        list.ShowEntries(
            [
                .. waiting.Approvals.Select(a => new RowList.Entry(a, Words(a.ActionType), a.Summary,
                    a.SessionId is { } from && from == sessionId ? "This chat" : "", Group: "ask")),
                .. waiting.Writes.Select(w => new RowList.Entry(w, Words(w.Kind), w.Summary, "Coding agent", Group: "ask")),
                .. waiting.PendingEdits.Select(p => new RowList.Entry(p, p.RelativePath,
                    p.Summary ?? $"{p.HunkCount} change{(p.HunkCount == 1 ? "" : "s")}", Group: "edit")),
            ],
            Groups, "Nothing waiting for you",
            keep: picked => list.SelectedItems.Count > 0 && list.EntryOf(list.SelectedItems[0])?.Value is { } was && SameRequest(was, picked));
    }

    private static bool SameRequest(object a, object b) => (a, b) switch
    {
        (ManaPendingApproval x, ManaPendingApproval y) => x.Id == y.Id,
        (ManaPendingWrite x, ManaPendingWrite y) => x.Id == y.Id,
        (ManaProposalSummary x, ManaProposalSummary y) => x.Id == y.Id,
        _ => false,
    };

    private IReadOnlyList<RowList.RowAction> ActionsFor(object value, Func<object, string, Task<string?>> answer, Action<ManaProposalSummary> review)
    {
        RowList.RowAction Act(string glyph, string name, string decision) => new(glyph, name, async () =>
        {
            var said = await answer(value, decision);
            if (!IsDisposed)
            {
                status.Text = said ?? "";
            }
        });
        return value switch
        {
            // An agent write is decided once: no session or standing grants.
            ManaPendingWrite => [Act("", "Allow once", "allow-once"), Act("", "Deny", "deny")],
            ManaPendingApproval => ApprovalChoices.Select(c => Act(c.Glyph, c.Name, c.Decision)).ToList(),
            ManaProposalSummary edit => [new("", "Review", () => { review(edit); return Task.CompletedTask; })],
            _ => [],
        };
    }

    // A request's answers, in the order they're offered here and in the chat.
    internal static readonly IReadOnlyList<(string Glyph, string Name, string Decision)> ApprovalChoices =
    [
        ("", "Allow once", "allow-once"),
        ("", "Allow for this session", "allow-session"),
        ("", "Always allow", "always-allow"), // an open lock
        ("", "Deny", "deny"),
        ("", "Never", "never"), // a lock
    ];

    // What each answer did, for the panel's line and the chat card.
    internal static string Answered(string decision) => decision switch
    {
        "allow-once" => "Allowed",
        "allow-session" => "Allowed for this session",
        "always-allow" => "Always allowed: she won't ask for this again",
        "never" => "Never: she won't ask for this again",
        _ => "Denied",
    };

    // "github-write" -> "Github write": a request's kind, in words.
    internal static string Words(string kind) =>
        kind.Length == 0 ? "Request" : char.ToUpperInvariant(kind[0]) + kind[1..].Replace('-', ' ').Replace('_', ' ');
}
