using System.Drawing;
using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")] // paints with the shared static palette
public class ChatViewTests
{
    private static ChatView NewView(int width = 700, int height = 500)
    {
        DarkTheme.ApplyPreset("violet", null);
        var view = new ChatView { Dock = System.Windows.Forms.DockStyle.None, Size = new Size(width, height) };
        view.CreateControl(); // as in the shown chat window
        return view;
    }

    [Fact]
    public void ManasSentencesJoinOneBubbleUntilYouSpeakAgain()
    {
        using var view = NewView();
        view.AppendUserMessage("hi");
        view.AppendReplySentence("One.");
        view.AppendReplySentence("Two.");
        view.AppendUserMessage("again");
        view.AppendReplySentence("Three.");

        Assert.Equal(new[] { "You", "Mana", "You", "Mana" }, view.Messages.Select(m => m.Speaker));
        Assert.Equal("One. Two.", view.Messages[1].PlainText);
        Assert.Equal("Three.", view.Messages[3].PlainText);
    }

    // #914: group mode -- her sister's reaction is her own, labelled bubble.
    [Fact]
    public void EachCharacterGetsHerOwnLabelledBubble()
    {
        using var view = NewView();
        view.AppendUserMessage("which of you is smarter?");
        view.AppendReplySentence("Me.", "Evil Mana");
        view.AppendReplySentence("Obviously.", "Evil Mana");
        view.AppendReplySentence("She wishes.", "Mana");

        Assert.Equal(new[] { "You", "Evil Mana", "Mana" }, view.Messages.Select(m => m.Speaker));
        Assert.Equal("Me. Obviously.", view.Messages[1].PlainText);
    }

    // #914: her relationship note is its own line with an Undo button, and
    // the reply after it starts a fresh bubble.
    [Fact]
    public void ANotedLineHasAnUndoAndIsntMergedIntoTheReply()
    {
        using var view = NewView();
        var undone = 0;
        view.AppendUserMessage("you look smug");
        view.AppendNoted("Evil Mana", "Noted: \"They like my smug face.\"", () =>
        {
            undone++;
            return System.Threading.Tasks.Task.FromResult<string?>("Forgotten.");
        });
        view.AppendReplySentence("Heh.", "Evil Mana");

        Assert.Equal(new[] { "You", "Evil Mana", "Evil Mana" }, view.Messages.Select(m => m.Speaker));
        Assert.Equal("Noted: \"They like my smug face.\"", view.Messages[1].PlainText);
        Assert.Equal("Undo", Assert.Single(view.Messages[1].Actions).Label);
        view.Messages[1].Actions[0].Run().GetAwaiter().GetResult();
        Assert.Equal(1, undone);
        Assert.Equal("Heh.", view.Messages[2].PlainText);
    }

    [Fact]
    public void AppendSentence_ListItemsAndCodeStartTheirOwnBlocks()
    {
        var message = new ChatView.Message(fromUser: false);
        ChatView.AppendSentence(message, ChatMarkdownParser.Parse("Here's the plan."));
        ChatView.AppendSentence(message, ChatMarkdownParser.Parse("- open the file"));
        ChatView.AppendSentence(message, ChatMarkdownParser.Parse("Then **save** it."));

        Assert.Equal(new[] { MarkdownBlockType.Paragraph, MarkdownBlockType.BulletItem, MarkdownBlockType.Paragraph },
            message.Blocks.Select(b => b.Type));
        Assert.Equal("Here's the plan.\n• open the file\nThen save it.", message.PlainText.Replace("\r", ""));
    }

    [Fact]
    public void ConversationText_LabelsEachMessage()
    {
        using var view = NewView();
        view.AppendUserMessage("what's on my screen?");
        view.AppendReplySentence("A build log.");

        var lines = view.ConversationText().Replace("\r", "").Split("\n\n");
        Assert.Equal(new[] { "You: what's on my screen?", "Mana: A build log." }, lines);
    }

    [Fact]
    public void LongMessagesWrapAndBubblesAreHitTestable()
    {
        using var view = NewView(width: 320);
        view.AppendReplySentence(string.Join(" ", Enumerable.Repeat("glass", 60)));
        view.AppendUserMessage("ok");

        var mana = view.Messages[0];
        Assert.True(mana.Lines.Count > 3, $"expected wrapping, got {mana.Lines.Count} line(s)");
        Assert.True(mana.Bounds.Width <= 320);
        var inside = new Point(mana.Bounds.X + 5, mana.Bounds.Y + 5);
        Assert.Equal(0, view.HitTest(inside));
    }

