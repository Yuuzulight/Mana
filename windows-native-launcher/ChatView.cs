using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #652 part 3: the chat pane, custom-drawn so it can take the Mana preset's
// glass look (a RichTextBox can't be see-through). Replaces ChatLogPanel in
// every theme: padded bubbles, "You"/"Mana" labels, markdown (paragraphs,
// headings, bullet/numbered items, quotes, tables, inline bold/italic/
// strikethrough/code/links, code blocks). Mana's sentences stream in one at
// a time; they all join her current bubble until your next message starts
// a new turn (VoiceLoop always logs the user message before a reply). Once
// the reply is done, ReportReply re-renders the bubble from the full text.
//
// Copying: drag to select text within or across bubbles, or click a bubble
// to select all of it; then Ctrl+C or right-click Copy. Ctrl+A selects all
// text; right-click "Copy conversation" copies everything with labels.
// Table cells copy tab-separated, so they paste into a spreadsheet. Clicking
// a link opens it in the browser. Up/Down move the bubble selection. Screen
// readers see a list with one item per message.
internal sealed class ChatView : Control, IChatLog, IArtifactSink
{
    private const int SideMargin = 24;
    private const int PadX = 14;
    private const int PadY = 9;
    private const int LabelGap = 3;
    private const int MessageGap = 14;
    private const int BlockGap = 5;
    private const int ActionHeight = 28;
    private const int MenuArrowWidth = 22; // a split button's dropdown part
    private const int QuoteIndent = 12;
    private const int CellPad = 6;
    private const TextFormatFlags TextFlags = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
    private static readonly Regex WordPattern = new(@"\S+\s*|\s+", RegexOptions.Compiled);

    private readonly List<Message> messages = new();
    private readonly VScrollBar scrollBar = new() { Dock = DockStyle.Right, Visible = false };
    // Whether the scroll bar is on. Not read back from scrollBar.Visible,
    // which stays false while the window is hidden (then Relayout would
    // keep switching it on forever).
    private bool scrolling;
    private readonly Font bodyFont = new("Segoe UI", 10F);
    private readonly Dictionary<FontStyle, Font> styledFonts = new(); // bodyFont in bold/italic/strikeout/underline mixes
    private readonly Font headerFont = new("Segoe UI", 11F, FontStyle.Bold);
    private readonly Font codeFont = new("Consolas", 9.5F);
    private readonly Font labelFont = new("Segoe UI", 8.5F, FontStyle.Bold);
    private readonly ToolTip linkTip = new();
    private string? hoveredLink;
    private int contentHeight;
    private int selected = -1;
    private (int Msg, int Offset)? anchor;
    private (int Msg, int Offset)? caret;
    private Point pressPoint;
    private bool pressed;
    private bool dragSelecting;
    private Bitmap? glow;
    private (Size Size, Point Offset, Size Window, int Theme) glowKey;
    // The UI thread, captured at construction: the view has no handle until
    // the chat window is first shown, and appends made before then (the
    // reopened session's history at launch, voice turns) must still land.
    private readonly int uiThreadId = Environment.CurrentManagedThreadId;
    private readonly System.Threading.SynchronizationContext? uiContext;

    public ChatView()
    {
        uiContext = System.Threading.SynchronizationContext.Current; // installed by Control's constructor
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        Dock = DockStyle.Fill;
        TabStop = true;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;
        AccessibleName = "Conversation";
        AccessibleRole = AccessibleRole.List;

        scrollBar.ValueChanged += (_, _) => Invalidate();
        Controls.Add(scrollBar);

        var menu = new ContextMenuStrip();
        var copyItem = menu.Items.Add("Copy", null, (_, _) => CopySelected());
        menu.Items.Add("Copy conversation", null, (_, _) => CopyConversation());
        menu.Opening += (_, _) => copyItem.Enabled = selected >= 0 || HasTextSelection;
        ContextMenuStrip = menu;
    }

    // ---- IChatLog -------------------------------------------------------

    // When the latest user message was logged (UTC) -- the start of the
    // current turn, for telling which edits it produced.
    public DateTime? LastUserMessageAt { get; private set; }

    public void AppendUserMessage(string text) => AppendUserMessage(text, Array.Empty<string>());

    // #679: images show as thumbnails above the text; an image-only
    // message has no text line.
    public void AppendUserMessage(string text, IReadOnlyList<string> images) => RunOnUiThread(() =>
    {
        LastUserMessageAt = DateTime.UtcNow;
        var message = new Message(fromUser: true);
        foreach (var image in images)
        {
            if (DecodeThumbnail(image) is { } thumb)
            {
                message.Images.Add(thumb);
            }
        }
        if (text.Length > 0 || message.Images.Count == 0)
        {
            message.Blocks.AddRange(UserBlocks(text));
        }
        Add(message, forceScroll: true);
    });

    // My message as typed -- except text I shared from My shell (#1121),
    // which Mana gets framed as outside text: the chat shows it as a
    // "Shared from terminal" card with the text in a monospace box.
    internal static IReadOnlyList<MarkdownBlock> UserBlocks(string text)
    {
        if (UntrustedText.Unwrap(MyShellPanel.SharedSource, text) is not { } shared)
        {
            return [new MarkdownBlock(MarkdownBlockType.Paragraph, new[] { new MarkdownRun(text, false, false, false) })];
        }
        return
        [
            new MarkdownBlock(MarkdownBlockType.Paragraph, new[] { new MarkdownRun("Shared from terminal", true, false, false) }),
            new MarkdownBlock(MarkdownBlockType.CodeBlock, new[] { new MarkdownRun(shared.ReplaceLineEndings("\n"), false, false, true) }),
        ];
    }

    private const int ThumbnailSide = 160;

