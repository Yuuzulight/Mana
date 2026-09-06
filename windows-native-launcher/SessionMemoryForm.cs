using System.Drawing;
using System.Text;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #586: read-only "Open memory" modal -- shows the goal, rolling summary,
// and tail of the turns array GetSessionDetailAsync returns, as one
// scrollable text block. This is a review surface, not an editor, so a
// read-only TextBox (native selection/copy, native scrolling) is simpler
// than building a ListView layout for it.
internal sealed class SessionMemoryForm : Form
{
    public SessionMemoryForm(string sessionId, ManaSessionDetail? detail)
    {
        Text = $"Session Memory - {sessionId}";
        Width = 640;
        Height = 520;
        StartPosition = FormStartPosition.CenterParent;
        DarkTheme.ApplyForm(this);

        var textBox = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            WordWrap = true,
            BackColor = DarkTheme.Panel,
            ForeColor = DarkTheme.Text,
            BorderStyle = BorderStyle.None,
            Font = new Font("Consolas", 9.5f),
            Text = FormatDetail(detail),
        };
        Controls.Add(textBox);
    }

    internal static string FormatDetail(ManaSessionDetail? detail)
    {
        if (detail is null)
        {
            return "This session has no stored memory yet -- it hasn't had a real turn.";
        }

        var sb = new StringBuilder();
        sb.Append("Goal: ").AppendLine(string.IsNullOrWhiteSpace(detail.Goal) ? "(none)" : detail.Goal);
        sb.AppendLine();
        sb.AppendLine("Summary:");
        sb.AppendLine(string.IsNullOrWhiteSpace(detail.Summary) ? "(none yet)" : detail.Summary);
        sb.AppendLine();
        sb.Append("Recent turns (showing ").Append(detail.RecentTurns.Count).Append(" of ").Append(detail.TotalTurnCount).AppendLine("):");
        sb.AppendLine();
        if (detail.RecentTurns.Count == 0)
        {
            sb.AppendLine("(no turns yet)");
        }
        foreach (var turn in detail.RecentTurns)
        {
            sb.Append("You: ").AppendLine(turn.User ?? "");
            sb.Append("Mana: ").AppendLine(turn.Assistant ?? "");
            sb.AppendLine();
        }
        return sb.ToString();
    }
}