    [Fact]
    public void SelectedText_WithinOneBubble()
    {
        using var view = NewView();
        view.AppendReplySentence("Looks like a build log.");

        view.SelectText((0, 6), (0, 10));

        Assert.True(view.HasTextSelection);
        Assert.Equal("like", view.SelectedText());
    }

    [Fact]
    public void SelectedText_AcrossBubblesJoinsWithABlankLine_AndWorksBackwards()
    {
        using var view = NewView();
        view.AppendUserMessage("fix it");
        view.AppendReplySentence("Done.");

        view.SelectText((1, 4), (0, 4)); // dragged upwards

        Assert.Equal("it\n\nDone", view.SelectedText().Replace("\r", ""));
    }

    [Fact]
    public void TextPositionAt_MapsBubbleEdgesToTheStartAndEndOfItsText()
    {
        using var view = NewView();
        view.AppendReplySentence("Looks like a build log.");
        var bubble = view.Messages[0].Bounds;

        Assert.Equal((0, 0), view.TextPositionAt(new Point(bubble.X + 2, bubble.Y + bubble.Height / 2)));
        Assert.Equal((0, view.Messages[0].Text.Length), view.TextPositionAt(new Point(bubble.Right - 2, bubble.Y + bubble.Height / 2)));
    }

    [Fact]
    public void ReportReply_RebuildsTheStreamedBubbleFromTheFullText_AndTheFallbackDoesNotRepeatIt()
    {
        using var view = NewView();
        const string reply = "Here:\n| Item | Cost |\n|---|---|\n| Tea. | 3 |";
        view.AppendUserMessage("prices?");
        // What streaming delivers: line breaks between sentences are gone.
        view.AppendReplySentence("Here: | Item | Cost | |---|---| | Tea.");
        view.AppendReplySentence("| 3 |");

        view.ReportReply(reply);
        view.AppendReplySentence(reply); // VoiceLoop's non-streamed fallback logs the reply too

        Assert.Equal(2, view.Messages.Count);
        var mana = view.Messages[1];
        Assert.Equal(new[] { MarkdownBlockType.Paragraph, MarkdownBlockType.Table }, mana.Blocks.Select(b => b.Type));
        Assert.Equal(4, mana.Cells.Count);
        Assert.Equal("Here:\nItem\tCost\nTea.\t3", mana.Text);

        view.AppendReplySentence("A later sentence."); // no user message between: a new bubble, not the finished one
        Assert.Equal(3, view.Messages.Count);
    }

    [Fact]
    public void TableCellsSitSideBySide_AndCopyTabSeparated()
    {
        using var view = NewView();
        view.ReportReply("| Name | Score |\n|---|---|\n| Mana | 10 |");

        var mana = view.Messages[0];
        var header = mana.Lines[0].Fragments;
        Assert.Equal(new[] { "Name", "Score" }, header.Select(f => f.Text));
        Assert.True(header[1].X > header[0].X + header[0].Width, "the second column starts right of the first");
        view.SelectText((0, 0), (0, mana.Text.Length));
        Assert.Equal("Name\tScore\nMana\t10", view.SelectedText());
    }

    [Fact]
    public void LinkAt_FindsTheLinkUnderThePointer_AndOnlyWebAndMailLinksAreOpened()
    {
        using var view = NewView();
        view.ReportReply("Read [the docs](https://x.dev) first.");

        var mana = view.Messages[0];
        var link = mana.Lines[0].Fragments.First(f => f.Link is not null);
        var point = new Point(mana.Bounds.X + 14 + link.X + 2, mana.Bounds.Y + 9 + mana.Lines[0].Y + 2);
        Assert.Equal("https://x.dev", view.LinkAt(point));
        Assert.Null(view.LinkAt(new Point(mana.Bounds.X + 16, point.Y)));

        Assert.True(ChatView.IsSafeLink("https://x.dev"));
        Assert.True(ChatView.IsSafeLink("mailto:a@b.c"));
        Assert.False(ChatView.IsSafeLink("file:///C:/Windows/System32/calc.exe"));
        Assert.False(ChatView.IsSafeLink("ms-settings:privacy"));
        Assert.False(ChatView.IsSafeLink("/relative"));
    }

    // #687: reopening/switching sessions shows that session's stored turns.
    [Fact]
    public void ShowHistory_ReplacesTheConversation()
    {
        using var view = NewView();
        view.AppendUserMessage("from another session");

        view.ShowHistory(new[]
        {
            new ManaSessionTurn { User = "hi", Assistant = "Hello **there**." },
            new ManaSessionTurn { User = "bye", Assistant = null },
        });

        Assert.Equal(new[] { "You", "Mana", "You" }, view.Messages.Select(m => m.Speaker));
        Assert.Equal("Hello there.", view.Messages[1].PlainText);
    }

