using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1426 stage 3: "Waiting for you" and the request cards in the chat.
[Collection("DarkTheme palette")]
public class WaitingPanelTests
{
    private static readonly WaitingSnapshot Waiting = new(
        [
            new ManaPendingApproval { Id = "a1", ActionType = "github-write", Summary = "Open a PR: polish Settings", SessionId = "chat-1" },
            new ManaPendingApproval { Id = "a2", ActionType = "memory-write", Summary = "Remember: likes tea", SessionId = "chat-2" },
        ],
        [
            new ManaProposalSummary { Id = "p1", Status = "pending", RelativePath = "README.md", HunkCount = 2 },
            new ManaProposalSummary { Id = "p2", Status = "approved", RelativePath = "old.md" },
        ],
        [new ManaPendingWrite { Id = "w1", Kind = "file_write", Summary = "Write notes.txt" }]);

    [Fact]
    public void ListsEverythingWaiting_MarkingThisChats_WithTheAnswersEachTakes()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var answers = new List<(object, string)>();
            using var panel = new WaitingPanel((request, decision) => { answers.Add((request, decision)); return Task.FromResult<string?>("Allowed"); }, _ => { }, () => { });
            panel.Show(Waiting, "chat-1");

            Assert.Equal(4, Waiting.Count); // the approved edit isn't waiting
            var rows = panel.List.Items.Cast<ListViewItem>().Where(i => !RowList.IsHeader(i)).Select(i => panel.List.EntryOf(i)!).ToList();
            Assert.Equal(new[] { ("GitHub", "This chat", ""), ("Memory", null, ""), ("File write", null, "Coding agent"), ("README.md", null, "") },
                rows.Select(r => (r.Name, r.Tag, r.Right)));
            Assert.Equal("Browser", WaitingPanel.Kind("browser-site:shop.test"));
            Assert.Equal("Folio update", WaitingPanel.Kind("folio-update:d:/mana/folio"));
            Assert.Equal("2 changes", rows[3].Text);

            Assert.Equal(new[] { "Allow once", "Allow for this session", "Always allow", "Deny", "Never" }, panel.List.ActionsFor!(rows[0].Value).Select(a => a.Name));
            Assert.Equal(new[] { "Allow once", "Deny" }, panel.List.ActionsFor!(rows[2].Value).Select(a => a.Name)); // an agent write: once or not
            Assert.Equal("Review", Assert.Single(panel.List.ActionsFor!(rows[3].Value)).Name);

            panel.List.ActionsFor!(rows[1].Value).Single(a => a.Name == "Never").Run().GetAwaiter().GetResult();
            Assert.Equal((rows[1].Value, "never"), Assert.Single(answers));
            Assert.Equal("Allowed", panel.StatusText);

            panel.Show(WaitingSnapshot.Empty, "chat-1");
            Assert.Equal("Nothing waiting for you", Assert.Single(panel.List.Items.Cast<ListViewItem>()).Text);
        });
    }

    [Fact]
    public void ARequestCard_WaitsWithItsAnswers_ThenEndsWithWhatWasSaid()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var view = new ChatView { Dock = DockStyle.None, Size = new Size(700, 500) };
        view.CreateControl();
        var actions = new[] { new ChatView.ChatAction("Allow", true, () => Task.FromResult<string?>("Allowed")) };
        view.ShowApprovalCard("a1", "**Needs your OK** · Github write\n\nOpen a PR", actions);
        view.ShowApprovalCard("a1", "again", actions); // one card a request

        var card = Assert.Single(view.Messages);
        Assert.Equal("a1", card.ApprovalId);
        Assert.Contains("Open a PR", card.PlainText);
        Assert.Equal(new[] { "a1" }, view.OpenApprovalCards);

        view.EndApprovalCard("a1", "Denied");
        Assert.Empty(card.Actions);
        Assert.Equal("Denied", card.Note);
        Assert.Empty(view.OpenApprovalCards);
    }
}