    // A data URL's image scaled to ThumbnailSide, or null if it isn't one.
    internal static Bitmap? DecodeThumbnail(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',');
        try
        {
            using var stream = new System.IO.MemoryStream(Convert.FromBase64String(dataUrl[(comma + 1)..]));
            using var image = Image.FromStream(stream);
            return new Bitmap(image, ScreenCapture.FitWithin(image.Size, ThumbnailSide));
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException)
        {
            return null;
        }
    }

    public void AppendReplySentence(string text) => AppendReplySentence(text, null);

    // #914: a sentence from another character than the open reply's (group
    // mode's second reply) starts her own message, labelled with her name.
    public void AppendReplySentence(string text, string? speaker) => RunOnUiThread(() =>
    {
        var blocks = ChatMarkdownParser.Parse(text);
        if (blocks.Count == 0)
        {
            return;
        }
        if (messages.Count > 0 && !messages[^1].FromUser && messages[^1].Steps is null && (speaker is null || messages[^1].Speaker == speaker))
        {
            var current = messages[^1];
            if (current.FinalText == text)
            {
                return; // VoiceLoop's non-streamed fallback logging the reply it just reported
            }
            if (current.FinalText is null)
            {
                AppendSentence(current, blocks);
                current.Invalidate();
                Relayout(forceScroll: false);
                return;
            }
        }
        var message = new Message(fromUser: false) { Name = speaker };
        message.Blocks.AddRange(blocks);
        Add(message, forceScroll: false);
    });

    // #687: a reopened or switched-to session's stored turns, replacing the
    // conversation shown. Artifacts stay inline here.
    public void ShowHistory(IReadOnlyList<ManaSessionTurn> turns) => RunOnUiThread(() =>
    {
        messages.Clear();
        stepMessages.Clear(); // #1318: re-added after the history on the next poll
        stepsRunId = null;
        selected = -1;
        ClearTextSelection();
        foreach (var turn in turns)
        {
            if (!string.IsNullOrWhiteSpace(turn.User))
            {
                var user = new Message(fromUser: true);
                user.Blocks.AddRange(UserBlocks(turn.User));
                messages.Add(user);
            }
            if (!string.IsNullOrWhiteSpace(turn.Assistant))
            {
                var reply = new Message(fromUser: false) { FinalText = turn.Assistant };
                reply.Blocks.AddRange(ChatMarkdownParser.Parse(turn.Assistant));
                messages.Add(reply);
            }
        }
        AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
        Relayout(forceScroll: true);
    });

    // #686: records a detected artifact with the viewer (ArtifactViewerForm.Add)
    // and returns what opens it; null means artifacts stay inline.
    public Func<DetectedArtifact, Action<ArtifactOpen>>? Artifacts { get; set; }

    // VoiceLoop reports each finished reply's full text. Streamed sentences
    // lose the line breaks between them and a long table or code block is
    // cut mid-line, so Mana's bubble is re-parsed from the real text. As in
    // Electron, the reply's artifact (a big or ```html/```mermaid block)
    // moves out of the bubble behind an "Open" button.
    public void ReportReply(string replyText) => RunOnUiThread(() =>
    {
        var addArtifact = Artifacts;
        var artifact = addArtifact is null ? null : ArtifactDetector.Extract(replyText);
        var blocks = ChatMarkdownParser.Parse(artifact is { } found ? replyText.Replace(found.MatchedText, "").Trim() : replyText);
        if (blocks.Count == 0 && artifact is null)
        {
            return;
        }
        // #1318: a reply split by step lines keeps its streamed segments --
        // re-parsing the whole text into the last one would repeat the rest.
        // ponytail: those segments keep the streamed sentences' formatting.
        var lastUser = messages.FindLastIndex(m => m.FromUser);
        if (messages.Skip(lastUser + 1).Any(m => m.Steps is not null))
        {
            var last = messages.FindLast(m => !m.FromUser && m.Steps is null && m.FinalText is null);
            if (last is not null && messages.IndexOf(last) > lastUser)
            {
                last.FinalText = replyText;
                if (artifact is { } split)
                {
                    last.Actions.Add(ArtifactAction(split, addArtifact!(split)));
                    last.Invalidate();
                    Relayout(forceScroll: false);
                }
            }
            return;
        }
        var message = messages.Count > 0 && !messages[^1].FromUser && messages[^1].FinalText is null && messages[^1].Steps is null
            ? messages[^1]
            : null;
        if (message is null)
        {
            message = new Message(fromUser: false);
            messages.Add(message);
            AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
        }
        message.Blocks.Clear();
        message.Blocks.AddRange(blocks);
        message.FinalText = replyText;
        if (artifact is { } a)
        {
            message.Actions.Add(ArtifactAction(a, addArtifact!(a)));
        }
        message.Invalidate();
        Relayout(forceScroll: false);
    });

    // #686 (Q4/Q44b): an HTML artifact gets an "Open" split button whose
    // main part opens it in Mana when Folio can draw it (#937), else in the
    // browser; the arrow lists every way. Other artifacts open in the viewer.
    private static ChatAction ArtifactAction(DetectedArtifact artifact, Action<ArtifactOpen> open)
    {
        Func<Task<string?>> Run(ArtifactOpen how) => () =>
        {
            open(how);
            return Task.FromResult<string?>(null);
        };
        if (artifact.Language != "html")
        {
            return new ChatAction($"Open {artifact.Language} content in new window", false, Run(ArtifactOpen.Default), Keep: true);
        }
        var whyBrowser = HtmlArtifact.BrowserReasons(artifact.Content);
        return new ChatAction("Open", false, Run(ArtifactOpen.Default), Keep: true, Menu: new[]
        {
            new ChatMenuItem(whyBrowser is null ? "Open in Mana" : $"Open in Mana (needs a browser: {whyBrowser})", whyBrowser is null, Run(ArtifactOpen.InMana)),
            new ChatMenuItem("Open in browser", true, Run(ArtifactOpen.Browser)),
            new ChatMenuItem("View source", true, Run(ArtifactOpen.Source)),
            new ChatMenuItem("Save as...", true, Run(ArtifactOpen.SaveAs)),
        });
    }

    // #1318: the reply's step groups, each placed after the reply text of
    // its segment: a group not shown yet goes at the end, which is right
    // after that segment's text while it's streaming in. Groups without a
    // segment are ChatStepsStrip's. A new run starts a new set.
    // ponytail: placement trusts the 1s poll to see a segment's first step
    // before the next segment's text arrives; a tool round shorter than
    // that lands its line after that text instead.
    private string? stepsRunId;
    private readonly Dictionary<int, Message> stepMessages = new();

    public void ShowSteps(AgentSteps activity) => RunOnUiThread(() =>
    {
        if (activity.RunId != stepsRunId)
        {
            stepsRunId = activity.RunId;
            stepMessages.Clear();
        }
        var now = DateTimeOffset.UtcNow;
        var changed = false;
        foreach (var group in ChatStepGroups.Group(activity))
        {
            if (group.Segment is not { } segment)
            {
                continue;
            }
            if (!stepMessages.TryGetValue(segment, out var message))
            {
                message = new Message(fromUser: false);
                stepMessages[segment] = message;
                messages.Add(message);
                AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
            }
            message.Steps = group;
            changed |= SetStepBlocks(message, now);
        }
        if (changed)
        {
            Relayout(forceScroll: false);
        }
    });

    private static bool SetStepBlocks(Message message, DateTimeOffset now)
    {
        var blocks = ChatStepGroups.Blocks(message.Steps!, message.StepsOpen, now);
        if (blocks.SequenceEqual(message.Blocks, MarkdownBlockText.Instance))
        {
            return false;
        }
        message.Blocks.Clear();
        message.Blocks.AddRange(blocks);
        message.Invalidate();
        return true;
    }

    // Blocks compared by their text (MarkdownBlock's own equality compares
    // its run lists by reference).
    private sealed class MarkdownBlockText : IEqualityComparer<MarkdownBlock>
    {
        public static readonly MarkdownBlockText Instance = new();
        public bool Equals(MarkdownBlock a, MarkdownBlock b) => a.Type == b.Type && a.Runs.SequenceEqual(b.Runs);
        public int GetHashCode(MarkdownBlock block) => block.Type.GetHashCode();
    }

    // Step-line text: grey, the +added total green, the -removed one red.
    internal static Color StepColor(string fragment)
    {
        var text = fragment.Trim();
        return text.Length > 1 && text[1..].All(char.IsDigit)
            ? text.StartsWith(ChatStepGroups.AddedPrefix, StringComparison.Ordinal) ? DarkTheme.Green
            : text.StartsWith(ChatStepGroups.RemovedPrefix, StringComparison.Ordinal) ? ChatStepsStrip.RemovedColor
            : DarkTheme.Muted
            : DarkTheme.Muted;
    }

    // #652 part 6: raised when Mana's reply is complete; SessionListForm
    // checks then for edits to approve and attaches buttons for them.
    public event Action? ReplyEnded;

    public void ReplyFinished() => RunOnUiThread(() => ReplyEnded?.Invoke());

    // #619: SessionListForm shows it in the avatar card's status line.
    public event Action<string?>? HearingChanged;

    public void ShowHearing(string? text) => RunOnUiThread(() => HearingChanged?.Invoke(text));

    // #690: a message from Mana outside any turn (an ambient screen glance)
    // -- always its own, finished bubble, never merged into a reply that's
    // still open (e.g. one cut off by a barge-in).
    public void AppendManaMessage(string text) => RunOnUiThread(() =>
    {
        var blocks = ChatMarkdownParser.Parse(text);
        if (blocks.Count == 0)
        {
            return;
        }
        var message = new Message(fromUser: false) { FinalText = text };
        message.Blocks.AddRange(blocks);
        Add(message, forceScroll: false);
    });

    // #914: "Noted: ..." -- her relationship note or milestone, its own
    // finished line with an Undo button (never merged into the reply).
    public void AppendNoted(string? speaker, string text, Func<Task<string?>> undo) => RunOnUiThread(() =>
    {
        var message = new Message(fromUser: false) { Name = speaker, FinalText = text };
        message.Blocks.AddRange(ChatMarkdownParser.Parse(text));
        message.Actions.Add(new ChatAction("Undo", false, undo));
        Add(message, forceScroll: false);
    });

    // Puts buttons under Mana's latest message (replacing any it had, except
    // kept ones like the artifact button, which move after the new ones).
    public void AttachActions(IReadOnlyList<ChatAction> actions)
    {
        var message = messages.LastOrDefault(m => !m.FromUser);
        if (message is null)
        {
            return;
        }
        var kept = message.Actions.Where(a => a.Keep).ToList();
        message.Actions.Clear();
        message.Actions.AddRange(actions);
        message.Actions.AddRange(kept);
        message.Note = null;
        message.Invalidate();
        Relayout(forceScroll: false);
    }

    // A plain sentence continues the bubble's last paragraph (space-joined);
    // anything structural (list item, code block, heading) starts its own block.
    internal static void AppendSentence(Message message, IReadOnlyList<MarkdownBlock> blocks)
    {
        var first = blocks[0];
        if (first.Type == MarkdownBlockType.Paragraph && message.Blocks.Count > 0 && message.Blocks[^1].Type == MarkdownBlockType.Paragraph)
        {
            var last = message.Blocks[^1];
            var runs = last.Runs.ToList();
            runs.Add(new MarkdownRun(" ", false, false, false));
            runs.AddRange(first.Runs);
            message.Blocks[^1] = new MarkdownBlock(MarkdownBlockType.Paragraph, runs);
            message.Blocks.AddRange(blocks.Skip(1));
        }
        else
        {
            message.Blocks.AddRange(blocks);
        }
    }

    private void RunOnUiThread(Action action)
    {
        if (IsDisposed)
        {
            return;
        }
        if (Environment.CurrentManagedThreadId == uiThreadId)
        {
            action();
            return;
        }
        // Fire-and-forget, same as ChatLogPanel: an append racing the
        // window closing is fine to drop.
        uiContext?.Post(_ =>
        {
            if (!IsDisposed)
            {
                action();
            }
        }, null);
    }

    private void Add(Message message, bool forceScroll)
    {
        messages.Add(message);
        Relayout(forceScroll);
        AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
    }

    // ---- Copy -----------------------------------------------------------

    internal IReadOnlyList<Message> Messages => messages;

    internal string ConversationText() =>
        string.Join(Environment.NewLine + Environment.NewLine, messages.Select(m => $"{m.Speaker}: {m.PlainText}"));

    // Copies the dragged text selection if there is one, else the selected bubble.
    private void CopySelected()
    {
        if (HasTextSelection)
        {
            Clipboard.SetText(SelectedText());
        }
        else if (selected >= 0)
        {
            Clipboard.SetText(messages[selected].PlainText);
        }
    }

    private void CopyConversation()
    {
        if (messages.Count > 0)
        {
            Clipboard.SetText(ConversationText());
        }
    }

    // ---- Layout ---------------------------------------------------------

    private int ViewportWidth => Math.Max(1, ClientSize.Width - (scrolling ? scrollBar.Width : 0));

    private int MaxBubbleContentWidth => Math.Max(120, Math.Min(640, (int)((ViewportWidth - SideMargin * 2) * 0.72)) - PadX * 2);

    private void Relayout(bool forceScroll)
    {
        var wasAtBottom = scrollBar.Value >= MaxScroll() - 8;
        var y = SideMargin;
        var width = MaxBubbleContentWidth;
        foreach (var message in messages)
        {
            if (message.LaidOutWidth != width)
            {
                LayOut(message, width);
            }
            var bubbleWidth = message.ContentWidth + PadX * 2;
            var x = message.FromUser ? ViewportWidth - SideMargin - bubbleWidth : SideMargin;
            // #1318: a step line has no "Mana" label above it.
            var labelHeight = message.Steps is null ? labelFont.Height + LabelGap : 0;
            message.LabelBounds = new Rectangle(message.FromUser ? x + bubbleWidth - 60 : x, y, 60, labelHeight);
            message.Bounds = new Rectangle(x, y + labelHeight, bubbleWidth, message.ContentHeight + PadY * 2);
            y = message.Bounds.Bottom + MessageGap;
        }
        contentHeight = y;

        var needsScroll = contentHeight > ClientSize.Height;
        if (scrolling != needsScroll)
        {
            scrolling = scrollBar.Visible = needsScroll;
            foreach (var message in messages)
            {
                message.LaidOutWidth = -1; // viewport width changed with the scrollbar
            }
            Relayout(forceScroll);
            return;
        }
        scrollBar.Maximum = Math.Max(0, contentHeight);
        scrollBar.LargeChange = Math.Max(1, ClientSize.Height);
        scrollBar.SmallChange = 40;
        if (forceScroll || wasAtBottom)
        {
            scrollBar.Value = MaxScroll();
        }
        else
        {
            scrollBar.Value = Math.Min(scrollBar.Value, MaxScroll());
        }
        Invalidate();
    }

    private int MaxScroll() => Math.Max(0, contentHeight - ClientSize.Height);

    private void LayOut(Message message, int maxWidth)
    {
        var lines = new List<Line>();
        // The message's text in reading order; each fragment records where it
        // starts in it, which is what text selection works in. Soft wraps add
        // nothing, so offsets survive re-wrapping at another width.
        var flat = new StringBuilder();
        var y = 0;
        var widest = 0;
        message.Cells.Clear();
        message.ImageBounds.Clear();
        if (message.Images.Count > 0)
        {
            var x = 0;
            var rowHeight = 0;
            foreach (var image in message.Images)
            {
                var size = ScreenCapture.FitWithin(image.Size, Math.Min(ThumbnailSide, maxWidth));
                if (x > 0 && x + size.Width > maxWidth)
                {
                    y += rowHeight + BlockGap;
                    x = 0;
                    rowHeight = 0;
                }
                message.ImageBounds.Add(new Rectangle(new Point(x, y), size));
                widest = Math.Max(widest, x + size.Width);
                rowHeight = Math.Max(rowHeight, size.Height);
                x += size.Width + BlockGap;
            }
            y += rowHeight + (message.Blocks.Count > 0 ? BlockGap : 2);
        }
        for (var b = 0; b < message.Blocks.Count; b++)
        {
            var block = message.Blocks[b];
            if (b > 0)
            {
                y += BlockGap;
                flat.Append('\n');
            }
            if (block.Type == MarkdownBlockType.CodeBlock)
            {
                var sourceLines = string.Concat(block.Runs.Select(r => r.Text)).Replace("\r", "").Split('\n');
                for (var li = 0; li < sourceLines.Length; li++)
                {
                    if (li > 0)
                    {
                        flat.Append('\n');
                    }
                    foreach (var piece in BreakToWidth(sourceLines[li].Length == 0 ? " " : sourceLines[li], s => Measure(s, codeFont), maxWidth - 12))
                    {
                        var w = Measure(piece, codeFont);
                        lines.Add(new Line(y, codeFont.Height + 2, true, new List<Fragment> { new(piece, codeFont, 6, w, true, flat.Length) }));
                        flat.Append(piece);
                        widest = Math.Max(widest, w + 12);
                        y += codeFont.Height + 2;
                    }
                }
                continue;
            }

            if (block.Type == MarkdownBlockType.Table && block.Rows is { Count: > 0 } rows)
            {
                LayOutTable(rows);
                continue;
            }

            var indent = 0;
            var runs = block.Runs.ToList();
            if (block.Type == MarkdownBlockType.BulletItem)
            {
                runs.Insert(0, new MarkdownRun("•  ", false, false, false));
                indent = Measure("•  ", bodyFont);
            }
            var isHeader = block.Type == MarkdownBlockType.Header;
            var isQuote = block.Type == MarkdownBlockType.Quote;
            var left = isQuote ? QuoteIndent : 0;
            var lineHeight = isHeader ? headerFont.Height : bodyFont.Height;
            foreach (var fragments in Wrap(runs, isHeader ? headerFont : null, left, maxWidth - left, indent))
            {
                lines.Add(new Line(y, lineHeight, false, fragments, isQuote));
                widest = Math.Max(widest, fragments[^1].X + fragments[^1].Width);
                y += lineHeight + 2;
            }
        }

        // Columns get their natural (unwrapped) width, scaled down together
        // when the table is wider than the bubble; cells then wrap inside.
        void LayOutTable(IReadOnlyList<IReadOnlyList<IReadOnlyList<MarkdownRun>>> rows)
        {
            static IEnumerable<MarkdownRun> CellRuns(IReadOnlyList<MarkdownRun> cell, bool header) =>
                header ? cell.Select(r => r with { Bold = true }) : cell;
            var columns = rows[0].Count;
            var widths = new int[columns];
            for (var r = 0; r < rows.Count; r++)
            {
                for (var c = 0; c < columns; c++)
                {
                    widths[c] = Math.Max(widths[c], CellRuns(rows[r][c], r == 0).Sum(run => Measure(run.Text, FontFor(run))) + CellPad * 2);
                }
            }
            var total = widths.Sum();
            if (total > maxWidth)
            {
                for (var c = 0; c < columns; c++)
                {
                    widths[c] = Math.Max(1, (int)((long)widths[c] * maxWidth / total));
                }
            }
            for (var r = 0; r < rows.Count; r++)
            {
                if (r > 0)
                {
                    flat.Append('\n');
                }
                var cellLines = new List<List<Fragment>>[columns];
                var x = 0;
                for (var c = 0; c < columns; c++)
                {
                    if (c > 0)
                    {
                        flat.Append('\t');
                    }
                    cellLines[c] = Wrap(CellRuns(rows[r][c], r == 0), null, x + CellPad, Math.Max(8, widths[c] - CellPad * 2), 0);
                    x += widths[c];
                }
                var lineCount = Math.Max(1, cellLines.Max(l => l.Count));
                var rowHeight = lineCount * (bodyFont.Height + 2) + CellPad;
                x = 0;
                for (var c = 0; c < columns; c++)
                {
                    message.Cells.Add((new Rectangle(x, y, widths[c], rowHeight), r == 0));
                    x += widths[c];
                }
                for (var k = 0; k < lineCount; k++)
                {
                    // One visual line across every cell, left to right.
                    var fragments = cellLines.Where(l => k < l.Count).SelectMany(l => l[k]).ToList();
                    if (fragments.Count > 0)
                    {
                        lines.Add(new Line(y + CellPad / 2 + k * (bodyFont.Height + 2), bodyFont.Height, false, fragments));
                    }
                }
                widest = Math.Max(widest, x);
                y += rowHeight;
            }
            y += 2;
        }

        // Word-wraps runs into lines of fragments `width` wide, starting at
        // x = left; continuation lines start `indent` further in.
        List<List<Fragment>> Wrap(IEnumerable<MarkdownRun> runs, Font? onlyFont, int left, int width, int indent)
        {
            var result = new List<List<Fragment>>();
            var line = new List<Fragment>();
            var x = 0;
            void EndLine()
            {
                result.Add(line);
                line = new List<Fragment>();
                x = indent;
            }
            foreach (var run in runs)
            {
                var font = onlyFont ?? FontFor(run);
                foreach (Match word in WordPattern.Matches(run.Text))
                {
                    var text = word.Value;
                    var w = Measure(text, font);
                    if (x + w > width && x > indent)
                    {
                        EndLine();
                        text = text.TrimStart();
                        if (text.Length == 0)
                        {
                            continue;
                        }
                        w = Measure(text, font);
                    }
                    if (w > width - indent)
                    {
                        foreach (var piece in BreakToWidth(text, s => Measure(s, font), width - indent))
                        {
                            if (x > indent)
                            {
                                EndLine();
                            }
                            var pw = Measure(piece, font);
                            line.Add(new Fragment(piece, font, left + x, pw, run.Code, flat.Length, run.Link));
                            flat.Append(piece);
                            x += pw;
                        }
                        continue;
                    }
                    line.Add(new Fragment(text, font, left + x, w, run.Code, flat.Length, run.Link));
                    flat.Append(text);
                    x += w;
                }
            }
            if (line.Count > 0)
            {
                EndLine();
            }
            return result;
        }
        message.ActionBounds.Clear();
        message.NoteBounds = Rectangle.Empty;
        if (message.Actions.Count > 0 || message.Note is not null)
        {
            y += 8;
            var x = 0;
            foreach (var action in message.Actions)
            {
                var w = Measure(action.Label, bodyFont) + 28 + (action.Menu is null ? 0 : MenuArrowWidth);
                message.ActionBounds.Add(new Rectangle(x, y, w, ActionHeight));
                x += w + 8;
            }
            if (message.Actions.Count > 0)
            {
                widest = Math.Max(widest, x - 8);
                y += ActionHeight + 2;
            }
            if (message.Note is not null)
            {
                var w = Math.Min(maxWidth, Measure(message.Note, bodyFont));
                message.NoteBounds = new Rectangle(0, y, w, bodyFont.Height);
                widest = Math.Max(widest, w);
                y += bodyFont.Height + 2;
            }
        }
        message.Lines = lines;
        message.Text = flat.ToString();
        message.ContentWidth = Math.Min(maxWidth, Math.Max(widest, 1));
        message.ContentHeight = Math.Max(y - 2, bodyFont.Height);
        message.LaidOutWidth = maxWidth;
    }

    private Font FontFor(MarkdownRun run)
    {
        if (run.Code)
        {
            return codeFont;
        }
        var style = (run.Bold ? FontStyle.Bold : 0) | (run.Italic ? FontStyle.Italic : 0)
                    | (run.Strike ? FontStyle.Strikeout : 0) | (run.Link is not null ? FontStyle.Underline : 0);
        if (style == FontStyle.Regular)
        {
            return bodyFont;
        }
        if (!styledFonts.TryGetValue(style, out var font))
        {
            styledFonts[style] = font = new Font(bodyFont, style);
        }
        return font;
    }

    private static int Measure(string text, Font font) =>
        TextRenderer.MeasureText(text, font, new Size(int.MaxValue, int.MaxValue), TextFlags).Width;

    // Splits text too long for one line into the longest pieces that fit.
    // #1147: only between text elements (grapheme clusters), so an emoji ZWJ
    // sequence, a flag, a surrogate pair or a letter with its combining
    // accent is never cut in half; one element wider than the line gets a
    // line to itself.
    internal static IEnumerable<string> BreakToWidth(string text, Func<string, int> measure, int maxWidth)
    {
        var starts = StringInfo.ParseCombiningCharacters(text);
        var first = 0; // index into starts
        string Piece(int count) =>
            text[starts[first]..(first + count < starts.Length ? starts[first + count] : text.Length)];
        while (first < starts.Length)
        {
            var count = starts.Length - first;
            while (count > 1 && measure(Piece(count)) > maxWidth)
            {
                count = Math.Max(1, Math.Min(count - 1, count * 3 / 4)); // shrink fast, then grow back below
            }
            while (first + count < starts.Length && measure(Piece(count + 1)) <= maxWidth)
            {
                count++;
            }
            yield return Piece(count);
            first += count;
        }
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        Relayout(forceScroll: false); // bubble widths and the scroll range both follow the size
    }

    // ---- Painting -------------------------------------------------------

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (DarkTheme.IsGlass && FindForm() is { } form)
        {
            (Size Size, Point Offset, Size Window, int Theme) key = (ClientSize, form.PointToClient(PointToScreen(Point.Empty)), form.ClientSize, DarkTheme.Version);
            if (glow is null || key != glowKey)
            {
                glow?.Dispose();
                glow = GlassSurface.RenderGlow(key.Size, key.Offset, key.Window);
                glowKey = key;
            }
            e.Graphics.DrawImageUnscaled(glow, 0, 0);
            return;
        }
        using var brush = new SolidBrush(DarkTheme.Background);
        e.Graphics.FillRectangle(brush, ClientRectangle);
    }

    // A new chat's card: how to start, and a few things she can do.
    internal const string EmptyStateText = "Say \"Mana\" or type below to start.\n\n"
        + "A few things she can do:\n"
        + "•  chat, and answer questions\n"
        + "•  look at your screen (\"what's this?\", \"translate my screen\")\n"
        + "•  look things up and research a topic\n"
        + "•  remember what you tell her about yourself";

    private void PaintEmptyState(Graphics g)
    {
        const TextFormatFlags flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix;
        var width = Math.Min(420, ClientSize.Width - 48);
        if (width <= 0)
        {
            return;
        }
        var text = TextRenderer.MeasureText(g, EmptyStateText, bodyFont, new Size(width - (PadX * 2), int.MaxValue), flags);
        var card = new Rectangle((ClientSize.Width - width) / 2, Math.Max(24, (ClientSize.Height - text.Height) / 3), width, text.Height + (PadY * 2));
        using (var fill = new SolidBrush(DarkTheme.ManaBubble))
        {
            g.FillRectangle(fill, card);
        }
        using (var border = new Pen(DarkTheme.Border))
        {
            g.DrawRectangle(border, card.X, card.Y, card.Width - 1, card.Height - 1);
        }
        TextRenderer.DrawText(g, EmptyStateText, bodyFont, Rectangle.Inflate(card, -PadX, -PadY), DarkTheme.Text, flags);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        if (messages.Count == 0)
        {
            PaintEmptyState(g);
        }
        var scroll = scrolling ? scrollBar.Value : 0;
        for (var i = 0; i < messages.Count; i++)
        {
            var message = messages[i];
            var bubble = message.Bounds with { Y = message.Bounds.Y - scroll };
            if (bubble.Bottom < 0 || bubble.Y - labelFont.Height > ClientSize.Height)
            {
                continue;
            }
            if (message.Steps is not null)
            {
                PaintStepLine(g, message, new Point(bubble.X + PadX, bubble.Y + PadY));
                continue;
            }
            var label = message.LabelBounds with { Y = message.LabelBounds.Y - scroll };
            TextRenderer.DrawText(g, message.Speaker, labelFont, label, DarkTheme.Muted,
                TextFlags | (message.FromUser ? TextFormatFlags.Right : TextFormatFlags.Left));

            var fill = message.FromUser ? DarkTheme.UserBubble : DarkTheme.ManaBubble;
            if (DarkTheme.IsGlass)
            {
                using var glass = new SolidBrush(Color.FromArgb(175, fill));
                g.FillRectangle(glass, bubble);
                GlassSurface.PaintGlassEdges(g, bubble, message.FromUser ? null : GlassSurface.SheenProgress(this)); // #652: her bubbles shimmer
            }
            else
            {
                using var solid = new SolidBrush(fill);
                g.FillRectangle(solid, bubble);
                using var border = new Pen(DarkTheme.Border);
                g.DrawRectangle(border, bubble.X, bubble.Y, bubble.Width - 1, bubble.Height - 1);
            }

            var origin = new Point(bubble.X + PadX, bubble.Y + PadY);
            for (var k = 0; k < message.Images.Count; k++)
            {
                var rect = message.ImageBounds[k];
                g.DrawImage(message.Images[k], rect with { X = rect.X + origin.X, Y = rect.Y + origin.Y });
            }
            if (message.Cells.Count > 0)
            {
                using var headerBack = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 110 : 60, DarkTheme.IsLight ? Color.White : Color.Black));
                using var grid = new Pen(DarkTheme.Border);
                foreach (var (cell, header) in message.Cells)
                {
                    var rect = cell with { X = cell.X + origin.X, Y = cell.Y + origin.Y };
                    if (header)
                    {
                        g.FillRectangle(headerBack, rect);
                    }
                    g.DrawRectangle(grid, rect);
                }
            }
            foreach (var line in message.Lines)
            {
                if (line.Code)
                {
                    using var codeBack = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 110 : 60, DarkTheme.IsLight ? Color.White : Color.Black));
                    g.FillRectangle(codeBack, origin.X, origin.Y + line.Y - 1, message.ContentWidth, line.Height);
                }
                if (line.Quote)
                {
                    using var bar = new SolidBrush(Color.FromArgb(160, DarkTheme.Accent));
                    g.FillRectangle(bar, origin.X, origin.Y + line.Y - 1, 3, line.Height + 2);
                }
                foreach (var fragment in line.Fragments)
                {
                    PaintSelection(g, i, fragment, origin.X, origin.Y + line.Y - 1, line.Height);
                    // Centred on the line, so a smaller code-font span sits level with the words around it.
                    var y = origin.Y + line.Y + (line.Height - fragment.Font.Height) / 2;
                    TextRenderer.DrawText(g, fragment.Text, fragment.Font, new Point(origin.X + fragment.X, y),
                        fragment.IsCode ? DarkTheme.CodeText : fragment.Link is not null ? DarkTheme.Accent : DarkTheme.Text, TextFlags);
                }
            }

            PaintActions(g, message, origin);

            if (i == selected)
            {
                using var ring = new Pen(DarkTheme.Accent, 2);
                g.DrawRectangle(ring, bubble.X + 1, bubble.Y + 1, bubble.Width - 3, bubble.Height - 3);
            }
        }
    }

    // #1318: a step-group line: grey text straight on the chat background,
    // its command/result blocks on the usual code shading.
    private void PaintStepLine(Graphics g, Message message, Point origin)
    {
        foreach (var line in message.Lines)
        {
            if (line.Code)
            {
                using var codeBack = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 110 : 60, DarkTheme.IsLight ? Color.White : Color.Black));
                g.FillRectangle(codeBack, origin.X, origin.Y + line.Y - 1, message.ContentWidth, line.Height);
            }
            foreach (var fragment in line.Fragments)
            {
                var y = origin.Y + line.Y + (line.Height - fragment.Font.Height) / 2;
                TextRenderer.DrawText(g, fragment.Text, fragment.Font, new Point(origin.X + fragment.X, y),
                    fragment.IsCode ? DarkTheme.Text : StepColor(fragment.Text), TextFlags);
            }
        }
    }

    // ---- Input ----------------------------------------------------------

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        Focus();
        if (e.Button == MouseButtons.Left && ActionAt(e.Location) is var (actionMsg, actionIndex, actionRect))
        {
            if (messages[actionMsg].Actions[actionIndex].Menu is not null && e.X >= actionRect.Right - MenuArrowWidth)
            {
                ShowActionMenu(actionMsg, actionIndex, new Point(actionRect.Right - MenuArrowWidth, actionRect.Bottom));
            }
            else
            {
                _ = RunActionAsync(actionMsg, actionIndex);
            }
            return;
        }
        // #1318: clicking a step line opens or closes its steps.
        if (e.Button == MouseButtons.Left && HitTest(e.Location) is var stepHit and >= 0 && messages[stepHit].Steps is not null)
        {
            messages[stepHit].StepsOpen = !messages[stepHit].StepsOpen;
            SetStepBlocks(messages[stepHit], DateTimeOffset.UtcNow);
            Relayout(forceScroll: false);
            return;
        }
        if (e.Button == MouseButtons.Left)
        {
            pressPoint = e.Location;
            pressed = true;
            dragSelecting = false;
            ClearTextSelection();
        }
        // A right-click keeps a text selection so its menu can copy it.
        var keepText = e.Button == MouseButtons.Right && HasTextSelection;
        var hit = HitTest(e.Location);
        if (!keepText && hit != selected && (hit >= 0 || e.Button == MouseButtons.Left))
        {
            Select(hit);
        }
    }

    // A press that moves a few pixels becomes a text drag-selection, which
    // can run within one bubble or across several.
    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var link = LinkAt(e.Location);
        if (link != hoveredLink)
        {
            hoveredLink = link;
            linkTip.SetToolTip(this, link); // shows where a link really goes before it's clicked
        }
        Cursor = ActionAt(e.Location) is not null || link is not null ? Cursors.Hand
            : HitTest(e.Location) >= 0 ? Cursors.IBeam : Cursors.Default;
        if (!pressed || (e.Button & MouseButtons.Left) == 0 || messages.Count == 0)
        {
            return;
        }
        if (!dragSelecting)
        {
            if (Math.Abs(e.X - pressPoint.X) + Math.Abs(e.Y - pressPoint.Y) < 4)
            {
                return;
            }
            dragSelecting = true;
            anchor = TextPositionAt(pressPoint);
            selected = -1;
        }
        // ponytail: only scrolls while the mouse keeps moving past an edge; add a
        // timer if holding still outside the pane should keep scrolling.
        if (scrolling && (e.Y < 0 || e.Y > ClientSize.Height))
        {
            scrollBar.Value = Math.Clamp(scrollBar.Value + (e.Y < 0 ? -20 : 20), 0, MaxScroll());
        }
        caret = TextPositionAt(e.Location);
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        // A click (not the end of a drag-selection) on a link opens it.
        if (e.Button == MouseButtons.Left && pressed && !dragSelecting && LinkAt(e.Location) is { } link)
        {
            OpenLink(link);
        }
        pressed = false;
        dragSelecting = false;
    }

    // The link URL under `point`, or null.
    internal string? LinkAt(Point point)
    {
        var index = HitTest(point);
        if (index < 0)
        {
            return null;
        }
        var m = messages[index];
        var x = point.X - m.Bounds.X - PadX;
        var y = point.Y + (scrolling ? scrollBar.Value : 0) - m.Bounds.Y - PadY;
        foreach (var line in m.Lines)
        {
            if (y < line.Y || y >= line.Y + line.Height)
            {
                continue;
            }
            foreach (var fragment in line.Fragments)
            {
                if (fragment.Link is not null && x >= fragment.X && x < fragment.X + fragment.Width)
                {
                    return fragment.Link;
                }
            }
        }
        return null;
    }

    // Opens web and mail links only -- the reply is model text, possibly
    // echoing web content, so no file:, ms-settings: or other handlers.
    internal static bool IsSafeLink(string link) =>
        Uri.TryCreate(link, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto";

    private static void OpenLink(string link)
    {
        if (!IsSafeLink(link))
        {
            return;
        }
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(new Uri(link).AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"ChatView: couldn't open {link}: {ex.Message}");
        }
    }

    // ---- Text selection -------------------------------------------------

    internal bool HasTextSelection => anchor is { } a && caret is { } c && Compare(a, c) != 0;

    internal void SelectText((int Msg, int Offset) from, (int Msg, int Offset) to)
    {
        anchor = from;
        caret = to;
        selected = -1;
        Invalidate();
    }

    private void ClearTextSelection()
    {
        if (anchor is not null || caret is not null)
        {
            anchor = caret = null;
            Invalidate();
        }
    }

    private static int Compare((int Msg, int Offset) a, (int Msg, int Offset) b) =>
        a.Msg != b.Msg ? a.Msg.CompareTo(b.Msg) : a.Offset.CompareTo(b.Offset);

    // The selected range within message `index`, as [from, to) offsets, or null.
    private (int From, int To)? SelectionIn(int index)
    {
        if (!HasTextSelection)
        {
            return null;
        }
        var (start, end) = Compare(anchor!.Value, caret!.Value) <= 0 ? (anchor.Value, caret.Value) : (caret.Value, anchor.Value);
        if (index < start.Msg || index > end.Msg)
        {
            return null;
        }
        return (index == start.Msg ? start.Offset : 0, index == end.Msg ? end.Offset : messages[index].Text.Length);
    }

    // Selected text; spans across bubbles are separated by a blank line.
    internal string SelectedText()
    {
        var parts = new List<string>();
        for (var i = 0; i < messages.Count; i++)
        {
            if (SelectionIn(i) is var (from, to))
            {
                var text = messages[i].Text;
                from = Math.Clamp(from, 0, text.Length);
                to = Math.Clamp(to, from, text.Length);
                parts.Add(text[from..to]);
            }
        }
        return string.Join(Environment.NewLine + Environment.NewLine, parts);
    }

    // Maps a point in the pane to the nearest (message, character offset).
    internal (int Msg, int Offset) TextPositionAt(Point point)
    {
        var y = point.Y + (scrolling ? scrollBar.Value : 0);
        for (var i = 0; i < messages.Count; i++)
        {
            var m = messages[i];
            if (y < m.Bounds.Top)
            {
                return (i, 0);
            }
            if (y <= m.Bounds.Bottom)
            {
                return (i, OffsetInMessage(m, point.X - m.Bounds.X - PadX, y - m.Bounds.Y - PadY));
            }
        }
        var last = messages.Count - 1;
        return (last, messages[last].Text.Length);
    }

    private static int OffsetInMessage(Message m, int x, int y)
    {
        if (m.Lines.Count == 0)
        {
            return 0;
        }
        var line = m.Lines[0];
        foreach (var candidate in m.Lines)
        {
            if (candidate.Y <= y)
            {
                line = candidate;
            }
        }
        var first = line.Fragments[0];
        var lastFragment = line.Fragments[^1];
        if (x <= first.X)
        {
            return first.Start;
        }
        foreach (var fragment in line.Fragments)
        {
            if (x < fragment.X + fragment.Width)
            {
                return fragment.Start + CharIndexAt(fragment, x - fragment.X);
            }
        }
        return lastFragment.Start + lastFragment.Text.Length;
    }

    // The character boundary in the fragment nearest to x.
    private static int CharIndexAt(Fragment fragment, int x)
    {
        var previous = 0;
        for (var k = 1; k <= fragment.Text.Length; k++)
        {
            var width = Measure(fragment.Text[..k], fragment.Font);
            if (width >= x)
            {
                return width - x < x - previous ? k : k - 1;
            }
            previous = width;
        }
        return fragment.Text.Length;
    }

    private void PaintActions(Graphics g, Message message, Point origin)
    {
        for (var a = 0; a < message.Actions.Count; a++)
        {
            var action = message.Actions[a];
            var rect = message.ActionBounds[a];
            rect.Offset(origin);
            var faded = message.ActionRunning;
            if (action.Primary)
            {
                using var fill = new SolidBrush(faded ? Color.FromArgb(140, DarkTheme.Accent) : DarkTheme.Accent);
                g.FillRectangle(fill, rect);
                TextRenderer.DrawText(g, action.Label, bodyFont, rect, DarkTheme.OnAccent,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            }
            else
            {
                using var fill = new SolidBrush(DarkTheme.IsGlass ? Color.FromArgb(190, 255, 255, 255) : DarkTheme.Panel2);
                g.FillRectangle(fill, rect);
                using var border = new Pen(DarkTheme.Border);
                g.DrawRectangle(border, rect.X, rect.Y, rect.Width - 1, rect.Height - 1);
                var labelRect = action.Menu is null ? rect : new Rectangle(rect.X, rect.Y, rect.Width - MenuArrowWidth, rect.Height);
                TextRenderer.DrawText(g, action.Label, bodyFont, labelRect, faded ? DarkTheme.Muted : DarkTheme.Text,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                if (action.Menu is not null)
                {
                    var arrow = new Rectangle(rect.Right - MenuArrowWidth, rect.Y, MenuArrowWidth, rect.Height);
                    g.DrawLine(border, arrow.X, rect.Y + 5, arrow.X, rect.Bottom - 6);
                    TextRenderer.DrawText(g, "\u25BE", bodyFont, arrow, faded ? DarkTheme.Muted : DarkTheme.Text,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                }
            }
        }
        if (message.Note is not null)
        {
            var rect = message.NoteBounds;
            rect.Offset(origin);
            TextRenderer.DrawText(g, message.Note, bodyFont, rect, DarkTheme.Muted, TextFlags | TextFormatFlags.EndEllipsis);
        }
    }

    // The action button under `point`, as (message, button index), or null.
    private (int Msg, int Action, Rectangle Rect)? ActionAt(Point point)
    {
        var scroll = scrolling ? scrollBar.Value : 0;
        for (var i = 0; i < messages.Count; i++)
        {
            var m = messages[i];
            for (var a = 0; a < m.ActionBounds.Count; a++)
            {
                var rect = m.ActionBounds[a];
                rect.Offset(m.Bounds.X + PadX, m.Bounds.Y + PadY - scroll);
                if (rect.Contains(point))
                {
                    return (i, a, rect);
                }
            }
        }
        return null;
    }

    // A split button's dropdown, under its arrow (or the button, from the keyboard).
    private void ShowActionMenu(int index, int actionIndex, Point at)
    {
        var message = messages[index];
        if (message.ActionRunning || message.Actions[actionIndex].Menu is not { } items)
        {
            return;
        }
        var menu = new ContextMenuStrip();
        foreach (var item in items)
        {
            menu.Items.Add(new ToolStripMenuItem(item.Label, null, (_, _) => _ = RunMenuItemAsync(message, item)) { Enabled = item.Enabled });
        }
        menu.Closed += (_, _) => BeginInvoke(menu.Dispose); // after the clicked item's handler
        menu.Show(this, at);
    }

    private async Task RunMenuItemAsync(Message message, ChatMenuItem item)
    {
        try
        {
            await item.Run();
        }
        catch (Exception ex)
        {
            message.Note = $"Couldn't do that: {ex.Message}";
            message.Invalidate();
            Relayout(forceScroll: false);
        }
    }

    // Runs a button's action; a returned note replaces the buttons (e.g. "Approved").
    internal async Task RunActionAsync(int index, int actionIndex)
    {
        var message = messages[index];
        if (message.ActionRunning || actionIndex >= message.Actions.Count)
        {
            return;
        }
        message.ActionRunning = true;
        Invalidate();
        string? note;
        try
        {
            note = await message.Actions[actionIndex].Run();
        }
        catch (Exception ex)
        {
            note = $"Couldn't do that: {ex.Message}";
        }
        if (IsDisposed)
        {
            return;
        }
        message.ActionRunning = false;
        if (note is not null)
        {
            message.Actions.RemoveAll(a => !a.Keep);
            message.Note = note;
            message.Invalidate();
            Relayout(forceScroll: false);
        }
        Invalidate();
    }

    private void PaintSelection(Graphics g, int index, Fragment fragment, int originX, int lineTop, int lineHeight)
    {
        if (SelectionIn(index) is not var (from, to))
        {
            return;
        }
        var a = Math.Max(from, fragment.Start);
        var b = Math.Min(to, fragment.Start + fragment.Text.Length);
        if (a >= b)
        {
            return;
        }
        var x1 = a == fragment.Start ? 0 : Measure(fragment.Text[..(a - fragment.Start)], fragment.Font);
        var x2 = Measure(fragment.Text[..(b - fragment.Start)], fragment.Font);
        using var highlight = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 90 : 120, DarkTheme.Accent));
        g.FillRectangle(highlight, originX + fragment.X + x1, lineTop, Math.Max(1, x2 - x1), lineHeight);
    }

    internal int HitTest(Point point)
    {
        var scroll = scrolling ? scrollBar.Value : 0;
        for (var i = 0; i < messages.Count; i++)
        {
            if (messages[i].Bounds.Contains(point.X, point.Y + scroll))
            {
                return i;
            }
        }
        return -1;
    }

    // #701: a clicked chat bubble -- selects (and scrolls to) Mana's latest
    // message containing that sentence, else her latest message.
    public void SelectMessageContaining(string sentence)
    {
        var index = LatestManaMessage(sentence);
        if (index >= 0)
        {
            Select(index);
        }
    }

    // -1 when Mana has no messages.
    internal int LatestManaMessage(string sentence)
    {
        var mana = Enumerable.Range(0, messages.Count).Reverse().Where(i => !messages[i].FromUser).ToList();
        return mana.Count == 0
            ? -1
            : mana.FirstOrDefault(i => messages[i].PlainText.Contains(sentence.Trim(), StringComparison.OrdinalIgnoreCase), mana[0]);
    }

    private void Select(int index)
    {
        selected = index;
        if (index >= 0)
        {
            ScrollIntoView(messages[index].Bounds);
            AccessibilityNotifyClients(AccessibleEvents.Focus, index);
            AccessibilityNotifyClients(AccessibleEvents.Selection, index);
        }
        Invalidate();
    }

    private void ScrollIntoView(Rectangle bounds)
    {
        if (!scrolling)
        {
            return;
        }
        if (bounds.Y - labelFont.Height < scrollBar.Value)
        {
            scrollBar.Value = Math.Max(0, bounds.Y - labelFont.Height - PadY);
        }
        else if (bounds.Bottom > scrollBar.Value + ClientSize.Height)
        {
            scrollBar.Value = Math.Min(MaxScroll(), bounds.Bottom - ClientSize.Height + PadY);
        }
    }

    protected override bool IsInputKey(Keys keyData) =>
        keyData is Keys.Up or Keys.Down or Keys.Home or Keys.End or Keys.Escape or Keys.Enter or (Keys.Alt | Keys.Down) || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (messages.Count == 0)
        {
            return;
        }
        switch (e.KeyData)
        {
            case Keys.Control | Keys.C:
                CopySelected();
                e.Handled = true;
                break;
            case Keys.Control | Keys.A:
                SelectText((0, 0), (messages.Count - 1, messages[^1].Text.Length));
                e.Handled = true;
                break;
            case Keys.Escape:
                ClearTextSelection();
                e.Handled = true;
                break;
            case Keys.Alt | Keys.Down when selected >= 0 && messages[selected].Actions.FindIndex(a => a.Menu is not null) is var menuAt and >= 0:
            {
                var rect = messages[selected].ActionBounds[menuAt];
                rect.Offset(messages[selected].Bounds.X + PadX, messages[selected].Bounds.Y + PadY - (scrolling ? scrollBar.Value : 0));
                ShowActionMenu(selected, menuAt, new Point(rect.X, rect.Bottom));
                e.Handled = true;
                break;
            }
            case Keys.Enter when selected >= 0 && messages[selected].Actions.Count > 0:
                _ = RunActionAsync(selected, 0);
                e.Handled = true;
                break;
            case Keys.Up:
                Select(selected <= 0 ? 0 : selected - 1);
                e.Handled = true;
                break;
            case Keys.Down:
                Select(selected < 0 ? messages.Count - 1 : Math.Min(messages.Count - 1, selected + 1));
                e.Handled = true;
                break;
            case Keys.Home:
                Select(0);
                e.Handled = true;
                break;
            case Keys.End:
                Select(messages.Count - 1);
                e.Handled = true;
                break;
        }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (scrolling)
        {
            scrollBar.Value = Math.Clamp(scrollBar.Value - e.Delta / 120 * 3 * scrollBar.SmallChange / 2, 0, MaxScroll());
        }
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        Invalidate();
    }

    // ---- Accessibility --------------------------------------------------

    protected override AccessibleObject CreateAccessibilityInstance() => new ChatAccessibleObject(this);

    private sealed class ChatAccessibleObject : ControlAccessibleObject
    {
        private readonly ChatView view;

        public ChatAccessibleObject(ChatView view) : base(view) => this.view = view;

        public override AccessibleRole Role => AccessibleRole.List;
        public override int GetChildCount() => view.messages.Count;
        public override AccessibleObject? GetChild(int index) =>
            index >= 0 && index < view.messages.Count ? new MessageAccessibleObject(view, index) : null;
        public override AccessibleObject? GetFocused() =>
            view.selected >= 0 ? GetChild(view.selected) : base.GetFocused();
        public override AccessibleObject? GetSelected() => GetFocused();
    }

    private sealed class MessageAccessibleObject : AccessibleObject
    {
        private readonly ChatView view;
        private readonly int index;

        public MessageAccessibleObject(ChatView view, int index)
        {
            this.view = view;
            this.index = index;
        }

        public override string Name => $"{view.messages[index].Speaker}: {view.messages[index].PlainText}";
        public override AccessibleRole Role => AccessibleRole.ListItem;
        public override AccessibleObject Parent => view.AccessibilityObject;
        public override AccessibleStates State =>
            AccessibleStates.Selectable | AccessibleStates.Focusable | AccessibleStates.ReadOnly
            | (view.selected == index ? AccessibleStates.Selected | AccessibleStates.Focused : AccessibleStates.None);
        public override Rectangle Bounds
        {
            get
            {
                var scroll = view.scrolling ? view.scrollBar.Value : 0;
                var b = view.messages[index].Bounds;
                return view.RectangleToScreen(b with { Y = b.Y - scroll });
            }
        }
        public override void Select(AccessibleSelection flags) => view.Select(index);
        public override void DoDefaultAction() => view.Select(index);
        public override int GetChildCount() => view.messages[index].Actions.Count;
        public override AccessibleObject? GetChild(int child) =>
            child >= 0 && child < view.messages[index].Actions.Count ? new ActionAccessibleObject(view, this, index, child) : null;
    }

    private sealed class ActionAccessibleObject : AccessibleObject
    {
        private readonly ChatView view;
        private readonly AccessibleObject parent;
        private readonly int index;
        private readonly int action;

        public ActionAccessibleObject(ChatView view, AccessibleObject parent, int index, int action)
        {
            this.view = view;
            this.parent = parent;
            this.index = index;
            this.action = action;
        }

        public override string Name => view.messages[index].Actions[action].Label;
        public override AccessibleRole Role => AccessibleRole.PushButton;
        public override AccessibleObject Parent => parent;
        public override string DefaultAction => "Press";
        public override void DoDefaultAction() => _ = view.RunActionAsync(index, action);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            bodyFont.Dispose();
            foreach (var font in styledFonts.Values)
            {
                font.Dispose();
            }
            headerFont.Dispose();
            codeFont.Dispose();
            labelFont.Dispose();
            linkTip.Dispose();
            glow?.Dispose();
            ContextMenuStrip?.Dispose();
            foreach (var image in messages.SelectMany(m => m.Images))
            {
                image.Dispose();
            }
        }
        base.Dispose(disposing);
    }

    // ---- Model ----------------------------------------------------------

    internal sealed class Message
    {
        public Message(bool fromUser) => FromUser = fromUser;

        public bool FromUser { get; }
        // #914: the character's name on her messages (null: Mana).
        public string? Name { get; init; }
        public string Speaker => FromUser ? "You" : Name ?? "Mana";
        public List<MarkdownBlock> Blocks { get; } = new();
        public List<Line> Lines { get; set; } = new();
        public string Text { get; set; } = "";
        public int LaidOutWidth { get; set; } = -1;
        public int ContentWidth { get; set; }
        public int ContentHeight { get; set; }
        public Rectangle Bounds { get; set; }
        public Rectangle LabelBounds { get; set; }
        public List<ChatAction> Actions { get; } = new();
        public List<Rectangle> ActionBounds { get; } = new();
        public string? Note { get; set; }
        public Rectangle NoteBounds { get; set; }
        public bool ActionRunning { get; set; }
        public List<(Rectangle Bounds, bool Header)> Cells { get; } = new(); // table cells, in content coordinates
        public List<Bitmap> Images { get; } = new(); // #679: thumbnails of a user message's images
        public List<Rectangle> ImageBounds { get; } = new(); // in content coordinates

        // The full reply text once VoiceLoop reported it; later sentences start a new bubble.
        public string? FinalText { get; set; }

        // #1318: set on a grey step-group line (no bubble, no label) placed
        // after the reply text of its segment; clicking it toggles StepsOpen.
        public StepGroup? Steps { get; set; }
        public bool StepsOpen { get; set; }

        public void Invalidate() => LaidOutWidth = -1;

        public string PlainText
        {
            get
            {
                var text = new StringBuilder();
                if (Images.Count > 0)
                {
                    text.Append(Images.Count == 1 ? "[image]" : $"[{Images.Count} images]");
                }
                foreach (var block in Blocks)
                {
                    if (text.Length > 0)
                    {
                        text.AppendLine();
                    }
                    if (block.Type == MarkdownBlockType.BulletItem)
                    {
                        text.Append("• ");
                    }
                    if (block.Rows is { } rows)
                    {
                        text.AppendJoin(Environment.NewLine,
                            rows.Select(row => string.Join("\t", row.Select(cell => string.Concat(cell.Select(r => r.Text))))));
                    }
                    foreach (var run in block.Runs)
                    {
                        text.Append(run.Text);
                    }
                }
                return text.ToString();
            }
        }
    }

    internal sealed record Line(int Y, int Height, bool Code, List<Fragment> Fragments, bool Quote = false);

    // A button under one of Mana's messages. Run returns a note to show in
    // place of the buttons once it's done, or null to keep them. Keep: stays
    // when a note or a new set of buttons replaces the others.
    // Menu makes it a split button: its arrow part lists these (Alt+Down from the keyboard).
    internal sealed record ChatAction(string Label, bool Primary, Func<Task<string?>> Run, bool Keep = false,
        IReadOnlyList<ChatMenuItem>? Menu = null);

    internal sealed record ChatMenuItem(string Label, bool Enabled, Func<Task<string?>> Run);

    // Start: offset of Text within the message's Text. Link: its URL, if it's part of a link.
    internal sealed record Fragment(string Text, Font Font, int X, int Width, bool IsCode, int Start, string? Link = null);
}