    // The launch reopens the last session while the chat window is still
    // hidden, so the view has no handle yet; its history must still show.
    [Fact]
    public void ShowHistory_LandsBeforeTheWindowWasEverShown()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var view = new ChatView();

        view.ShowHistory(new[] { new ManaSessionTurn { User = "are you doing it?", Assistant = "Yes." } });

        Assert.False(view.IsHandleCreated);
        Assert.Equal(new[] { "You", "Mana" }, view.Messages.Select(m => m.Speaker));
    }

    // Built before its window, like the app's: a history too long for a
    // window that's hidden must still lay out (it used to recurse forever),
    // and the scroll bar laid out at size zero mustn't stick once it fits.
    [Fact]
    public void ShowHistory_InAHiddenWindow_LaysOutOnceItsSized()
    {
        DarkTheme.ApplyPreset("violet", null);
        var view = new ChatView();
        using var form = new System.Windows.Forms.Form { Size = new Size(716, 539) };
        form.Controls.Add(view);
        _ = form.Handle;

        view.ShowHistory(Enumerable.Range(0, 40).Select(i => new ManaSessionTurn { User = $"hi {i}", Assistant = $"hello {i}" }).ToArray());
        view.ShowHistory(new[] { new ManaSessionTurn { User = "are you doing it?" } });

        Assert.Equal(view.ClientSize.Width - 24, view.Messages[0].Bounds.Right); // no room kept for a scroll bar
    }

    // #1147: a long word breaks between text elements, never inside one.
    // Width here is 10 per UTF-16 unit and a line holds 3 units, so a
    // Substring-length break would cut every one of these.
    [Theory]
    [InlineData("\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466",
        "\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466|\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466")] // ZWJ family, wider than a line: one each
    [InlineData("\U0001F1EF\U0001F1F5\U0001F1FA\U0001F1F8\U0001F1EC\U0001F1E7", "\U0001F1EF\U0001F1F5|\U0001F1FA\U0001F1F8|\U0001F1EC\U0001F1E7")] // flags
    [InlineData("ééé", "é|é|é")] // combining accents
    [InlineData("ab\U0001F600cd", "ab|\U0001F600c|d")] // a surrogate pair
    [InlineData("こんにちは世界", "こんに|ちは世|界")] // Japanese
    public void LongWordsBreakBetweenTextElements(string word, string expected)
    {
        var pieces = ChatView.BreakToWidth(word, s => s.Length * 10, 30).ToArray();

        Assert.Equal(expected.Split('|'), pieces);
    }

    // #1337: a reopened chat shows its steps where they were, and its notices.
    [Fact]
    public void ShowHistory_PlacesSavedStepsAndTaskNotices()
    {
        using var view = NewView();
        string? opened = null;
        view.OpenTask = (id, title, running) => opened = $"{id}:{title}:{running()}";

        view.ShowHistory(new[]
        {
            new ManaSessionTurn
            {
                User = "go",
                Assistant = "On it. Done.",
                Steps = new[] { new AgentStep("s1", "command", null, "done", Segment: 0, TextOffset: 6) },
            },
            new ManaSessionTurn { Notice = new ManaTaskNotice("t1", "Draft M6", "done", "Background task completed") },
        });

        Assert.Equal(new[] { "go", "On it.", "Ran a command  ›", "Done.", "Background task completed · Draft M6  ›" },
            view.Messages.Select(m => m.PlainText));
        view.OpenTask!("t1", "Draft M6", () => false);
        Assert.Equal("t1:Draft M6:False", opened);
    }

    // #1337: stream steps land after the text streamed before them; the
    // poll leaves steps that have a textOffset alone.
    [Fact]
    public void StreamSteps_LandInOrderAndThePollSkipsThem()
    {
        using var view = NewView();
        view.AppendUserMessage("go");
        view.AppendReplySentence("On it.");
        var step = new AgentStep("s1", "command", "Run it", "running", Segment: 0, TextOffset: 6);
        view.ShowStreamSteps(new AgentSteps("x", true, new[] { step }));
        view.ShowSteps(new AgentSteps("poll", true, new[] { step }));
        view.AppendReplySentence("Done.");
        view.ShowStreamSteps(new AgentSteps("x", false, new[] { step with { Status = "done" } }));

        Assert.Equal(new[] { "go", "On it.", "Ran a command  ›", "Done." }, view.Messages.Select(m => m.PlainText));
    }

    // #1354: reasoning tokens stream before reply sentences into a collapsed dropdown
    [Fact]
    public void ReasoningTokens_StreamedThought_CreatesDropdownAndAppendsSentence()
    {
        using var view = NewView();
        view.AppendUserMessage("solve this");
        view.AppendReplyThought("Let me consider the steps.");
        view.AppendReplyThought(" First step is clear.");
        view.AppendReplySentence("The answer is 42.");

        Assert.Equal(2, view.Messages.Count);
        var reply = view.Messages[1];
        Assert.Equal("The answer is 42.", reply.PlainText);
        Assert.Equal("Let me consider the steps. First step is clear.", reply.Thought);
        Assert.False(reply.ThoughtOpen);
        Assert.True(reply.ThoughtHeaderBounds.Width > 0);
        Assert.True(reply.ThoughtHeaderBounds.Height > 0);
    }

    // #1354: clicking the thought header dropdown toggles it open and closed
    [Fact]
    public void ReasoningTokens_ClickDropdown_TogglesThoughtOpen()
    {
        using var view = NewView();
        view.AppendUserMessage("think");
        view.AppendReplyThought("Reasoning about the problem.");
        view.AppendReplySentence("Ready.");

        var reply = view.Messages[1];
        Assert.False(reply.ThoughtOpen);

        // Click inside the header pill
        var clickPoint = new Point(
            reply.Bounds.X + 16 + reply.ThoughtHeaderBounds.X + reply.ThoughtHeaderBounds.Width / 2,
            reply.Bounds.Y + 8 + reply.ThoughtHeaderBounds.Y + reply.ThoughtHeaderBounds.Height / 2);
        view.SimulateClick(clickPoint);

        Assert.True(reply.ThoughtOpen);
        Assert.NotEmpty(reply.ThoughtLines);
        Assert.Contains("Reasoning about the problem.", reply.PlainText);

        // Click again to collapse
        view.SimulateClick(clickPoint);
        Assert.False(reply.ThoughtOpen);
        Assert.Equal("Ready.", reply.PlainText);
    }

    // #1354: reopened chat history preserves stored thoughts
    [Fact]
    public void ReasoningTokens_ShowHistory_PreservesThought()
    {
        using var view = NewView();
        view.ShowHistory(new[]
        {
            new ManaSessionTurn
            {
                User = "why is sky blue?",
                Assistant = "Rayleigh scattering.",
                Thought = "Deliberating physics explanation.",
            }
        });

        Assert.Equal(2, view.Messages.Count);
        var reply = view.Messages[1];
        Assert.Equal("Rayleigh scattering.", reply.PlainText);
        Assert.Equal("Deliberating physics explanation.", reply.Thought);
        Assert.False(reply.ThoughtOpen);
        Assert.True(reply.ThoughtHeaderBounds.Width > 0);
    }

    // #1329: Answers using web search or pages carry a sources list with clickable links
    [Fact]
    public void ReportReply_WithSources_RendersSourcesListWithClickableLinks()
    {
        using var view = NewView();
        var sources = new[]
        {
            new WebSourceCitation(1, "Eiffel Tower - Paris", "https://example.com/eiffel"),
            new WebSourceCitation(2, "Louvre Museum", "https://example.com/louvre")
        };

        view.ReportReply("Paris is known for landmarks like the Eiffel Tower [1](https://example.com/eiffel).", sources);

        Assert.Single(view.Messages);
        var message = view.Messages[0];
        Assert.NotNull(message.Sources);
        Assert.Equal(2, message.Sources.Count);

        // PlainText includes sources list
        Assert.Contains("Sources", message.PlainText);
        Assert.Contains("Eiffel Tower - Paris", message.PlainText);
        Assert.Contains("Louvre Museum", message.PlainText);

        // Lines contain clickable fragments with the URLs
        var linkFragments = message.Lines.SelectMany(l => l.Fragments).Where(f => f.Link is not null).ToList();
        Assert.NotEmpty(linkFragments);
        Assert.Contains(linkFragments, f => f.Link == "https://example.com/eiffel");
        Assert.Contains(linkFragments, f => f.Link == "https://example.com/louvre");
    }

    // #1322: ShowHistory populates TurnIndex, versions, and calculates button bounds
    [Fact]
    public void ShowHistory_PopulatesTurnIndexAndVersions()
    {
        using var view = NewView();
        view.ShowHistory(new[]
        {
            new ManaSessionTurn
            {
                TurnIndex = 0,
                User = "What is the capital of France?",
                Assistant = "Paris",
                Versions = new[] { "Paris", "The capital is Paris." },
                VersionIndex = 0,
            }
        });

        Assert.Equal(2, view.Messages.Count);
        var userMsg = view.Messages[0];
        var assistantMsg = view.Messages[1];

        Assert.Equal(0, userMsg.TurnIndex);
        Assert.Equal(0, assistantMsg.TurnIndex);
        Assert.NotNull(assistantMsg.Versions);
        Assert.Equal(2, assistantMsg.Versions.Count);
        Assert.Equal(0, assistantMsg.VersionIndex);
        Assert.False(userMsg.EditBtnBounds.IsEmpty);
        Assert.False(userMsg.BranchBtnBounds.IsEmpty);
        Assert.False(assistantMsg.RegenerateBtnBounds.IsEmpty);
        Assert.False(assistantMsg.BranchBtnBounds.IsEmpty);
        Assert.False(assistantMsg.VersionNextBounds.IsEmpty);
    }

    // #1322: Clicking action buttons triggers corresponding events
    [Fact]
    public void ClickActionButtons_TriggersCorrespondingEvents()
    {
        using var view = NewView();
        view.ShowHistory(new[]
        {
            new ManaSessionTurn
            {
                TurnIndex = 0,
                User = "Hello",
                Assistant = "Hi there",
                Versions = new[] { "Hi there", "Hello!" },
                VersionIndex = 0,
            }
        });

        int? editedTurn = null;
        string? editedText = null;
        view.OnEditMessage += (turn, text) => { editedTurn = turn; editedText = text; };

        int? branchedTurn = null;
        view.OnBranchFromMessage += turn => branchedTurn = turn;

        int? regenTurn = null;
        view.OnRegenerateReply += turn => regenTurn = turn;

        int? switchedTurn = null;
        int? switchedVersion = null;
        view.OnSwitchTurnVersion += (turn, ver) => { switchedTurn = turn; switchedVersion = ver; };

        var userMsg = view.Messages[0];
        var assistantMsg = view.Messages[1];

        // Click Edit on user message
        view.SimulateClick(new Point(userMsg.EditBtnBounds.X + 2, userMsg.EditBtnBounds.Y + 2));
        Assert.Equal(0, editedTurn);
        Assert.Equal("Hello", editedText);

        // Click Branch on user message
        view.SimulateClick(new Point(userMsg.BranchBtnBounds.X + 2, userMsg.BranchBtnBounds.Y + 2));
        Assert.Equal(0, branchedTurn);

        // Click Regenerate on assistant message
        view.SimulateClick(new Point(assistantMsg.RegenerateBtnBounds.X + 2, assistantMsg.RegenerateBtnBounds.Y + 2));
        Assert.Equal(0, regenTurn);

        // Click Next version on assistant message
        view.SimulateClick(new Point(assistantMsg.VersionNextBounds.X + 2, assistantMsg.VersionNextBounds.Y + 2));
        Assert.Equal(0, switchedTurn);
        Assert.Equal(1, switchedVersion);
    }

    // #1322: Keyboard shortcuts (E, R, B, Left, Right) trigger events
    [Fact]
    public void KeyboardShortcuts_TriggersCorrespondingEvents()
    {
        using var view = NewView();
        view.ShowHistory(new[]
        {
            new ManaSessionTurn
            {
                TurnIndex = 0,
                User = "Hello",
                Assistant = "Hi there",
                Versions = new[] { "Hi there", "Hello!" },
                VersionIndex = 0,
            }
        });

        int? editedTurn = null;
        string? editedText = null;
        view.OnEditMessage += (turn, text) => { editedTurn = turn; editedText = text; };

        int? branchedTurn = null;
        view.OnBranchFromMessage += turn => branchedTurn = turn;

        int? regenTurn = null;
        view.OnRegenerateReply += turn => regenTurn = turn;

        int? switchedTurn = null;
        int? switchedVersion = null;
        view.OnSwitchTurnVersion += (turn, ver) => { switchedTurn = turn; switchedVersion = ver; };

        // Select message 0 (user)
        view.Select(0);
        view.SimulateKeyDown(new KeyEventArgs(Keys.E));
        Assert.Equal(0, editedTurn);
        Assert.Equal("Hello", editedText);

        view.SimulateKeyDown(new KeyEventArgs(Keys.B));
        Assert.Equal(0, branchedTurn);

        // Select message 1 (assistant)
        view.Select(1);
        view.SimulateKeyDown(new KeyEventArgs(Keys.R));
        Assert.Equal(0, regenTurn);

        view.SimulateKeyDown(new KeyEventArgs(Keys.Right));
        Assert.Equal(0, switchedTurn);
        Assert.Equal(1, switchedVersion);
    }
}
